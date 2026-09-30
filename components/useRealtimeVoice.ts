"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* "Plný rozhovor": a speech-to-speech call with OpenAI Realtime over WebRTC.
 * /api/realtime/session mints a short-lived client secret (the API key stays
 * on the server); the browser posts its SDP offer to /v1/realtime/calls,
 * plays the remote audio track and talks JSON events over the "oai-events"
 * data channel. Whenever the model calls ask_apex, the caller runs a normal
 * Apex turn and the result goes back as function_call_output + response.create.
 * Cost guard: the call hangs up after SILENCE_MS without any speech. */

export type RealtimePhase = "off" | "connecting" | "listening" | "user" | "thinking" | "speaking";
export type RealtimeEnd = "user" | "silence" | "error";

export type RealtimeCallbacks = {
  onUserTranscript: (text: string) => void;
  onAssistantDelta: (textSoFar: string) => void;
  onAssistantTranscript: (text: string) => void;
  /* Runs an Apex turn; resolves to the function_call_output string. */
  onAskApex: (request: string, signal: AbortSignal) => Promise<string>;
  onPhase: (phase: RealtimePhase) => void;
  onError: (message: string) => void;
  onEnded: (reason: RealtimeEnd) => void;
};

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
export const SILENCE_MS = 3 * 60_000;

type ServerEvent = {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
  response?: {
    status?: string;
    status_details?: { error?: { message?: string } };
    output?: { type?: string; call_id?: string; name?: string; arguments?: string }[];
  };
};

