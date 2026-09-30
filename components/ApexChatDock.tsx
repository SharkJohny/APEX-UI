"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Ear, EarOff, LayoutGrid, Loader2, Mic, MicOff, PhoneOff, RotateCcw, Send, Settings, Square, Volume2, VolumeX } from "lucide-react";
import type { Activity, VoiceMode, useApexVoice } from "./useApexVoice";
import { ACTIONS_CHANGED, ActionDetails, CopyButton, notifyActionsChanged, parsePayload, type ActionRow, type DeckSection } from "./ApexDeck";
import { apiJson, asList } from "./useApexStatus";
import { ROSTER_BY_KEY } from "@/lib/roster";

/* Bottom-right conversation panel: transcript, the current turn's agent
 * activity (jobs, proposed actions, notes), text input (for browsers without
 * speech recognition, or just typing), provider picker, mic / stop / mute,
 * the Command Deck button with the pending-approvals badge, the Settings gear
 * and the voice mode switch (browser / OpenAI / Realtime). Text is selectable;
 * every bubble and the whole conversation can be copied, and proposed actions
 * can be approved or rejected right in the chat. */

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

const MODES: { id: VoiceMode; label: string; title: string }[] = [
  { id: "browser", label: "Prohlížeč", title: "Rozpoznávání řeči v prohlížeči, odpovědi čte nastavený hlas." },
  { id: "openai", label: "OpenAI", title: "Mozek Apexe + hlas OpenAI (volitelně i přepis řeči přes OpenAI)." },
  { id: "realtime", label: "Realtime", title: "Plný hlasový rozhovor přes OpenAI Realtime; data a akce řeší Apex." },
];
const NO_KEY_TITLE = "Chybí OpenAI API klíč – otevři Nastavení";

