/* Pure, framework-free pieces of the voice loop (unit-testable without a
 * browser): the NDJSON event splitter for /api/chat, the ask_apex function
 * output the Realtime model gets back, the energy VAD used to cut OpenAI STT
 * recordings, and the MediaRecorder format pick. */

/* Mirrors server/events.ts (ApexEvent) - the browser must not import server code. */
export type ApexEvent =
  | { t: "state"; v: "thinking" | "reasoning" | "speaking" | "idle" }
  | { t: "token"; v: string }
  | { t: "trace"; helper: string; tool: string }
  | { t: "job"; id: number; agent: string; status: "running" | "done" | "failed"; summary?: string }
  | { t: "action"; id: number; kind: string; summary: string }
  | { t: "info"; v: string }
  | { t: "error"; v: string }
  | { t: "done"; conversationId: string };

/* Feed decoded text chunks; every complete JSON line with a `t` is handed on. */
export function ndjsonSplitter(onEvent: (ev: ApexEvent) => void) {
  let buf = "";
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: unknown;
    try { ev = JSON.parse(trimmed); } catch { return; }
    if (ev && typeof ev === "object" && "t" in ev) onEvent(ev as ApexEvent);
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        consume(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    end() {
      consume(buf);
      buf = "";
    },
  };
}

/* What one Apex turn produced, collected from its events. */
export type TurnResult = {
  text: string;
  failure: string | null;
  actions: { id: number; kind: string; summary: string }[];
  jobs: { agent: string; status: "running" | "done" | "failed"; summary?: string }[];
};

export function collectTurn(events: ApexEvent[]): TurnResult {
  const out: TurnResult = { text: "", failure: null, actions: [], jobs: [] };
  const jobs = new Map<number, TurnResult["jobs"][number]>();
  for (const ev of events) {
    if (ev.t === "token") out.text += ev.v;
    else if (ev.t === "error") out.failure = ev.v;
    else if (ev.t === "action") out.actions.push({ id: ev.id, kind: ev.kind, summary: ev.summary });
    else if (ev.t === "job") jobs.set(ev.id, { agent: ev.agent, status: ev.status, summary: ev.summary });
  }
  out.jobs = [...jobs.values()];
  return out;
}

const MAX_ANSWER = 6000;

/* The function_call_output string for ask_apex. Proposed actions are spelled
 * out as NOT done yet, so the voice model can't claim they happened. */
/* ── short answer + details ──
 * The chief answers with 1–2 short sentences (spoken) and, only when useful,
 * a line DETAIL_MARK followed by details (shown on click, never spoken). */
export const DETAIL_MARK = "§§";

export function splitAnswer(text: string): { short: string; details: string } {
  const i = text.indexOf(DETAIL_MARK);
  if (i < 0) return { short: text.trim(), details: "" };
  return { short: text.slice(0, i).trim(), details: text.slice(i + DETAIL_MARK.length).trim() };
}

/* The part of a still-streaming answer that may be spoken: everything before
 * the mark, holding back a trailing "§" that may be the mark's first half. */
export function voicedPart(full: string): { text: string; complete: boolean } {
  const i = full.indexOf(DETAIL_MARK);
  if (i >= 0) return { text: full.slice(0, i), complete: true };
  return { text: full.endsWith(DETAIL_MARK[0]) ? full.slice(0, -1) : full, complete: false };
}

export function askApexOutput(r: TurnResult): string {
  // the realtime voice speaks the answer: give it the short part only
  const { short, details } = splitAnswer(r.text);
  const text = short;
  const out: Record<string, unknown> = {
    ok: !r.failure || !!text,
    answer: text ? text.slice(0, MAX_ANSWER) : r.failure ? "" : "Apex neodpověděl žádným textem.",
  };
  if (details) out.note_details = "Podrobnosti má majitel v chatu – neříkej je, pokud se nezeptá.";
  if (r.failure) out.error = r.failure;
  if (r.actions.length) {
    out.pending_approvals = r.actions.map((a) => ({ id: a.id, kind: a.kind, summary: a.summary }));
    out.note = "Tyto akce NEBYLY provedeny – jen navrženy a čekají na schválení majitelem v Command Decku.";
  }
  const failed = r.jobs.filter((j) => j.status === "failed").map((j) => j.agent);
  if (failed.length) out.failed_agents = failed;
  return JSON.stringify(out);
}

/* ── energy VAD ──
 * Fed one RMS level per frame (~50 ms). Speech starts once the level stays
 * above the threshold for minStartMs; it ends after silenceMs below the
 * (lower, hysteresis) release level. The threshold follows the room: a slow
 * average of the level while nobody speaks, times `ratio`. */
export type VadEvent = "speech-start" | "speech-end" | "max-length" | "no-speech";
export type VadOptions = {
  minThreshold?: number; ratio?: number; minStartMs?: number;
  silenceMs?: number; maxMs?: number; noSpeechMs?: number;
};

export class EnergyVad {
  private o: Required<VadOptions>;
  private t0: number | null = null;
  private floor: number | null = null;
  private aboveSince: number | null = null;
  private lastLoud = 0;
  speaking = false;
  heardSpeech = false;
  ended = false;

  constructor(opts: VadOptions = {}) {
    this.o = {
      minThreshold: 0.015, ratio: 3, minStartMs: 120,
      silenceMs: 900, maxMs: 60_000, noSpeechMs: 8_000,
      ...opts,
    };
  }

  /* How long the speaker has been quiet (0 while talking or before speech). */
  silentFor(t: number): number {
    return this.speaking ? Math.max(0, t - this.lastLoud) : 0;
  }

  threshold(): number {
    return Math.max(this.o.minThreshold, (this.floor ?? 0) * this.o.ratio);
  }

  feed(rms: number, t: number): VadEvent | null {
    if (this.ended) return null;
    if (this.t0 === null) this.t0 = t;
    if (t - this.t0 >= this.o.maxMs) { this.ended = true; this.speaking = false; return "max-length"; }
    const th = this.threshold();
    if (!this.speaking) {
      this.floor = this.floor === null ? Math.min(rms, this.o.minThreshold) : this.floor * 0.95 + rms * 0.05;
      if (rms > th) {
        this.aboveSince ??= t;
        if (t - this.aboveSince >= this.o.minStartMs) {
          this.speaking = true;
          this.heardSpeech = true;
          this.lastLoud = t;
          return "speech-start";
        }
      } else {
        this.aboveSince = null;
        if (!this.heardSpeech && t - this.t0 >= this.o.noSpeechMs) { this.ended = true; return "no-speech"; }
      }
      return null;
    }
    if (rms > th * 0.7) this.lastLoud = t;
    else if (t - this.lastLoud >= this.o.silenceMs) { this.ended = true; this.speaking = false; return "speech-end"; }
    return null;
  }
}

export function rms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/* First recording format the browser can make that OpenAI accepts
 * (webm / mp4 - ogg is not on OpenAI's list). */
export function pickRecorderMime(isSupported: (t: string) => boolean): string | null {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"]) {
    try { if (isSupported(t)) return t; } catch { /* keep looking */ }
  }
  return null;
}