export function useRealtimeVoice(callbacks: RealtimeCallbacks) {
  const cb = useRef(callbacks);
  cb.current = callbacks;
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const session = useRef(0);             // bumps on start/stop; stale async steps compare against it
  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const silence = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asks = useRef(new Set<AbortController>());
  const handledCalls = useRef(new Set<string>());
  const assistantBuf = useRef(new Map<string, string>());
  const outputMuted = useRef(false);
  const phase = useRef<RealtimePhase>("off");

  const setPhase = useCallback((p: RealtimePhase) => {
    phase.current = p;
    cb.current.onPhase(p);
  }, []);

  const teardown = useCallback(() => {
    session.current++;
    if (silence.current) { clearTimeout(silence.current); silence.current = null; }
    for (const a of asks.current) a.abort();
    asks.current.clear();
    handledCalls.current.clear();
    assistantBuf.current.clear();
    try { dc.current?.close(); } catch { /* closed */ }
    dc.current = null;
    if (pc.current) {
      for (const s of pc.current.getSenders()) { try { s.track?.stop(); } catch { /* stopped */ } }
      try { pc.current.close(); } catch { /* closed */ }
      pc.current = null;
    }
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
    if (audioEl.current) {
      audioEl.current.pause();
      audioEl.current.srcObject = null;
      audioEl.current = null;
    }
    setActive(false);
    setConnecting(false);
    setStartedAt(null);
  }, []);

  const stop = useCallback((reason: RealtimeEnd = "user") => {
    const wasOn = phase.current !== "off";
    teardown();
    if (wasOn) {
      setPhase("off");
      cb.current.onEnded(reason);
    }
  }, [teardown, setPhase]);

  const armSilence = useCallback(() => {
    if (silence.current) clearTimeout(silence.current);
    const sid = session.current;
    silence.current = setTimeout(() => {
      silence.current = null;
      if (sid !== session.current) return;
      // Apex is still working on an answer - that is not silence.
      if (asks.current.size) { armSilence(); return; }
      stop("silence");
    }, SILENCE_MS);
  }, [stop]);

  const sendEvent = useCallback((ev: Record<string, unknown>) => {
    const ch = dc.current;
    if (ch && ch.readyState === "open") ch.send(JSON.stringify(ev));
  }, []);

  const handleCall = useCallback(async (callId: string | undefined, name: string | undefined, args: string | undefined) => {
    if (!callId || handledCalls.current.has(callId)) return;
    handledCalls.current.add(callId);
    const sid = session.current;
    let output: string;
    if (name !== "ask_apex") {
      output = JSON.stringify({ ok: false, error: `Neznámý nástroj ${name ?? ""}` });
    } else {
      let request = "";
      try { request = String((JSON.parse(args || "{}") as { request?: unknown }).request ?? "").trim(); } catch { /* bad JSON */ }
      if (!request) {
        output = JSON.stringify({ ok: false, error: "Chybí požadavek (request)." });
      } else {
        const ctrl = new AbortController();
        asks.current.add(ctrl);
        setPhase("thinking");
        try {
          output = await cb.current.onAskApex(request, ctrl.signal);
        } catch (e) {
          output = JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          asks.current.delete(ctrl);
        }
      }
    }
    if (sid !== session.current) return;
    sendEvent({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
    sendEvent({ type: "response.create" });
    armSilence();
  }, [sendEvent, setPhase, armSilence]);

  const onServerEvent = useCallback((ev: ServerEvent) => {
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        armSilence();
        setPhase("user");
        break;
      case "input_audio_buffer.speech_stopped":
        armSilence();
        setPhase("thinking");
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = (ev.transcript || "").trim();
        if (text) cb.current.onUserTranscript(text);
        break;
      }
      case "response.output_audio_transcript.delta": {
        const key = ev.item_id || "_";
        const next = (assistantBuf.current.get(key) || "") + (ev.delta || "");
        assistantBuf.current.set(key, next);
        cb.current.onAssistantDelta(next);
        break;
      }
      case "response.output_audio_transcript.done": {
        const key = ev.item_id || "_";
        const text = (ev.transcript ?? assistantBuf.current.get(key) ?? "").trim();
        assistantBuf.current.delete(key);
        if (text) cb.current.onAssistantTranscript(text);
        break;
      }
      case "output_audio_buffer.started":
        armSilence();
        setPhase("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        armSilence();
        setPhase(asks.current.size ? "thinking" : "listening");
        break;
      case "response.done": {
        // Function calls are taken from the finished response (per the docs),
        // so response.create never races a response still in progress.
        for (const item of ev.response?.output || []) {
          if (item.type === "function_call") void handleCall(item.call_id, item.name, item.arguments);
        }
        if (ev.response?.status === "failed") {
          cb.current.onError(`Realtime odpověď selhala: ${ev.response.status_details?.error?.message || "neznámá chyba"}`);
        }
        if (phase.current === "thinking" && !asks.current.size) setPhase("listening");
        break;
      }
      case "error":
        cb.current.onError(`Realtime: ${ev.error?.message || "neznámá chyba"}`);
        break;
    }
  }, [armSilence, setPhase, handleCall]);

  const start = useCallback(async () => {
    if (phase.current !== "off") return;
    teardown();
    const sid = session.current;
    const stale = () => sid !== session.current;
    setConnecting(true);
    setPhase("connecting");
    const fail = (msg: string) => {
      if (stale()) return;
      teardown();
      setPhase("off");
      cb.current.onError(msg);
    };
    try {
      if (typeof RTCPeerConnection === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        return fail("Tenhle prohlížeč neumí WebRTC hovor – použij Chrome, Edge nebo Safari.");
      }
      const res = await fetch("/api/realtime/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = (await res.json().catch(() => ({}))) as { value?: string; error?: string };
      if (stale()) return;
      if (!res.ok || !data.value) return fail(data.error || `Realtime relaci se nepodařilo vytvořit (HTTP ${res.status}).`);

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
        return fail(denied ? "Mikrofon není povolený - povol ho v adresním řádku prohlížeče." : `Mikrofon nejde otevřít: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (stale()) { stream.getTracks().forEach((t) => t.stop()); return; }
      mic.current = stream;

      const peer = new RTCPeerConnection();
      pc.current = peer;
      const el = document.createElement("audio");
      el.autoplay = true;
      el.muted = outputMuted.current;
      audioEl.current = el;
      peer.ontrack = (e) => { el.srcObject = e.streams[0]; };
      peer.addTrack(stream.getTracks()[0], stream);
      peer.onconnectionstatechange = () => {
        if (stale()) return;
        if (peer.connectionState === "failed") {
          cb.current.onError("Spojení s OpenAI Realtime se přerušilo.");
          stop("error");
        }
      };

      const channel = peer.createDataChannel("oai-events");
      dc.current = channel;
      channel.onmessage = (m) => {
        if (stale()) return;
        let ev: ServerEvent;
        try { ev = JSON.parse(String(m.data)) as ServerEvent; } catch { return; }
        if (ev && typeof ev.type === "string") onServerEvent(ev);
      };
      channel.onopen = () => {
        if (stale()) return;
        setConnecting(false);
        setActive(true);
        setStartedAt(Date.now());
        setPhase("listening");
        armSilence();
      };
      channel.onclose = () => {
        if (!stale() && phase.current !== "off") { cb.current.onError("Realtime hovor skončil ze strany serveru."); stop("error"); }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (stale()) return;
      const sdp = await fetch(CALLS_URL, {
        method: "POST",
        body: offer.sdp,
        headers: { authorization: `Bearer ${data.value}`, "content-type": "application/sdp" },
      });
      if (stale()) return;
      if (!sdp.ok) return fail(`OpenAI Realtime odmítl hovor (HTTP ${sdp.status}): ${(await sdp.text().catch(() => "")).slice(0, 200)}`);
      await peer.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
    } catch (e) {
      fail(`Realtime hovor se nepodařilo spojit: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [teardown, setPhase, stop, onServerEvent, armSilence]);

  /* Typed text while the call is open goes into the same conversation. */
  const sendText = useCallback((text: string): boolean => {
    const ch = dc.current;
    if (!ch || ch.readyState !== "open") return false;
    sendEvent({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    sendEvent({ type: "response.create" });
    armSilence();
    return true;
  }, [sendEvent, armSilence]);

  const setOutputMuted = useCallback((m: boolean) => {
    outputMuted.current = m;
    if (audioEl.current) audioEl.current.muted = m;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  return { active, connecting, startedAt, start, stop, sendText, setOutputMuted };
}