export default function ApexChatDock({ voice, pending, onOpenDeck, onOpenSettings }: {
  voice: Voice; pending: number; onOpenDeck: (s?: DeckSection) => void; onOpenSettings?: () => void;
}) {
  const { state, messages, partial, interim, error, providers, provider, setProvider, tts, muted, setMuted, canListen, handsFree, setHandsFree, send, tap, stop, reset, reasoning, activity, voiceMode, setVoiceMode, realtimeAvailable, voiceHints, realtime } = voice;
  const [draft, setDraft] = useState("");
  const [switching, setSwitching] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const isRealtime = voiceMode === "realtime";
  const logRef = useRef<HTMLDivElement>(null);
  const busy = state === "thinking" || state === "speaking";
  const chipsBeforeLast = activity.length > 0 && !partial && messages[messages.length - 1]?.role === "assistant";

  // Elapsed-minutes counter for the REALTIME badge.
  useEffect(() => {
    if (!realtime.startedAt) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [realtime.startedAt]);
  const minutes = realtime.startedAt ? Math.max(0, Math.floor((now - realtime.startedAt) / 60_000)) : 0;

  const pickMode = async (m: VoiceMode) => {
    if (m === voiceMode || switching) return;
    setSwitching(true);
    try { await setVoiceMode(m); } finally { setSwitching(false); }
  };

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
        color: "#f0ede8", fontSize: 14, userSelect: "text",
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
        <span role="status" style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.8, flex: 1, minWidth: 44, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {realtime.connecting ? "Spojuji…" : state === "thinking" && reasoning ? "Agenti pracují…" : handsFree && state === "listening" && !isRealtime ? "Trvale poslouchám…" : LABEL[state]}
        </span>
        {realtime.on && (
          <span
            title="Probíhá plný hlasový rozhovor (OpenAI Realtime) – účtuje se podle délky. Klepnutím na orb ho ukončíš."
            style={{
              flex: "none", padding: "2px 6px", borderRadius: 6, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em",
              color: "#04080f", background: CYAN, boxShadow: `0 0 8px ${CYAN}`,
            }}
          >
            REALTIME {minutes} min
          </span>
        )}
        {messages.length > 0 && (
          <CopyButton
            text={() => messages.map((m) => `**${m.role === "user" ? "Ty" : "Apex"}:** ${m.content}`).join("\n\n")}
            label="Kopírovat konverzaci"
            title="Kopírovat konverzaci (Markdown)"
            className="copy-btn copy-btn-icon"
            iconSize={15}
            style={iconBtn}
          />
        )}
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
        {onOpenSettings && (
          <button type="button" onClick={onOpenSettings} aria-label="Nastavení" title="Nastavení" style={iconBtn}>
            <Settings size={15} />
          </button>
        )}
      </header>

      <div role="radiogroup" aria-label="Režim hlasu" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
        <span style={{ opacity: 0.6, fontFamily: "var(--font-mono)", letterSpacing: "0.08em", textTransform: "uppercase", fontSize: 10.5 }}>Hlas</span>
        {MODES.map((m) => {
          const locked = m.id !== "browser" && !realtimeAvailable;
          const on = voiceMode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={locked || switching}
              onClick={() => { if (locked) onOpenSettings?.(); else void pickMode(m.id); }}
              title={locked ? NO_KEY_TITLE : m.title}
              style={{
                padding: "3px 9px", borderRadius: 999, fontSize: 11.5, cursor: locked ? "help" : "pointer",
                border: `1px solid ${on ? CYAN : "rgba(240,237,232,0.16)"}`,
                background: on ? "rgba(13,210,255,0.16)" : "rgba(240,237,232,0.04)",
                color: on ? CYAN : "rgba(240,237,232,0.85)",
                opacity: locked ? 0.4 : switching && !on ? 0.6 : 1,
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      {voiceHints.length > 0 && (
        <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.4, opacity: 0.7 }}>{voiceHints.join(" ")}</p>
      )}

      <div ref={logRef} aria-live="polite" style={{ overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", gap: 8, minHeight: 0, paddingTop: 10 }}>
        {messages.length === 0 && !partial && !interim && (
          <p style={{ margin: 0, opacity: 0.6, lineHeight: 1.45 }}>
            {isRealtime
              ? "Klepni na orb a začni plný hlasový rozhovor. Dalším klepnutím ho ukončíš."
              : canListen ? "Klepni na orb a mluv, nebo napiš zprávu dole." : "Napiš zprávu dole (rozpoznávání řeči funguje v Chrome)."}
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
        {busy && !realtime.on ? (
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
          aria-pressed={isRealtime ? realtime.on : state === "listening"}
          aria-label={isRealtime ? (realtime.on ? "Ukončit rozhovor" : "Zahájit rozhovor") : state === "listening" ? "Přestat poslouchat" : "Mluvit"}
          title={!canListen
            ? (isRealtime ? "Prohlížeč neumí WebRTC hovor" : "Prohlížeč neumí rozpoznávat řeč")
            : isRealtime ? (realtime.on ? "Ukončit plný rozhovor" : "Zahájit plný rozhovor (Realtime)")
            : state === "listening" ? "Přestat poslouchat" : "Mluvit"}
          style={{
            ...iconBtn,
            opacity: canListen ? 1 : 0.45,
            color: (isRealtime ? realtime.on : state === "listening") ? "#04080f" : CYAN,
            background: (isRealtime ? realtime.on : state === "listening") ? CYAN : iconBtn.background,
          }}
        >
          {!canListen ? <MicOff size={16} /> : isRealtime && realtime.on ? <PhoneOff size={16} /> : <Mic size={16} />}
        </button>
        <button
          type="button"
          onClick={() => setHandsFree(!handsFree)}
          disabled={!canListen || isRealtime}
          aria-pressed={handsFree}
          aria-label={handsFree ? "Vypnout trvalé poslouchání" : "Zapnout trvalé poslouchání"}
          title={isRealtime
            ? "V režimu Realtime poslouchám průběžně po celý rozhovor."
            : canListen
            ? (handsFree ? "Trvalé poslouchání je zapnuté – po každé odpovědi poslouchám dál. Klikni pro vypnutí." : "Trvalé poslouchání: mluv, pauzou odešli, po odpovědi poslouchám dál.")
            : "Prohlížeč neumí rozpoznávat řeč"}
          style={{
            ...iconBtn,
            opacity: canListen && !isRealtime ? 1 : 0.45,
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
      className="dock-bubble"
      style={{
        alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "88%",
        padding: "7px 11px", borderRadius: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
        background: mine ? "rgba(13,210,255,0.12)" : "rgba(245,166,35,0.10)",
        border: `1px solid ${mine ? "rgba(13,210,255,0.28)" : "rgba(245,166,35,0.25)"}`,
        opacity: faint ? 0.7 : 1,
      }}
    >
      {text}
      {!faint && text && <CopyButton text={text} label="Kopírovat zprávu" className="copy-btn dock-bubble-copy" />}
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
        if (a.kind === "action") return <ActionChip key={a.key} id={a.id} kind={a.actionKind} summary={a.summary} onOpenDeck={onOpenDeck} />;
        return <span key={a.key} className={`dock-chip dock-chip-${a.kind}`}><span>{a.text}</span></span>;
      })}
    </div>
  );
}

const EDITABLE_KINDS = new Set(["email_send", "social_post", "calendar_create", "vault_write"]);

/* A proposed action inline in the chat: summary, agent, expandable details and
 * Schválit / Zamítnout (POST /api/actions/{id}), then the result in place. The
 * row is fetched once when the chip appears and again when another view
 * reports a change (apex:actions-changed). */
function ActionChip({ id, kind, summary, onOpenDeck }: { id: number; kind: string; summary: string; onOpenDeck: (s?: DeckSection) => void }) {
  const [row, setRow] = useState<ActionRow | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<unknown>("/api/actions");
      const found = asList<ActionRow>(d, "actions").find((r) => r.id === id);
      if (found) { setRow(found); setLoadErr(null); } else setLoadErr("Návrh se nepodařilo najít – otevři Command Deck.");
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onChange = () => { void load(); };
    window.addEventListener(ACTIONS_CHANGED, onChange);
    return () => window.removeEventListener(ACTIONS_CHANGED, onChange);
  }, [load]);

  const payload = useMemo(() => (row ? parsePayload(row.payload) : null), [row]);
  const status = row?.status ?? "pending";
  const actionable = !!row && (status === "pending" || status === "failed");
  const agent = row?.agent ? ROSTER_BY_KEY[row.agent]?.name ?? row.agent : null;
  const label = kind === "deferred_tool" && payload && typeof payload.label === "string" && payload.label ? payload.label : null;

  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    setErr(null);
    try {
      const next = await apiJson<ActionRow>(`/api/actions/${id}`, { method: "POST", body: JSON.stringify({ decision }) });
      if (next && typeof next === "object" && "status" in next) setRow(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      notifyActionsChanged();
    }
  };

  return (
    <div className="dock-action" role="group" aria-label={`Návrh ke schválení #${id}`}>
      <div className="dock-action-head">
        <span className="dock-action-tag">Ke schválení #{id}{agent ? ` · ${agent}` : ""}</span>
        {status !== "pending" && <span className={`deck-pill deck-pill-${status}`}>{status === "executed" ? "provedeno" : status === "rejected" ? "zamítnuto" : status === "failed" ? "chyba" : status === "approved" ? "provádí se" : status}</span>}
      </div>
      <p className="dock-action-sum">{summary}</p>
      {label && label !== summary && <p className="dock-action-meta">{label}</p>}
      {loadErr && !row && <p className="dock-action-meta">{loadErr}</p>}

      {payload && (
        <button type="button" className="dock-action-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          {open ? "Skrýt podrobnosti" : "Podrobnosti"}
        </button>
      )}
      {open && payload && <div className="dock-action-details"><ActionDetails kind={kind} payload={payload} /></div>}

      {status === "executed" && (
        <div className="dock-action-result dock-action-ok">
          <span>✓ Provedeno</span>
          {row?.evidence && (
            <>
              <span className="dock-action-evidence">{row.evidence}</span>
              <CopyButton text={row.evidence} label="Kopírovat důkaz" />
            </>
          )}
        </div>
      )}
      {status === "failed" && <p className="dock-action-result dock-action-err">✗ Chyba{row?.error ? `: ${row.error}` : ""}</p>}
      {status === "rejected" && <p className="dock-action-result dock-action-meta">Zamítnuto</p>}
      {err && <p className="dock-action-result dock-action-err" role="alert">{err}</p>}

      <div className="dock-action-btns">
        {actionable && (
          <>
            <button type="button" className="deck-btn deck-btn-sm deck-btn-gold" disabled={!!busy} onClick={() => void decide("approve")}>
              {busy === "approve" ? <><Loader2 size={12} className="dock-spin" aria-hidden="true" /> Provádím…</> : status === "failed" ? "Zkusit znovu" : "Schválit"}
            </button>
            <button type="button" className="deck-btn deck-btn-sm" disabled={!!busy} onClick={() => void decide("reject")}>
              {busy === "reject" ? "…" : "Zamítnout"}
            </button>
          </>
        )}
        {(EDITABLE_KINDS.has(kind) || (!row && !!loadErr)) && (status === "pending" || !row) && (
          <button type="button" className="deck-btn deck-btn-sm" onClick={() => onOpenDeck("approvals")}>Otevřít v Decku</button>
        )}
      </div>
    </div>
  );
}
