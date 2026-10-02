"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EnergyVad, askApexOutput, collectTurn, makeWakeMatcher, ndjsonSplitter, pickRecorderMime, rms, voicedPart, type ApexEvent } from "./voiceCore";
import { useRealtimeVoice, type RealtimePhase } from "./useRealtimeVoice";

/* The voice loop behind the orb: listen (browser speech recognition, or a
 * recording cut by an energy VAD and transcribed by OpenAI via /api/stt) →
 * think (stream NDJSON events from /api/chat: tokens, agent traces, jobs,
 * proposed actions) → speak (sentence by sentence, so Apex starts talking
 * before the whole reply has arrived) → idle.
 * Voice mode "realtime" swaps the whole loop for an OpenAI Realtime call
 * (useRealtimeVoice); its ask_apex tool runs the same /api/chat turn. */

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";
export type WebState = "standby" | "listening" | "processing" | "reasoning" | "speaking";
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ProviderInfo = { id: string; label: string; kind: "subscription" | "api"; tools?: boolean };
export type TtsMode = "elevenlabs" | "openai" | "browser";
export type VoiceMode = "browser" | "openai" | "realtime";
export type SttMode = "browser" | "openai";

type ProvidersResponse = {
  providers?: ProviderInfo[]; defaultProvider?: string; tts?: TtsMode;
  voiceMode?: VoiceMode; stt?: SttMode; realtime?: boolean; hints?: string[]; pauseMs?: number;
  wake?: boolean; wakeWords?: string[];
};

/* One line in the dock's per-turn activity strip. Jobs update in place by id. */
export type Activity =
  | { key: string; kind: "job"; id: number; agent: string; status: "running" | "done" | "failed"; summary?: string }
  | { key: string; kind: "action"; id: number; actionKind: string; summary: string }
  | { key: string; kind: "info" | "error"; text: string };

/* The shape ReasoningWeb.jsx diffs on: it re-fires whenever `n` changes. */
export type WebTrace = { n: number; trace: { helper: string }[] };

const LANG = "cs-CZ";
const PROVIDER_KEY = "apex.provider";
const MUTE_KEY = "apex.muted";
const HANDS_FREE_KEY = "apex.handsFree";

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked - fine */ }
}

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type RecognitionError = { error: string };
type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null; onerror: ((e: RecognitionError) => void) | null; onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};
function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/* Countdown shown while the owner pauses mid-dictation. */
function pauseHint(leftMs: number): string {
  return `Pauza – odešlu za ${Math.max(1, Math.ceil(leftMs / 1000))} s (Enter = hned)`;
}

/* Short two-note tone: "I heard you" after the wake word. */
function playWakeTone() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      o.start(ctx.currentTime + i * 0.12);
      o.stop(ctx.currentTime + i * 0.12 + 0.15);
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 600);
  } catch { /* no audio */ }
}

const MIC_DENIED = "Mikrofon není povolený - povol ho v adresním řádku prohlížeče.";
const NO_RECOGNITION = "Tenhle prohlížeč neumí rozpoznávat řeč - použij Chrome, nebo piš do pole dole.";

/* Cut finished sentences off the front of the buffer; the rest waits for more text. */
function takeSentences(buf: string): [string[], string] {
  const out: string[] = [];
  const re = /[^.!?…\n]+[.!?…]+["')\]]*\s+|[^\n]+\n+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf))) {
    if (m.index !== last) break;
    const s = m[0].trim();
    if (s) out.push(s);
    last = re.lastIndex;
  }
  return [out, buf.slice(last)];
}

type Recording = { finish: (upload: boolean) => void };

