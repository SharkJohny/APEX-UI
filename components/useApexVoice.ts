"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* The voice loop behind the orb: listen (browser speech recognition) → think
 * (stream NDJSON events from /api/chat: tokens, agent traces, jobs, proposed
 * actions) → speak (sentence by sentence, so Apex starts talking before the
 * whole reply has arrived) → idle. */

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";
export type WebState = "standby" | "listening" | "processing" | "reasoning" | "speaking";
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ProviderInfo = { id: string; label: string; kind: "subscription" | "api"; tools?: boolean };
export type TtsMode = "elevenlabs" | "openai" | "browser";

/* Mirrors server/events.ts (ApexEvent) - the browser must not import server code. */
type ApexEvent =
  | { t: "state"; v: "thinking" | "reasoning" | "speaking" | "idle" }
  | { t: "token"; v: string }
  | { t: "trace"; helper: string; tool: string }
  | { t: "job"; id: number; agent: string; status: "running" | "done" | "failed"; summary?: string }
  | { t: "action"; id: number; kind: string; summary: string }
  | { t: "info"; v: string }
  | { t: "error"; v: string }
  | { t: "done"; conversationId: string };

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

export function useApexVoice() {
  const [state, setState] = useState<VoiceState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [partial, setPartial] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProviderState] = useState<string>("");
  const [tts, setTts] = useState<TtsMode>("browser");
  const [muted, setMutedState] = useState(false);
  const [canListen, setCanListen] = useState(false);
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

  const run = useRef(0);                 // bumps on every new turn / stop; stale callbacks compare against it
  const abort = useRef<AbortController | null>(null);
  const recog = useRef<Recognition | null>(null);
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
  const listenFails = useRef(0);          // consecutive recognition errors → back off before reopening the mic
  const relisten = useRef<ReturnType<typeof setTimeout> | null>(null);
  const convRef = useRef<string | null>(null);
  const traceN = useRef(0);
  const lastFire = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  messagesRef.current = messages;
  mutedRef.current = muted;
  handsFreeRef.current = handsFree;

  useEffect(() => {
    setCanListen(!!recognitionCtor());
    setMutedState(load(MUTE_KEY) === "1");
    setHandsFreeState(!!recognitionCtor() && load(HANDS_FREE_KEY) === "1");
    fetch("/api/providers")
      .then((r) => r.json())
      .then((d: { providers?: ProviderInfo[]; tts?: TtsMode }) => {
        const list = d.providers || [];
        setProviders(list);
        setTts(d.tts === "elevenlabs" || d.tts === "openai" ? d.tts : "browser");
        const saved = load(PROVIDER_KEY);
        const pick = list.find((p) => p.id === saved) ?? list[0];
        if (pick) setProviderState(pick.id);
        else setError("Nenašel jsem žádného AI poskytovatele. Nainstaluj a přihlas claude, codex nebo gemini CLI.");
      })
      .catch(() => setError("Nepodařilo se načíst seznam poskytovatelů."));
    // Chrome loads voices lazily; touching the list early warms it up.
    try { window.speechSynthesis?.getVoices(); } catch { /* no TTS */ }
  }, []);

  const setProvider = useCallback((id: string) => { setProviderState(id); save(PROVIDER_KEY, id); }, []);
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

  const speakOne = useCallback((text: string, id: number): Promise<void> => {
    if (mutedRef.current) return Promise.resolve();
    if (tts !== "browser") {
      const ctrl = new AbortController();
      ttsAbort.current = ctrl;
      return fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: ctrl.signal })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((blob) => new Promise<void>((resolve) => {
          if (ttsAbort.current === ctrl) ttsAbort.current = null;
          if (id !== run.current || mutedRef.current) return resolve();
          const el = new Audio(URL.createObjectURL(blob));
          audio.current = el;
          el.onended = el.onerror = () => { URL.revokeObjectURL(el.src); resolve(); };
          el.play().catch(() => resolve());
        }))
        .catch((e: unknown) => {
          if (ttsAbort.current === ctrl) ttsAbort.current = null;
          // Aborted on purpose (barge-in, mute, stop) - not a failure, just stop.
          if (id !== run.current || mutedRef.current) return undefined;
          if (!ttsFallbackWarned.current) {
            ttsFallbackWarned.current = true;
            const reason = e instanceof Error ? e.message : String(e);
            setError(`Hlas serveru selhal – mluvím hlasem prohlížeče: ${reason}`);
          }
          return speakBrowser(text, id);
        });
    }
    return speakBrowser(text, id);
  }, [tts, speakBrowser]);

  const pump = useCallback(async (id: number) => {
    if (playing.current === id) return;
    playing.current = id;
    while (id === run.current && queue.current.length) {
      const next = queue.current.shift()!;
      if (mutedRef.current) continue;
      setState("speaking");
      await speakOne(next, id);
    }
    if (playing.current === id) playing.current = null;
    // Spoke everything so far but the reply is still streaming (e.g. a
    // specialist is working): go back to thinking, not a silent "speaking".
    if (id === run.current && !streamDone.current) setState("thinking");
    finishIfDone(id);
  }, [speakOne, finishIfDone]);

  const enqueue = useCallback((sentences: string[], id: number) => {
    if (!sentences.length || id !== run.current || mutedRef.current) return;
    queue.current.push(...sentences);
    void pump(id);
  }, [pump]);

  /* Cut off anything in flight: request, speech, recognition. */
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
    setInterim("");
  }, []);

  /* ── thinking ── */
  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content) return;
    if (!provider) { setError("Není vybraný žádný poskytovatel AI."); return; }
    stopAll();
    const id = run.current;
    const history: ChatMessage[] = [...messagesRef.current, { role: "user", content }];
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
    let failure: string | null = null;

    // Light a node on the reasoning web. One helper per fire, so each agent
    // blooms the moment it starts; repeats of the same agent inside a short
    // window (one agent calling several tools) are folded into one pulse.
    const fire = (helper: string) => {
      const now = Date.now();
      if (lastFire.current.id === helper && now - lastFire.current.at < 1800) return;
      lastFire.current = { id: helper, at: now };
      traceN.current += 1;
      setTrace({ n: traceN.current, trace: [{ helper }] });
    };

    const handle = (ev: ApexEvent) => {
      switch (ev.t) {
        case "token": {
          full += ev.v;
          pending += ev.v;
          setPartial(full);
          const [sentences, rest] = takeSentences(pending);
          pending = rest;
          enqueue(sentences, id);
          break;
        }
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
        case "error":
          failure = ev.v;
          break;
        case "done":
          if (ev.conversationId) { convRef.current = ev.conversationId; setConversationId(ev.conversationId); }
          break;
      }
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, messages: history, ...(convRef.current ? { conversationId: convRef.current } : {}) }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const consume = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: ApexEvent;
        try { ev = JSON.parse(trimmed) as ApexEvent; } catch { return; }
        if (ev && typeof ev === "object" && "t" in ev) handle(ev);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (id !== run.current) { void reader.cancel().catch(() => undefined); return; }
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          consume(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      buf += dec.decode();
      consume(buf);
    } catch (e) {
      if (id !== run.current) return;
      failure = e instanceof Error ? e.message : String(e);
    }
    if (id !== run.current) return;
    streamDone.current = true;
    abort.current = null;
    setReasoning(false);
    if (pending.trim()) enqueue([pending.trim()], id);
    if (full.trim()) setMessages((m) => [...m, { role: "assistant", content: full.trim() }]);
    setPartial("");
    if (failure) setError(failure);
    finishIfDone(id);
  }, [provider, stopAll, enqueue, finishIfDone]);

  /* ── listening ── */
  const listen = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) { setError("Tenhle prohlížeč neumí rozpoznávat řeč - použij Chrome, nebo piš do pole dole."); return; }
    stopAll();
    const id = run.current;
    const r = new Ctor();
    r.lang = LANG;
    r.interimResults = true;
    r.continuous = false;
    let finalText = "";
    r.onresult = (e) => {
      listenFails.current = 0;
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else live += res[0].transcript;
      }
      if (id === run.current) setInterim((finalText + " " + live).trim());
    };
    r.onerror = (e) => {
      if (id !== run.current) return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("Mikrofon není povolený - povol ho v adresním řádku prohlížeče.");
        // no point reopening a mic we may not use
        handsFreeRef.current = false;
        setHandsFreeState(false);
        save(HANDS_FREE_KEY, "0");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        listenFails.current += 1;
        setError(`Rozpoznávání řeči: ${e.error}`);
      }
    };
    r.onend = () => {
      if (id !== run.current) return;
      recog.current = null;
      setInterim("");
      if (finalText.trim()) void send(finalText);
      else setState("idle");
    };
    recog.current = r;
    setError(null);
    setState("listening");
    try { r.start(); } catch { setState("idle"); }
  }, [stopAll, send]);

  /* The orb's single tap: idle → listen; listening → finish listening;
   * thinking / speaking → interrupt and listen (barge-in). */
  const tap = useCallback(() => {
    if (state === "listening") { try { recog.current?.stop(); } catch { /* ended */ } return; }
    if (!recognitionCtor()) { setError("Tenhle prohlížeč neumí rozpoznávat řeč - použij Chrome, nebo piš do pole dole."); return; }
    listen();
  }, [state, listen]);

  const stop = useCallback(() => {
    stopAll();
    setPartial("");
    setState("idle");
  }, [stopAll]);

  const setHandsFree = useCallback((on: boolean) => {
    handsFreeRef.current = on;
    setHandsFreeState(on);
    save(HANDS_FREE_KEY, on ? "1" : "0");
    listenFails.current = 0;
    if (on) {
      if (state === "idle") listen();
    } else if (state === "listening") {
      stopAll();
      setState("idle");
    }
  }, [state, listen, stopAll]);

  // Hands-free loop: whenever Apex is idle (answer spoken, silence timed out,
  // error handled) and the tab is visible, open the mic again.
  useEffect(() => {
    if (relisten.current) { clearTimeout(relisten.current); relisten.current = null; }
    if (!handsFree || state !== "idle") return;
    const reopen = () => {
      if (!handsFreeRef.current || document.hidden) return;
      listen();
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
  }, [handsFree, state, listen]);

  const reset = useCallback(() => {
    stop();
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
    handsFree, setHandsFree,
    send, tap, stop, reset,
    webState, reasoning, trace, activity, conversationId, dataVersion, newActions,
  };
}
