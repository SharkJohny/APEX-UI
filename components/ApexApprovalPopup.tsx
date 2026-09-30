"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { ROSTER_BY_KEY } from "@/lib/roster";
import { ACTIONS_CHANGED, ActionDetails, CopyButton, notifyActionsChanged, parsePayload, type ActionRow } from "./ApexDeck";
import { SETTINGS_EVENT } from "./ApexSettings";
import { apiJson, fmtTime } from "./useApexStatus";

/* Approval popup - when the owner turns on "Schválení vyskakují jako okno"
 * (APEX_APPROVAL_POPUP, read from GET /api/settings), every pending action he
 * has not seen in this browser session opens in a centered modal: kind, agent,
 * summary and the same read-only detail views the chat card uses. Polls
 * /api/actions every 5 s while the tab is visible and on "apex:actions-changed".
 * Seen/dismissed ids live in sessionStorage, so a reload does not spam but the
 * earlier queue pops up once per browser session. While the owner types in an
 * input it only shows a small toast instead of stealing focus. */

const POLL_MS = 5_000;
const SEEN_KEY = "apex.approvalPopup.seen";
const RESULT_MS = 1_800;

type KindRow = { kind: string; label: string };
type Result = { ok: boolean; text: string; evidence?: string };

const agentName = (key?: string) => (key ? ROSTER_BY_KEY[key]?.name ?? key : "–");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function loadSeen(): Set<number> {
  try {
    const v = JSON.parse(sessionStorage.getItem(SEEN_KEY) || "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
  } catch { return new Set(); }
}
function saveSeen(s: Set<number>) {
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500))); } catch { /* storage blocked - in-memory only */ }
}

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "TEXTAREA" || el.isContentEditable
    || (el.tagName === "INPUT" && !["button", "checkbox", "radio", "range", "submit", "reset"].includes((el as HTMLInputElement).type));
}