export function useApexVoice() {
  const [state, setState] = useState<VoiceState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [partial, setPartial] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProviderState] = useState<string>("");
  const [tts, setTts] = useState<TtsMode>("browser");
  const [voiceMode, setVoiceModeState] = useState<VoiceMode>("browser");
  const [stt, setStt] = useState<SttMode>("browser");
  const [realtimeAvailable, setRealtimeAvailable] = useState(false);
  const [voiceHints, setVoiceHints] = useState<string[]>([]);
  const [muted, setMutedState] = useState(false);
  // What this browser can do: speech recognition, recording, WebRTC.
  const [caps, setCaps] = useState({ recognition: false, recorder: false, rtc: false });
  // Hands-free: the mic reopens by itself whenever Apex is idle - after each
  // answer and after silence - so a conversation needs no taps. The mic stays
  // closed while Apex speaks, or it would hear (and answer) itself.
  const [handsFree, setHandsFreeState] = useState(false);
  const [reasoning, setReasoning] = useState(false);   // a specialist is working (backend "reasoning" state)
  const [trace, setTrace] = useState<WebTrace | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0); // bumps on job / action events so panels refetch
  const [newActions, setNewActions] = useState(0);   // actions proposed in this session (badge fallback without /api/status)
  const [rtPhase, setRtPhase] = useState<RealtimePhase>("off");

  const run = useRef(0);                 // bumps on every new turn / stop; stale callbacks compare against it
  const abort = useRef<AbortController | null>(null);
  const recog = useRef<Recognition | null>(null);
  const rec = useRef<Recording | null>(null); // OpenAI STT recording in progress
  const finishListen = useRef<(() => void) | null>(null); // send what was dictated now (tap / Enter)
  const pauseMs = useRef(6000);           // dictation: silence before the utterance is sent (Settings › Hlas)
  const configRetries = useRef(0);
  const wakeOn = useRef(false);           // hands-free waits for the owner's call (Settings › Hlas)
  const wakeWords = useRef<string[]>(["Apex"]);
  const localRecognition = useRef(false); // Chrome can recognise Czech on this device - audio stays here
  const [wake, setWake] = useState(false);
  const loadConfigRef = useRef<(() => Promise<void>) | null>(null);
  const queue = useRef<string[]>([]);
  const playing = useRef<number | null>(null); // run id whose queue is being spoken
  const streamDone = useRef(true);
  const audio = useRef<HTMLAudioElement | null>(null);
  const ttsAbort = useRef<AbortController | null>(null);
  const ttsWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsFallbackWarned = useRef(false); // one "server TTS failed" notice per turn, not per sentence
  const messagesRef = useRef<ChatMessage[]>([]);
  const mutedRef = useRef(false);
  const handsFreeRef = useRef(false);
  const providerRef = useRef("");
  const listenFails = useRef(0);          // consecutive recognition errors → back off before reopening the mic
  const relisten = useRef<ReturnType<typeof setTimeout> | null>(null);
  const convRef = useRef<string | null>(null);
  const traceN = useRef(0);
  const lastFire = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  messagesRef.current = messages;
  mutedRef.current = muted;
  handsFreeRef.current = handsFree;
  providerRef.current = provider;

  const pushMessage = useCallback((m: ChatMessage) => {
    messagesRef.current = [...messagesRef.current, m];
    setMessages(messagesRef.current);
  }, []);

  /* Providers + voice setup; refetched after a settings change. */
  const loadConfig = useCallback(() => {
    return fetch("/api/providers")
      .then((r) => r.json())
      .then((d: ProvidersResponse) => {
        configRetries.current = 0;
        const list = d.providers || [];
        setProviders(list);
        setTts(d.tts === "elevenlabs" || d.tts === "openai" ? d.tts : "browser");
        setVoiceModeState(d.voiceMode === "openai" || d.voiceMode === "realtime" ? d.voiceMode : "browser");
        setStt(d.stt === "openai" ? "openai" : "browser");
        setRealtimeAvailable(!!d.realtime);
        setVoiceHints(d.hints || []);
        if (d.pauseMs) pauseMs.current = d.pauseMs;
        wakeOn.current = !!d.wake;
        setWake(!!d.wake);
        if (d.wakeWords?.length) wakeWords.current = d.wakeWords;
        const current = providerRef.current;
        if (current && list.some((p) => p.id === current)) return;
        const saved = load(PROVIDER_KEY);
        const pick = list.find((p) => p.id === saved) ?? list.find((p) => p.id === d.defaultProvider) ?? list[0];
        if (pick) setProviderState(pick.id);
        else setError("Nenašel jsem žádného AI poskytovatele. Nainstaluj a přihlas claude, codex nebo gemini CLI.");
      })
      .catch(() => {
        // Usually the dev server restarting: keep the last good setup and try
        // again shortly, instead of silently falling back to the browser voice.
        configRetries.current += 1;
        if (configRetries.current <= 20) setTimeout(() => { void loadConfigRef.current?.(); }, 3_000);
        else setError("Nepodařilo se načíst seznam poskytovatelů.");
      });
  }, []);
  loadConfigRef.current = loadConfig;

  // Newer Chrome can recognise speech on this device: then waiting for the
  // wake word sends no room audio anywhere. Best effort - else the cloud one.
  useEffect(() => {
    const SR = (window as unknown as { SpeechRecognition?: { available?: (o: object) => Promise<string> } }).SpeechRecognition;
    SR?.available?.({ langs: [LANG], processLocally: true })
      .then((a) => { localRecognition.current = a === "available"; })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    setCaps({
      recognition: !!recognitionCtor(),
      recorder: !!md?.getUserMedia && typeof MediaRecorder !== "undefined",
      rtc: !!md?.getUserMedia && typeof RTCPeerConnection !== "undefined",
    });
    setMutedState(load(MUTE_KEY) === "1");
    setHandsFreeState(load(HANDS_FREE_KEY) === "1");
    void loadConfig();
    // The Settings drawer announces changes; voice mode / keys may have moved.
    const onSettings = () => { void loadConfig(); };
    window.addEventListener("apex:settings-changed", onSettings);
    // back to the tab (e.g. after the server restarted meanwhile): refresh the voice setup
    const onVisible = () => { if (document.visibilityState === "visible") void loadConfig(); };
    document.addEventListener("visibilitychange", onVisible);
    // Chrome loads voices lazily; touching the list early warms it up.
    try { window.speechSynthesis?.getVoices(); } catch { /* no TTS */ }
    return () => {
      window.removeEventListener("apex:settings-changed", onSettings);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadConfig]);

  const canListen = voiceMode === "realtime" ? caps.rtc : stt === "openai" ? caps.recorder : caps.recognition;

  const setProvider = useCallback((id: string) => { setProviderState(id); save(PROVIDER_KEY, id); }, []);

  /* ── speaking ── */
  const finishIfDone = useCallback((id: number) => {
    if (id === run.current && streamDone.current && playing.current !== id && queue.current.length === 0) setState("idle");
  }, []);

  const speakBrowser = useCallback((text: string, id: number): Promise<void> => {
    return new Promise<void>((resolve) => {
      const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
      if (!synth) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = LANG;
      const voices = synth.getVoices();
      const voice = voices.find((v) => v.lang === LANG && /google|zuzana|premium|enhanced/i.test(v.name)) ?? voices.find((v) => v.lang?.startsWith("cs"));
      if (voice) u.voice = voice;
      u.rate = 1.05;
      const finish = () => {
        if (ttsWatchdog.current) { clearTimeout(ttsWatchdog.current); ttsWatchdog.current = null; }
        resolve();
      };
      u.onend = u.onerror = finish;
      // Chrome sometimes never fires onend/onerror for a queued utterance -
      // without this the pump hangs forever and the orb stays "speaking".
      ttsWatchdog.current = setTimeout(() => {
        ttsWatchdog.current = null;
        try { synth.cancel(); } catch { /* no TTS */ }
        finish();
      }, Math.max(4000, text.length * 120));
      synth.speak(u);
    });
  }, []);

  /* Server voice: one request per chunk, not per sentence - separate
   * generations drift in timbre and intonation, so a reply cut into many tiny
   * requests sounds like several speakers. The first chunk is one sentence (fast
   * start); later chunks merge queued sentences up to ~600 chars, and the next
   * chunk is fetched while the current one plays (no gaps). */
  const fetchTts = useCallback((text: string, ctrl: AbortController): Promise<Blob> =>
    fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: ctrl.signal })
      .then(async (r) => (r.ok ? r.blob() : Promise.reject(new Error((await r.json().catch(() => null))?.error || `HTTP ${r.status}`)))), []);

  const playBlob = useCallback((blob: Blob, id: number): Promise<void> => new Promise<void>((resolve) => {
    if (id !== run.current || mutedRef.current) return resolve();
    const el = new Audio(URL.createObjectURL(blob));
    audio.current = el;
    el.onended = el.onerror = () => { URL.revokeObjectURL(el.src); resolve(); };
    el.play().catch((e: unknown) => {
      // Chrome blocks sound until the page has been clicked since it loaded
      if (e instanceof DOMException && e.name === "NotAllowedError") {
        setError("Prohlížeč zablokoval zvuk – klepni kamkoli do stránky a Apex bude zase mluvit.");
      }
      resolve();
    });
  }), []);

  const serverFailed = useCallback((e: unknown, text: string, id: number): Promise<void> => {
    // Aborted on purpose (barge-in, mute, stop) - not a failure, just stop.
    if (id !== run.current || mutedRef.current) return Promise.resolve();
    if (!ttsFallbackWarned.current) {
      ttsFallbackWarned.current = true;
      const reason = e instanceof Error ? e.message : String(e);
      setError(`Hlas serveru selhal – mluvím hlasem prohlížeče: ${reason}`);
    }
    return speakBrowser(text, id);
  }, [speakBrowser]);

  const CHUNK_MAX = 600;
  const takeChunk = (first: boolean): string => {
    if (!queue.current.length) return "";
    let text = queue.current.shift()!;
    while (!first && queue.current.length && text.length + 1 + queue.current[0].length <= CHUNK_MAX) {
      text += " " + queue.current.shift()!;
    }
    return text;
  };

  const pump = useCallback(async (id: number) => {
    if (playing.current === id) return;
    playing.current = id;
    if (tts === "browser") {
      while (id === run.current && queue.current.length) {
        const next = queue.current.shift()!;
        if (mutedRef.current) continue;
        setState("speaking");
        await speakBrowser(next, id);
      }
    } else {
      const ctrl = new AbortController();
      ttsAbort.current = ctrl;
      let first = true;
      let ahead: { text: string; audio: Promise<Blob> } | null = null;
      const request = (text: string) => {
        const audio = fetchTts(text, ctrl);
        audio.catch(() => undefined); // handled when played
        return { text, audio };
      };
      while (id === run.current && !mutedRef.current) {
        const cur = ahead ?? (queue.current.length ? request(takeChunk(first)) : null);
        ahead = null;
        if (!cur) break;
        first = false;
        setState("speaking");
        if (queue.current.length) ahead = request(takeChunk(false));
        try {
          await playBlob(await cur.audio, id);
        } catch (e) {
          await serverFailed(e, cur.text, id);
        }
      }
      if (ttsAbort.current === ctrl) ttsAbort.current = null;
    }
    if (playing.current === id) playing.current = null;
    // Spoke everything so far but the reply is still streaming (e.g. a
    // specialist is working): go back to thinking, not a silent "speaking".
    if (id === run.current && !streamDone.current) setState("thinking");
    finishIfDone(id);
  }, [tts, speakBrowser, fetchTts, playBlob, serverFailed, finishIfDone]);

  const enqueue = useCallback((sentences: string[], id: number) => {
    if (!sentences.length || id !== run.current || mutedRef.current) return;
    queue.current.push(...sentences);
    void pump(id);
  }, [pump]);

  /* Cut off anything in flight: request, speech, recognition, recording. */
  const stopAll = useCallback(() => {
    run.current++;
    abort.current?.abort();
    abort.current = null;
    queue.current = [];
    streamDone.current = true;
    ttsAbort.current?.abort();
    ttsAbort.current = null;
    setReasoning(false);
    if (ttsWatchdog.current) { clearTimeout(ttsWatchdog.current); ttsWatchdog.current = null; }
    try { window.speechSynthesis?.cancel(); } catch { /* no TTS */ }
    if (audio.current) { audio.current.pause(); audio.current.dispatchEvent(new Event("ended")); audio.current = null; }
    try { recog.current?.abort(); } catch { /* not running */ }
    recog.current = null;
    rec.current?.finish(false);
    rec.current = null;
    finishListen.current = null;
    setInterim("");
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    save(MUTE_KEY, m ? "1" : "0");
    mutedRef.current = m;
    if (m) {
      // Voice off means no more speech at all: drop the queue and cancel any
      // server TTS request still in flight, not just the audio element.
      queue.current = [];
      ttsAbort.current?.abort();
      ttsAbort.current = null;
      try { window.speechSynthesis?.cancel(); } catch { /* no TTS */ }
      if (audio.current) { audio.current.pause(); audio.current.dispatchEvent(new Event("ended")); audio.current = null; }
    }
  }, []);

  /* ── thinking ── */
  // Light a node on the reasoning web. One helper per fire, so each agent
  // blooms the moment it starts; repeats of the same agent inside a short
  // window (one agent calling several tools) are folded into one pulse.
  const fire = useCallback((helper: string) => {
    const now = Date.now();
    if (lastFire.current.id === helper && now - lastFire.current.at < 1800) return;
    lastFire.current = { id: helper, at: now };
    traceN.current += 1;
    setTrace({ n: traceN.current, trace: [{ helper }] });
  }, []);

  /* One /api/chat turn: streams the NDJSON events, keeps the web / activity
   * strip / Deck badges in sync and hands every event to onEvent. Resolves
   * false when the turn went stale (alive() turned false) mid-stream. */
  const streamChat = useCallback(async (
    history: ChatMessage[], signal: AbortSignal, alive: () => boolean, onEvent: (ev: ApexEvent) => void,
  ): Promise<boolean> => {
    const common = (ev: ApexEvent) => {
      switch (ev.t) {
        case "state":
          if (ev.v === "reasoning") setReasoning(true);
          else if (ev.v === "thinking" || ev.v === "speaking" || ev.v === "idle") setReasoning(false);
          break;
        case "trace":
          if (ev.helper) fire(ev.helper);
          break;
        case "job":
          if (ev.status === "running") fire(ev.agent);
          setActivity((list) => {
            const item: Activity = { key: `job-${ev.id}`, kind: "job", id: ev.id, agent: ev.agent, status: ev.status, summary: ev.summary };
            const at = list.findIndex((a) => a.key === item.key);
            if (at < 0) return [...list, item];
            const next = list.slice();
            next[at] = item;
            return next;
          });
          if (ev.status !== "running") setDataVersion((v) => v + 1);
          break;
        case "action":
          setActivity((list) => [...list, { key: `action-${ev.id}`, kind: "action", id: ev.id, actionKind: ev.kind, summary: ev.summary }]);
          setNewActions((c) => c + 1);
          setDataVersion((v) => v + 1);
          break;
        case "info":
          setActivity((list) => [...list, { key: `info-${list.length}-${ev.v.length}`, kind: "info", text: ev.v }]);
          break;
        case "done":
          if (ev.conversationId) { convRef.current = ev.conversationId; setConversationId(ev.conversationId); }
          break;
      }
      onEvent(ev);
    };
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: providerRef.current, messages: history, ...(convRef.current ? { conversationId: convRef.current } : {}) }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const split = ndjsonSplitter((ev) => { if (alive()) common(ev); });
    for (;;) {
      const { done, value } = await reader.read();
      if (!alive()) { void reader.cancel().catch(() => undefined); return false; }
      if (done) break;
      split.push(dec.decode(value, { stream: true }));
    }
    split.push(dec.decode());
    split.end();
    return true;
  }, [fire]);

  /* ── realtime ("plný rozhovor") ── */
  // ask_apex from the realtime model: a normal Apex turn, not spoken by us -
  // the realtime voice retells the answer.
  const askApex = useCallback(async (request: string, signal: AbortSignal): Promise<string> => {
    if (!providerRef.current) return askApexOutput({ text: "", failure: "Není vybraný žádný poskytovatel AI.", actions: [], jobs: [] });
    // The owner's last utterance is already in the transcript; the model's
    // request is its complete restatement, so it takes that slot.
    let history = messagesRef.current.slice(-20);
    if (history[history.length - 1]?.role === "user") history = history.slice(0, -1);
    history = [...history, { role: "user", content: request }];
    setActivity([]);
    const events: ApexEvent[] = [];
    try {
      await streamChat(history, signal, () => !signal.aborted, (ev) => events.push(ev));
    } catch (e) {
      if (signal.aborted) throw e;
      events.push({ t: "error", v: e instanceof Error ? e.message : String(e) });
    } finally {
      setReasoning(false);
    }
    return askApexOutput(collectTurn(events));
  }, [streamChat]);

  const rt = useRealtimeVoice({
    onUserTranscript: (text) => pushMessage({ role: "user", content: text }),
    onAssistantDelta: (text) => setPartial(text),
    onAssistantTranscript: (text) => { setPartial(""); pushMessage({ role: "assistant", content: text }); },
    onAskApex: askApex,
    onPhase: (p) => {
      setRtPhase(p);
      setState(p === "off" ? "idle" : p === "listening" || p === "user" ? "listening" : p === "speaking" ? "speaking" : "thinking");
    },
    onError: (msg) => setError(msg),
    onEnded: (reason) => {
      setPartial("");
      setReasoning(false);
      if (reason === "silence") setActivity((list) => [...list, { key: `info-silence-${Date.now()}`, kind: "info", text: "Rozhovor ukončen (ticho)" }]);
    },
  });
  const { stop: rtStop, start: rtStart, sendText: rtSendText, setOutputMuted: rtSetOutputMuted } = rt;
  const rtOn = rtPhase !== "off";

  useEffect(() => { rtSetOutputMuted(muted); }, [muted, rtSetOutputMuted]);
  // Leaving realtime mode (dock switch / Settings) hangs up.
  useEffect(() => { if (voiceMode !== "realtime" && rtOn) rtStop("user"); }, [voiceMode, rtOn, rtStop]);

  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content) return;
    if (rtOn) {
      // Typed while the realtime call is open: same conversation, spoken reply.
      if (rtSendText(content)) { pushMessage({ role: "user", content }); setError(null); }
      else setError("Realtime hovor ještě není spojený.");
      return;
    }
    if (!provider) { setError("Není vybraný žádný poskytovatel AI."); return; }
    stopAll();
    const id = run.current;
    const history: ChatMessage[] = [...messagesRef.current, { role: "user", content }];
    messagesRef.current = history;
    setMessages(history);
    setPartial("");
    setError(null);
    setState("thinking");
    streamDone.current = false;
    ttsFallbackWarned.current = false;

    setActivity([]);

    const ctrl = new AbortController();
    abort.current = ctrl;
    let full = "";
    let pending = "";
    let spoken = 0;         // chars of the voiced part already queued for speech
    let voiceDone = false;  // reached the details mark: the rest is not spoken
    let failure: string | null = null;

    try {
      const fresh = await streamChat(history, ctrl.signal, () => id === run.current, (ev) => {
        if (ev.t === "token") {
          full += ev.v;
          setPartial(full);
          if (voiceDone) return;
          // only the short answer before the details mark is spoken
          const v = voicedPart(full);
          pending += v.text.slice(spoken);
          spoken = v.text.length;
          const [sentences, rest] = takeSentences(pending);
          pending = rest;
          enqueue(sentences, id);
          if (v.complete) {
            voiceDone = true;
            if (pending.trim()) enqueue([pending.trim()], id);
            pending = "";
          }
        } else if (ev.t === "error") {
          failure = ev.v;
        }
      });
      if (!fresh) return;
    } catch (e) {
      if (id !== run.current) return;
      failure = e instanceof Error ? e.message : String(e);
    }
    if (id !== run.current) return;
    streamDone.current = true;
    abort.current = null;
    setReasoning(false);
    if (pending.trim()) enqueue([pending.trim()], id);
    if (full.trim()) pushMessage({ role: "assistant", content: full.trim() });
    setPartial("");
    if (failure) setError(failure);
    finishIfDone(id);
  }, [provider, stopAll, enqueue, finishIfDone, streamChat, pushMessage, rtOn, rtSendText]);

  /* ── listening ── */
  const micDenied = useCallback(() => {
    setError(MIC_DENIED);
    // no point reopening a mic we may not use
    handsFreeRef.current = false;
    setHandsFreeState(false);
    save(HANDS_FREE_KEY, "0");
  }, []);

  const transcribe = useCallback(async (blob: Blob, id: number) => {
    if (blob.size < 2000) { setState("idle"); return; } // a click, not speech
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState("thinking");
    setInterim("Přepisuji…");
    try {
      const form = new FormData();
      form.append("file", blob, blob.type.includes("mp4") ? "apex.mp4" : "apex.webm");
      const res = await fetch("/api/stt", { method: "POST", body: form, signal: ctrl.signal });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (id !== run.current) return;
      abort.current = null;
      setInterim("");
      if (!res.ok) { listenFails.current += 1; setError(data.error || `Přepis řeči selhal (HTTP ${res.status}).`); setState("idle"); return; }
      listenFails.current = 0;
      if (data.text?.trim()) void send(data.text);
      else setState("idle");
    } catch (e) {
      if (id !== run.current) return;
      abort.current = null;
      setInterim("");
      listenFails.current += 1;
      setError(`Přepis řeči selhal: ${e instanceof Error ? e.message : String(e)}`);
      setState("idle");
    }
  }, [send]);

  /* OpenAI STT: record the mic, cut the utterance with the energy VAD
   * (starts above the room level, ends after ~900 ms of silence, max 60 s),
   * then upload it to /api/stt. */
  const listenRecorded = useCallback(async () => {
    stopAll();
    const id = run.current;
    // no setError(null) here: the hands-free loop reopens the mic right after
    // a failure and would wipe the message before the owner can read it
    const mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) { setError("Prohlížeč neumí nahrávat ve formátu pro OpenAI (webm/mp4) – přepni přepis řeči na prohlížeč."); setState("idle"); return; }
    setState("listening");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (id !== run.current) return;
      if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")) micDenied();
      else { listenFails.current += 1; setError(`Mikrofon nejde otevřít: ${e instanceof Error ? e.message : String(e)}`); }
      setState("idle");
      return;
    }
    if (id !== run.current) { stream.getTracks().forEach((t) => t.stop()); return; }

    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const frame = new Float32Array(analyser.fftSize);
    // a long pause is fine - people stop to think mid-sentence; Enter / tap sends at once
    const vad = new EnergyVad({ silenceMs: pauseMs.current, maxMs: 180_000 });
    let timer: ReturnType<typeof setInterval> | null = null;
    let hint = "";

    const release = () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
    };
    const recording: Recording = {
      finish: (upload) => {
        if (rec.current === recording) rec.current = null;
        if (timer) { clearInterval(timer); timer = null; } else return; // already finished
        if (!upload || recorder.state === "inactive") {
          recorder.onstop = null;
          try { recorder.stop(); } catch { /* inactive */ }
          release();
          return;
        }
        recorder.onstop = () => {
          release();
          if (id === run.current) void transcribe(new Blob(chunks, { type: mime.split(";")[0] }), id);
        };
        try { recorder.stop(); } catch { release(); }
      },
    };
    rec.current = recording;
    finishListen.current = () => recording.finish(true);
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(frame);
      const now = performance.now();
      const ev = vad.feed(rms(frame), now);
      if (ev === null && vad.speaking) {
        const quiet = vad.silentFor(now);
        const next = quiet >= 1000 ? pauseHint(pauseMs.current - quiet) : "Nahrávám… (Enter = odeslat)";
        if (next !== hint) { hint = next; setInterim(next); }
      }
      if (ev === "speech-start") { listenFails.current = 0; hint = "Nahrávám… (Enter = odeslat)"; setInterim(hint); }
      else if (ev === "speech-end" || ev === "max-length") { setInterim(""); recording.finish(true); }
      else if (ev === "no-speech") { recording.finish(false); if (id === run.current) setState("idle"); }
    }, 50);
    recorder.start(250);
  }, [stopAll, micDenied, transcribe]);

  /* Chrome speech recognition. Chrome ends a session on its own after a short
   * pause, so sessions are reopened until the owner has been quiet for pauseMs
   * (or presses Enter / taps). The text is rebuilt from all results each time.
   * wake: wait for the owner's call ("Apexi, …") first - everything said before
   * it is ignored, the call itself is cut off, a short tone confirms it. */
  const listenBrowser = useCallback((opts: { wake?: boolean } = {}) => {
    const Ctor = recognitionCtor();
    if (!Ctor) { setError(NO_RECOGNITION); return; }
    stopAll();
    const id = run.current;
    const findWake = opts.wake ? makeWakeMatcher(wakeWords.current) : null;
    let armed = !findWake;
    let before = "";        // text of earlier sessions
    let session = "";       // text of the current session
    let from = 0;           // where the message starts (after the call)
    let heard = false;
    let lastHeard = Date.now();
    let done = false;
    const text = () => `${before} ${session}`.trim();
    const message = () => text().slice(from).trim();
    const show = () => {
      if (id !== run.current) return;
      if (!armed) { setInterim(`Čekám na oslovení „${wakeWords.current[0] ?? "Apex"}“…`); return; }
      const quiet = Date.now() - lastHeard;
      const msg = message();
      setInterim(heard && quiet >= 1000 ? `${msg || "Poslouchám…"}\n${pauseHint(pauseMs.current - quiet)}` : msg || "Poslouchám…");
    };
    const ticker = setInterval(() => {
      if (id !== run.current || done) { clearInterval(ticker); return; }
      show();
      if (armed && Date.now() - lastHeard >= pauseMs.current) {
        // called but said nothing more: go back to waiting, in a fresh session
        // so the old call in this session's results can't trigger again
        if (findWake && !message()) {
          armed = false; before = ""; session = ""; from = 0; heard = false;
          try { recog.current?.abort(); } catch { /* ended */ }
          return;
        }
        if (heard || !findWake) finish();
      }
    }, 250);
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(ticker);
      try { recog.current?.stop(); } catch { /* ended */ }
      if (!recog.current) end();
    };
    const end = () => {
      clearInterval(ticker);
      if (id !== run.current) return;
      recog.current = null;
      finishListen.current = null;
      setInterim("");
      const msg = armed ? message() : "";
      if (msg) void send(msg);
      else setState("idle");
    };
    // tap / Enter: send now - or, while waiting for the call, count as the call
    finishListen.current = () => {
      if (armed) { finish(); return; }
      armed = true;
      from = text().length;
      heard = false;
      lastHeard = Date.now();
      playWakeTone();
      show();
    };
    const start = () => {
      const r = new Ctor();
      r.lang = LANG;
      r.interimResults = true;
      r.continuous = true;
      if (localRecognition.current) (r as Recognition & { processLocally?: boolean }).processLocally = true;
      r.onresult = (e) => {
        listenFails.current = 0;
        let all = "";
        for (let i = 0; i < e.results.length; i++) all += e.results[i][0].transcript;
        session = all.trim();
        if (!armed && findWake) {
          const full = text();
          const at = findWake(full);
          if (at < 0) return;
          armed = true;
          from = at;
          playWakeTone();
        }
        heard = true;
        lastHeard = Date.now();
        show();
      };
      bind(r);
      recog.current = r;
      try { r.start(); } catch { end(); }
    };
    const bind = (r: Recognition) => {
      r.onerror = (e) => {
        if (id !== run.current) return;
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          done = true; // no reopening after onend
          micDenied();
        } else if (e.error !== "no-speech" && e.error !== "aborted") {
          done = true;
          listenFails.current += 1;
          console.warn("[apex] speech recognition error", e);
          setError(`Rozpoznávání řeči: ${e.error}`);
        }
      };
      r.onend = () => {
        if (id !== run.current) { clearInterval(ticker); return; }
        recog.current = null;
        // the session's words stay; while waiting for the call keep only a short tail
        if (armed) { before = text(); }
        else { const t = text(); before = t.slice(-60); from = 0; }
        session = "";
        const idle = Date.now() - lastHeard;
        if (!done && (!armed || (heard ? idle < pauseMs.current : idle < 8_000))) start();
        else end();
      };
    };
    setState("listening");
    show();
    start();
  }, [stopAll, send, micDenied]);

  const listen = useCallback(() => {
    if (stt === "openai") void listenRecorded();
    else listenBrowser();
  }, [stt, listenRecorded, listenBrowser]);

  /* Hands-free: with the wake word on, wait for the call (Chrome recognition,
   * whatever the dictation engine) - an always-open recorder would upload all
   * room sound to OpenAI. */
  const listenHandsFree = useCallback(() => {
    if (wakeOn.current && caps.recognition) listenBrowser({ wake: true });
    else listen();
  }, [listen, listenBrowser, caps.recognition]);

  /* The orb's single tap: idle → listen; listening → finish listening;
   * thinking / speaking → interrupt and listen (barge-in). In realtime mode
   * it starts / hangs up the call (barge-in is built into the call). */
  const tap = useCallback(() => {
    if (voiceMode === "realtime") {
      if (rtOn) { rtStop("user"); return; }
      if (!caps.rtc) { setError("Tenhle prohlížeč neumí WebRTC hovor – použij Chrome, Edge nebo Safari."); return; }
      stopAll();
      setError(null);
      void rtStart();
      return;
    }
    if (state === "listening") {
      if (finishListen.current) finishListen.current();
      else if (rec.current) rec.current.finish(true);
      else { try { recog.current?.stop(); } catch { /* ended */ } }
      return;
    }
    if (!canListen) { setError(stt === "openai" ? "Tenhle prohlížeč neumí nahrávat zvuk - piš do pole dole." : NO_RECOGNITION); return; }
    setError(null);
    listen();
  }, [voiceMode, rtOn, rtStop, caps.rtc, stopAll, rtStart, state, canListen, stt, listen]);

  /* Enter sends the dictation right away (unless the owner is typing text). */
  useEffect(() => {
    if (state !== "listening") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.value.trim()) return;
      if (!finishListen.current) return;
      e.preventDefault();
      finishListen.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const stop = useCallback(() => {
    if (rtOn) rtStop("user");
    stopAll();
    setPartial("");
    setState("idle");
  }, [rtOn, rtStop, stopAll]);

  const setHandsFree = useCallback((on: boolean) => {
    handsFreeRef.current = on;
    setHandsFreeState(on);
    save(HANDS_FREE_KEY, on ? "1" : "0");
    listenFails.current = 0;
    if (on) setError(null);
    if (voiceMode === "realtime") return; // the call is continuous anyway
    if (on) {
      if (state === "idle" && canListen) listenHandsFree();
    } else if (state === "listening") {
      stopAll();
      setState("idle");
    }
  }, [voiceMode, state, canListen, listenHandsFree, stopAll]);

  // Hands-free loop: whenever Apex is idle (answer spoken, silence timed out,
  // error handled) and the tab is visible, open the mic again.
  useEffect(() => {
    if (relisten.current) { clearTimeout(relisten.current); relisten.current = null; }
    if (!handsFree || state !== "idle" || voiceMode === "realtime" || !canListen) return;
    const reopen = () => {
      // waiting for the call works with Apex in the background too (that's the point)
      if (!handsFreeRef.current || (document.hidden && !wakeOn.current)) return;
      listenHandsFree();
    };
    // short pause so the tail of Apex's own voice isn't picked up; longer after errors
    const delay = Math.min(8000, 400 * 2 ** listenFails.current);
    relisten.current = setTimeout(reopen, delay);
    const onVisible = () => { if (!document.hidden) reopen(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (relisten.current) { clearTimeout(relisten.current); relisten.current = null; }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [handsFree, state, voiceMode, canListen, listenHandsFree]);

  /* Dock mode switch: persists APEX_VOICE_MODE through the Settings API. */
  const setVoiceMode = useCallback(async (mode: VoiceMode) => {
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "APEX_VOICE_MODE", value: mode }),
      });
      if (res.status === 404) { setError("Nastavení zatím není dostupné – režim hlasu teď nejde přepnout."); return; }
      if (!res.ok) { setError((await res.json().catch(() => null))?.error || `Režim hlasu se nepodařilo uložit (HTTP ${res.status}).`); return; }
      setError(null);
      await loadConfig();
    } catch (e) {
      setError(`Režim hlasu se nepodařilo uložit: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [loadConfig]);

  const reset = useCallback(() => {
    stop();
    messagesRef.current = [];
    setMessages([]);
    setError(null);
    setActivity([]);
    convRef.current = null;
    setConversationId(null);
  }, [stop]);

  const webState: WebState =
    state === "listening" ? "listening"
    : state === "speaking" ? "speaking"
    : state === "thinking" ? (reasoning ? "reasoning" : "processing")
    : "standby";

  useEffect(() => () => stopAll(), [stopAll]);

  return {
    state, messages, partial, interim, error, setError,
    providers, provider, setProvider, tts, muted, setMuted, canListen,
    handsFree, setHandsFree, wake,
    send, tap, stop, reset,
    webState, reasoning, trace, activity, conversationId, dataVersion, newActions,
    voiceMode, setVoiceMode, stt, realtimeAvailable, voiceHints, refreshVoiceConfig: loadConfig,
    realtime: { on: rtOn, connecting: rt.connecting, active: rt.active, startedAt: rt.startedAt },
  };
}
