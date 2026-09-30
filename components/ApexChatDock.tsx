"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Ear, EarOff, LayoutGrid, Loader2, Mic, MicOff, RotateCcw, Send, Square, Volume2, VolumeX } from "lucide-react";
import type { Activity, useApexVoice } from "./useApexVoice";
import type { DeckSection } from "./ApexDeck";
import { ROSTER_BY_KEY } from "@/lib/roster";

/* Bottom-right conversation panel: transcript, the current turn's agent
 * activity (jobs, proposed actions, notes), text input (for browsers without
 * speech recognition, or just typing), provider picker, mic / stop / mute and
 * the Command Deck button with the pending-approvals badge. */

type Voice = ReturnType<typeof useApexVoice>;

const GOLD = "#f5a623";
const CYAN = "#0dd2ff";
const LABEL: Record<Voice["state"], string> = {
  idle: "Připraven",
  listening: "Poslouchám…",
  thinking: "Přemýšlím…",
  speaking: "Mluvím…",
};

const iconBtn: React.CSSProperties = {
  display: "grid", placeItems: "center", width: 34, height: 34, flex: "none",
  borderRadius: 10, border: "1px solid rgba(240,237,232,0.16)",
  background: "rgba(240,237,232,0.05)", color: "rgba(240,237,232,0.85)", cursor: "pointer",
};

const TTS_NAME: Record<Voice["tts"], string> = { elevenlabs: "ElevenLabs", openai: "OpenAI TTS", browser: "hlas prohlížeče" };