export default function ApexApprovalPopup({ onOpenDeck, suppressed = false }: {
  onOpenDeck: () => void;
  /* True while the Deck's approvals tab is open - no point in a second window. */
  suppressed?: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState<ActionRow[]>([]);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<number[]>([]);
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<"closed" | "toast" | "open">("closed");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<number> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const seenSet = () => (seen.current ??= loadSeen());

  // Effective setting value: on mount and whenever Nastavení saves something.
  useEffect(() => {
    let alive = true;
    const load = () => {
      apiJson<{ groups?: { fields?: { key: string; value?: string }[] }[] }>("/api/settings")
        .then((d) => {
          const f = (d.groups ?? []).flatMap((g) => g.fields ?? []).find((x) => x.key === "APEX_APPROVAL_POPUP");
          if (alive) setEnabled(f?.value === "1");
        })
        .catch(() => { /* settings unavailable - keep the last known value */ });
    };
    load();
    const onChange = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (!key || key === "APEX_APPROVAL_POPUP") load();
    };
    window.addEventListener(SETTINGS_EVENT, onChange);
    return () => { alive = false; window.removeEventListener(SETTINGS_EVENT, onChange); };
  }, []);

  // Pending actions: poll while visible, refetch on "apex:actions-changed".
  const fetchActions = useCallback(async () => {
    try {
      const d = await apiJson<{ actions?: ActionRow[]; kinds?: KindRow[] }>("/api/actions");
      setPending((d.actions ?? []).filter((a) => a.status === "pending").sort((x, y) => x.id - y.id));
      setKinds(Object.fromEntries((d.kinds ?? []).map((k) => [k.kind, k.label])));
    } catch { /* transient - the next poll retries */ }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void fetchActions();
    const tick = () => { if (document.visibilityState === "visible") void fetchActions(); };
    const timer = setInterval(tick, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") void fetchActions(); };
    const onActions = () => { void fetchActions(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener(ACTIONS_CHANGED, onActions);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener(ACTIONS_CHANGED, onActions);
    };
  }, [enabled, fetchActions]);

  // Queue = pending ids not yet seen this session (plus the ones already queued
  // that are still pending). Decided elsewhere → drops out, unless its result is on screen.
  const current = queue[index] ?? null;
  useEffect(() => {
    const ids = new Set(pending.map((a) => a.id));
    const s = seenSet();
    setQueue((q) => {
      const keep = q.filter((id) => ids.has(id) || (id === current && result));
      const fresh = pending.map((a) => a.id).filter((id) => !s.has(id) && !keep.includes(id));
      if (!fresh.length && keep.length === q.length) return q;
      return [...keep, ...fresh];
    });
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the index valid when items drop out.
  useEffect(() => {
    if (index >= queue.length && queue.length) setIndex(queue.length - 1);
    if (!queue.length && mode !== "closed" && !result) setMode("closed");
  }, [queue, index, mode, result]);

  // Something new to show → open (or only a toast while the owner is typing).
  useEffect(() => {
    if (!enabled || suppressed || !queue.length || mode !== "closed") return;
    setMode(isTyping() ? "toast" : "open");
  }, [enabled, suppressed, queue, mode]);

  const markSeen = useCallback((ids: number[]) => {
    const s = seenSet();
    ids.forEach((id) => s.add(id));
    saveSeen(s);
  }, []);

  // Setting turned off → hide. Deck approvals open → the owner sees them there,
  // so the queued ones count as seen and do not pop up once the Deck closes.
  useEffect(() => {
    if (!enabled && mode !== "closed") setMode("closed");
  }, [enabled, mode]);
  useEffect(() => {
    if (!suppressed || (!queue.length && mode === "closed")) return;
    markSeen(queue);
    setQueue([]);
    setIndex(0);
    setResult(null);
    setMode("closed");
  }, [suppressed, queue, mode, markSeen]);

  const clearTimer = () => { if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; } };
  useEffect(() => clearTimer, []);

  // "Později": everything in the queue is dismissed for this session.
  const later = useCallback(() => {
    clearTimer();
    markSeen(queue);
    setQueue([]);
    setIndex(0);
    setResult(null);
    setError(null);
    setMode("closed");
  }, [queue, markSeen]);

  const advance = useCallback(() => {
    clearTimer();
    setResult(null);
    setError(null);
    setQueue((q) => {
      const next = q.filter((id) => id !== current);
      setIndex((i) => Math.min(i, Math.max(0, next.length - 1)));
      if (!next.length) setMode("closed");
      return next;
    });
  }, [current]);

  const decide = async (decision: "approve" | "reject") => {
    if (current === null || busy) return;
    setBusy(decision);
    setError(null);
    markSeen([current]);
    try {
      const row = await apiJson<ActionRow>(`/api/actions/${current}`, { method: "POST", body: JSON.stringify({ decision }) });
      const r: Result = row.status === "executed" ? { ok: true, text: "✓ Provedeno", evidence: row.evidence || undefined }
        : row.status === "rejected" ? { ok: true, text: "Zamítnuto" }
        : row.status === "failed" ? { ok: false, text: `✗ Chyba: ${row.error || "provedení selhalo"}` }
        : { ok: true, text: `Stav: ${row.status}` };
      setResult(r);
      if (r.ok) advanceTimer.current = setTimeout(advance, r.evidence ? RESULT_MS + 1_200 : RESULT_MS);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
      notifyActionsChanged();
    }
  };

  const openDeck = () => { later(); onOpenDeck(); };

  // Focus: the dialog itself on open (not "Schválit" - the window appears
  // unannounced, so a stray Space/Enter must never approve), Tab reaches the
  // buttons; back to the opener on close.
  useEffect(() => {
    if (mode !== "open") return;
    openerRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      const el = openerRef.current;
      if (el && document.contains(el) && el !== document.body) el.focus();
    };
  }, [mode]);
  useEffect(() => {
    if (mode === "open" && !busy && !dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
  }, [current, result, mode, busy]);

  // Esc = Později; captured on window so the Deck / cockpit behind do not also close.
  useEffect(() => {
    if (mode !== "open") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      later();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, later]);

  // Focus trap-lite: Tab wraps inside the dialog.
  const onDialogKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], summary, [tabindex]:not([tabindex='-1'])")];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const action = useMemo(() => pending.find((a) => a.id === current) ?? null, [pending, current]);
  // Keep the last snapshot while its result is shown (it is no longer pending).
  const shown = useRef<ActionRow | null>(null);
  if (action) shown.current = action;
  const a = action ?? (result ? shown.current : null);
  const payload = useMemo(() => (a ? parsePayload(a.payload) : {}), [a]);

  if (!enabled || suppressed || mode === "closed" || !queue.length) return null;

  if (mode === "toast") {
    return (
      <div className="apop-toast" role="status" aria-live="polite">
        <button type="button" className="apop-toast-main" onClick={() => setMode("open")}>
          <span className="apop-dot" aria-hidden="true" />
          {queue.length > 1 ? `${queue.length} nové návrhy ke schválení – zobrazit` : "Nový návrh ke schválení – zobrazit"}
        </button>
        <button type="button" className="apop-toast-x" aria-label="Později" title="Později" onClick={later}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const n = queue.length;
  const pos = Math.min(index, n - 1) + 1;
  return (
    <div className="apop-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) later(); }}>
      <div ref={dialogRef} className="apop" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="apop-title" aria-describedby="apop-sum" onKeyDown={onDialogKey}>
        <header className="apop-head">
          <span className="apop-kicker">Ke schválení</span>
          {n > 1 && (
            <span className="apop-nav">
              <button type="button" className="deck-icon" aria-label="Předchozí návrh" disabled={pos <= 1 || !!busy || !!result}
                onClick={() => { setError(null); setIndex((i) => Math.max(0, i - 1)); }}>
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <span className="apop-count" aria-live="polite">{pos} z {n}</span>
              <button type="button" className="deck-icon" aria-label="Další návrh" disabled={pos >= n || !!busy || !!result}
                onClick={() => { setError(null); setIndex((i) => Math.min(n - 1, i + 1)); }}>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </span>
          )}
          <button type="button" className="deck-icon" aria-label="Později (zavřít)" title="Později" onClick={later} disabled={!!busy}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        {a ? (
          <div className="apop-body">
            <p className="apop-label">#{a.id} · {kinds[a.kind] ?? a.kind}</p>
            <h2 id="apop-title" className="apop-title">{a.summary}</h2>
            <p id="apop-sum" className="apop-meta">Navrhl {agentName(a.agent)} · {fmtTime(a.created_at)}</p>
            <div className="apop-details"><ActionDetails kind={a.kind} payload={payload} /></div>
          </div>
        ) : (
          <div className="apop-body"><h2 id="apop-title" className="apop-title">Načítám návrh…</h2></div>
        )}

        {result && (
          <div className={`apop-result ${result.ok ? "apop-ok" : "apop-err"}`} role="status">
            <span>{result.text}</span>
            {result.evidence && <span className="apop-evidence">{result.evidence}</span>}
            {result.evidence && <CopyButton text={result.evidence} label="Kopírovat důkaz" />}
          </div>
        )}
        {error && <p className="apop-result apop-err" role="alert">{error}</p>}

        <footer className="apop-actions">
          {result ? (
            <button type="button" className="deck-btn deck-btn-gold" onClick={advance}>
              {n > 1 ? "Další návrh" : "Zavřít"}
            </button>
          ) : (
            <>
              <button type="button" className="deck-btn deck-btn-gold" disabled={!!busy || !a} onClick={() => void decide("approve")}>
                {busy === "approve" ? "Provádím…" : "Schválit"}
              </button>
              <button type="button" className="deck-btn" disabled={!!busy || !a} onClick={() => void decide("reject")}>
                {busy === "reject" ? "…" : "Zamítnout"}
              </button>
              <button type="button" className="deck-btn" disabled={!!busy} onClick={later}>Později</button>
            </>
          )}
          <button type="button" className="deck-btn deck-btn-cyan apop-deck" disabled={!!busy} onClick={openDeck}>Otevřít v Decku</button>
        </footer>
      </div>
    </div>
  );
}