export default function ApexChatDock({ voice, pending, onOpenDeck }: { voice: Voice; pending: number; onOpenDeck: (s?: DeckSection) => void }) {
  const { state, messages, partial, interim, error, providers, provider, setProvider, tts, muted, setMuted, canListen, handsFree, setHandsFree, send, tap, stop, reset, reasoning, activity } = voice;
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const busy = state === "thinking" || state === "speaking";
  const chipsBeforeLast = activity.length > 0 && !partial && messages[messages.length - 1]?.role === "assistant";

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, partial, interim, activity]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    void send(draft);
    setDraft("");
  };

  return (
    <aside
      aria-label="Konverzace s Apexem"
      style={{
        position: "absolute", right: 16, bottom: 16, zIndex: 30,
        width: "min(380px, calc(100vw - 32px))", maxHeight: "min(56vh, 520px)",
        display: "flex", flexDirection: "column", gap: 10, padding: 12,
        borderRadius: 16, border: "1px solid rgba(240,237,232,0.14)",
        background: "rgba(6,13,24,0.72)", backdropFilter: "blur(10px)",
        color: "#f0ede8", fontSize: 14,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden="true"
          style={{
            width: 8, height: 8, borderRadius: "50%", flex: "none",
            background: state === "idle" ? "rgba(240,237,232,0.35)" : state === "listening" ? CYAN : GOLD,
            boxShadow: state === "idle" ? "none" : `0 0 10px ${state === "listening" ? CYAN : GOLD}`,
          }}
        />
        <span role="status" style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.8, flex: 1, whiteSpace: "nowrap" }}>
          {state === "thinking" && reasoning ? "Agenti pracují…" : handsFree && state === "listening" ? "Trvale poslouchám…" : LABEL[state]}
        </span>
        <button
          type="button"
          onClick={() => onOpenDeck(pending > 0 ? "approvals" : "jobs")}
          aria-label={pending > 0 ? `Command Deck – ${pending} ke schválení` : "Command Deck"}
          title="Command Deck"
          style={{ ...iconBtn, position: "relative" }}
        >
          <LayoutGrid size={15} />
          {pending > 0 && <span className="dock-badge" aria-hidden="true" style={{ position: "absolute", top: -6, right: -6 }}>{pending}</span>}
        </button>
        <select
          aria-label="Poskytovatel AI"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          style={{
            maxWidth: 130, minWidth: 0, padding: "5px 8px", borderRadius: 8, fontSize: 12,
            background: "rgba(240,237,232,0.06)", color: "#f0ede8", border: "1px solid rgba(240,237,232,0.16)",
          }}
        >
          {providers.length === 0 && <option value="">Žádný poskytovatel</option>}
          {providers.map((p) => (
            <option key={p.id} value={p.id} style={{ color: "#111" }}>{p.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setMuted(!muted)}
          aria-pressed={muted}
          aria-label={muted ? "Zapnout hlas" : "Ztlumit hlas"}
          title={muted ? "Zapnout hlas" : `Ztlumit hlas (${TTS_NAME[tts]})`}
          style={iconBtn}
        >
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <button type="button" onClick={reset} aria-label="Nová konverzace" title="Nová konverzace" style={iconBtn}>
          <RotateCcw size={15} />
        </button>
      </header>

      <div ref={logRef} aria-live="polite" style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
        {messages.length === 0 && !partial && !interim && (
          <p style={{ margin: 0, opacity: 0.6, lineHeight: 1.45 }}>
            {canListen ? "Klepni na orb a mluv, nebo napiš zprávu dole." : "Napiš zprávu dole (rozpoznávání řeči funguje v Chrome)."}
          </p>
        )}
        {messages.map((m, i) => (
          <Fragment key={i}>
            {/* the finished turn's activity sits between the question and the reply */}
            {chipsBeforeLast && i === messages.length - 1 && <ActivityChips items={activity} onOpenDeck={onOpenDeck} />}
            <Bubble role={m.role} text={m.content} />
          </Fragment>
        ))}
        {activity.length > 0 && !chipsBeforeLast && <ActivityChips items={activity} onOpenDeck={onOpenDeck} />}
        {interim && <Bubble role="user" text={interim} faint />}
        {partial && <Bubble role="assistant" text={partial} faint />}
      </div>

      {error && (
        <p role="alert" style={{ margin: 0, padding: "8px 10px", borderRadius: 10, background: "rgba(255,90,90,0.12)", border: "1px solid rgba(255,90,90,0.35)", fontSize: 12.5, lineHeight: 1.4 }}>
          {error}
        </p>
      )}

      <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Napiš Apexovi…"
          aria-label="Zpráva pro Apex"
          style={{
            flex: 1, minWidth: 0, padding: "8px 11px", borderRadius: 10, fontSize: 14,
            background: "rgba(240,237,232,0.06)", color: "#f0ede8", border: "1px solid rgba(240,237,232,0.16)", outline: "none",
          }}
        />
        {busy ? (
          <button type="button" onClick={stop} aria-label="Zastavit" title="Zastavit" style={{ ...iconBtn, color: GOLD }}>
            <Square size={15} />
          </button>
        ) : (
          <button type="submit" aria-label="Odeslat" title="Odeslat" disabled={!draft.trim()} style={{ ...iconBtn, opacity: draft.trim() ? 1 : 0.45 }}>
            <Send size={15} />
          </button>
        )}
        <button
          type="button"
          onClick={tap}
          disabled={!canListen}
          aria-pressed={state === "listening"}
          aria-label={state === "listening" ? "Přestat poslouchat" : "Mluvit"}
          title={canListen ? (state === "listening" ? "Přestat poslouchat" : "Mluvit") : "Prohlížeč neumí rozpoznávat řeč"}
          style={{
            ...iconBtn,
            opacity: canListen ? 1 : 0.45,
            color: state === "listening" ? "#04080f" : CYAN,
            background: state === "listening" ? CYAN : iconBtn.background,
          }}
        >
          {canListen ? <Mic size={16} /> : <MicOff size={16} />}
        </button>
        <button
          type="button"
          onClick={() => setHandsFree(!handsFree)}
          disabled={!canListen}
          aria-pressed={handsFree}
          aria-label={handsFree ? "Vypnout trvalé poslouchání" : "Zapnout trvalé poslouchání"}
          title={canListen
            ? (handsFree ? "Trvalé poslouchání je zapnuté – po každé odpovědi poslouchám dál. Klikni pro vypnutí." : "Trvalé poslouchání: mluv, pauzou odešli, po odpovědi poslouchám dál.")
            : "Prohlížeč neumí rozpoznávat řeč"}
          style={{
            ...iconBtn,
            opacity: canListen ? 1 : 0.45,
            color: handsFree ? "#04080f" : CYAN,
            background: handsFree ? CYAN : iconBtn.background,
            boxShadow: handsFree ? `0 0 12px ${CYAN}` : "none",
          }}
        >
          {handsFree ? <Ear size={16} /> : <EarOff size={16} />}
        </button>
      </form>
    </aside>
  );
}

function Bubble({ role, text, faint }: { role: "user" | "assistant"; text: string; faint?: boolean }) {
  const mine = role === "user";
  return (
    <div
      style={{
        alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "88%",
        padding: "7px 11px", borderRadius: 12, lineHeight: 1.45, whiteSpace: "pre-wrap",
        background: mine ? "rgba(13,210,255,0.12)" : "rgba(245,166,35,0.10)",
        border: `1px solid ${mine ? "rgba(13,210,255,0.28)" : "rgba(245,166,35,0.25)"}`,
        opacity: faint ? 0.7 : 1,
      }}
    >
      {text}
    </div>
  );
}

function ActivityChips({ items, onOpenDeck }: { items: Activity[]; onOpenDeck: (s?: DeckSection) => void }) {
  return (
    <div className="dock-chips" aria-label="Co se děje">
      {items.map((a) => {
        if (a.kind === "job") {
          const name = ROSTER_BY_KEY[a.agent]?.name ?? a.agent;
          const text = a.status === "running" ? `${name} pracuje…` : a.status === "done" ? `✓ ${name} hotovo` : `✗ ${name} selhal`;
          return (
            <span key={a.key} className={`dock-chip dock-chip-${a.status}`} title={a.summary || undefined}>
              {a.status === "running" && <Loader2 size={11} className="dock-spin" aria-hidden="true" />}
              <span>{text}</span>
            </span>
          );
        }
        if (a.kind === "action") {
          return (
            <button key={a.key} type="button" className="dock-chip dock-chip-action" title={a.summary} onClick={() => onOpenDeck("approvals")}>
              <span>Návrh ke schválení #{a.id} – otevřít</span>
            </button>
          );
        }
        return <span key={a.key} className={`dock-chip dock-chip-${a.kind}`}><span>{a.text}</span></span>;
      })}
    </div>
  );
}
