"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, RefreshCw, Settings, Copy, Check } from "lucide-react";
import { ROSTER, ROSTER_BY_KEY } from "@/lib/roster";
import { apiJson, asList, fmtTime, type ApexStatus } from "./useApexStatus";

/* Command Deck - the right-side drawer where the owner sees and steers what
 * the agents do: approve proposed actions, browse jobs, CRM, loops, memory,
 * the standing guide, integrations and the LLM call log. Opens from the dock,
 * or from the URL (?deck=section, e.g. after the Google OAuth redirect).
 * Every tab refetches when a chat turn produced jobs/actions (refreshKey) and
 * every 20s while the drawer is open. */

export type DeckSection = "approvals" | "jobs" | "crm" | "loops" | "memory" | "guide" | "integrations" | "log";

const TABS: { id: DeckSection; label: string }[] = [
  { id: "approvals", label: "Schválení" },
  { id: "jobs", label: "Úlohy" },
  { id: "crm", label: "CRM" },
  { id: "loops", label: "Smyčky" },
  { id: "memory", label: "Paměť" },
  { id: "guide", label: "Pokyny" },
  { id: "integrations", label: "Integrace" },
  { id: "log", label: "Log" },
];
const ALIAS: Record<string, DeckSection> = { actions: "approvals", approval: "approvals", calls: "log", google: "integrations", social: "integrations" };
function toSection(v: string | null): DeckSection | null {
  if (!v) return null;
  if (TABS.some((t) => t.id === v)) return v as DeckSection;
  return ALIAS[v] ?? null;
}

const REFRESH_MS = 20_000;
const agentName = (key?: string) => (key ? ROSTER_BY_KEY[key]?.name ?? key : "–");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Json = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/* Fetch a deck endpoint; keeps the last good data while refetching. */
function useDeckData<T>(url: string, reloadKey: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    apiJson<T>(url)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(errText(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [url, reloadKey, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload };
}

/* Copy to the clipboard; falls back to a hidden textarea + execCommand where
 * the async clipboard API is missing, refused or never settles (unfocused
 * window) - the fallback still runs inside the click's user activation. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      const ok = await Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800)),
      ]);
      if (ok) return true;
    }
  } catch { /* fall through to the textarea path */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
  const prev = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  prev?.focus?.();
  return ok;
}

/* Small copy button with 1.5 s "Zkopírováno" feedback. `text` may be lazy. */
export function CopyButton({ text, label = "Kopírovat", title, className = "copy-btn", iconSize = 12, showLabel = false, style }: {
  text: string | (() => string); label?: string; title?: string; className?: string; iconSize?: number; showLabel?: boolean; style?: React.CSSProperties;
}) {
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(typeof text === "function" ? text() : text);
    setState(ok ? "ok" : "err");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  };
  const feedback = state === "ok" ? "Zkopírováno" : state === "err" ? "Nepodařilo se zkopírovat" : "";
  return (
    <button type="button" className={className} style={style} onClick={(e) => void onClick(e)}
      aria-label={feedback || label} title={feedback || title || label} data-copied={state === "ok" ? "true" : undefined}>
      {state === "ok" ? <Check size={iconSize} aria-hidden="true" /> : <Copy size={iconSize} aria-hidden="true" />}
      {(showLabel || state !== "idle") && <span className="copy-fb">{feedback || label}</span>}
      <span className="visually-hidden" role="status">{feedback}</span>
    </button>
  );
}

function deckOp<T = unknown>(op: string, args: Json): Promise<T> {
  return apiJson<T>("/api/deck", { method: "POST", body: JSON.stringify({ op, ...args }) });
}

/* Runs an async op with a busy flag and a readable error. */
function useOp() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setError(null);
    try { await fn(); after?.(); } catch (e) { setError(errText(e)); } finally { setBusy(null); }
  }, []);
  return { busy, error, run };
}

function State({ loading, error, empty, emptyText }: { loading: boolean; error: string | null; empty: boolean; emptyText: string }) {
  if (error) return <p className="deck-note deck-err" role="alert">{error}</p>;
  if (loading && empty) return <p className="deck-note">Načítám…</p>;
  if (empty) return <p className="deck-note">{emptyText}</p>;
  return null;
}

/* ─────────────────────────── Schválení ─────────────────────────── */

export type ActionRow = { id: number; kind: string; summary: string; payload: string; agent: string; status: string; evidence?: string; error?: string; created_at?: string; decided_at?: string | null };
type KindRow = { kind: string; label: string; ready: boolean | string | null };  // true/null = ready, else the reason it is not

const EDITABLE: Record<string, { label: string; long?: boolean }> = {
  to: { label: "Komu" }, cc: { label: "Kopie" }, subject: { label: "Předmět" },
  body: { label: "Text e-mailu", long: true }, text: { label: "Text", long: true },
  message: { label: "Zpráva", long: true }, caption: { label: "Popisek", long: true }, content: { label: "Obsah", long: true },
  summary: { label: "Název události" }, start: { label: "Začátek" }, end: { label: "Konec" },
  location: { label: "Místo" }, description: { label: "Popis", long: true },
};
const ACTION_STATUS: Record<string, string> = { pending: "čeká", approved: "schváleno", rejected: "zamítnuto", executed: "provedeno", failed: "selhalo" };

export function parsePayload(p: unknown): Json {
  if (p && typeof p === "object") return p as Json;
  try { const v = JSON.parse(String(p)); return v && typeof v === "object" ? (v as Json) : { value: v }; } catch { return { value: str(p) }; }
}

/* A unified diff, +/- lines colored; read-only. */
export function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="deck-pre deck-diff" style={{ maxHeight: 320, whiteSpace: "pre-wrap" }}>
      {diff.replace(/\n$/, "").split("\n").map((line, i) => {
        const head = line.startsWith("+++") || line.startsWith("---");
        const color = head ? "rgba(240, 237, 232, 0.45)" : line.startsWith("@@") ? "#0dd2ff"
          : line.startsWith("+") ? "#6ee7b7" : line.startsWith("-") ? "#ff9b9b" : undefined;
        const bg = head ? undefined : line.startsWith("+") ? "rgba(52, 211, 153, 0.08)" : line.startsWith("-") ? "rgba(248, 113, 113, 0.08)" : undefined;
        return <span key={i} style={{ display: "block", color, background: bg }}>{line || " "}</span>;
      })}
    </pre>
  );
}

const VAULT_MODE: Record<string, string> = { create: "nová stránka", replace: "přepsání celé stránky", append: "doplnění na konec", patch: "úprava části", log: "záznam do deníku" };
type VaultPreview = { path: string; mode: string; diff: string };

/* vault_write: reason + exact diff per file. Approve/reject only - no inline edits. */
export function VaultWriteView({ payload }: { payload: Json }) {
  const preview = Array.isArray(payload.preview) ? (payload.preview as VaultPreview[]) : [];
  const files = Array.isArray(payload.files) ? (payload.files as { path?: string; mode?: string }[]) : [];
  return (
    <div className="deck-stack">
      <p className="deck-text">{str(payload.reason)}</p>
      {!preview.length && (
        <>
          <p className="deck-note deck-warn">Návrh nemá náhled změn – schválení by selhalo. Nech Apex návrh připravit znovu.</p>
          {files.map((f, i) => <p key={i} className="deck-meta deck-mono">{f.path} · {VAULT_MODE[str(f.mode)] ?? f.mode}</p>)}
        </>
      )}
      {preview.map((f) => (
        <div key={`${f.mode}:${f.path}`}>
          <div className="deck-row deck-wrap">
            <span className="deck-mono deck-grow">{f.path}</span>
            <span className="deck-meta">{VAULT_MODE[f.mode] ?? f.mode}</span>
          </div>
          <DiffBlock diff={f.diff} />
        </div>
      ))}
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  project_id: "Projekt (ID)", task_id: "Úkol (ID)", client_id: "Klient (ID)", task_ids: "Úkoly (ID)", title: "Název", name: "Název",
  description: "Popis", priority: "Priorita", deadline: "Termín", status: "Stav", content_html: "Obsah briefu", ico: "IČO", dic: "DIČ",
  email: "E-mail", phone: "Telefon", address: "Adresa", started_at: "Začátek", duration_minutes: "Délka (min)", billable: "Fakturovatelné",
};
const htmlText = (h: string) => h.replace(/<\/(p|h\d|li|div)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/* Readable key → value list (Raqeto actions). */
export function FieldList({ data }: { data: Json }) {
  return (
    <div className="deck-stack">
      {Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
        <div key={k} className="deck-field">
          <span className="deck-label">{FIELD_LABEL[k] ?? k.replace(/_/g, " ")}</span>
          {typeof v === "boolean" ? <span className="deck-text">{v ? "ano" : "ne"}</span>
            : typeof v === "object" ? <span className="deck-text deck-mono">{Array.isArray(v) ? v.map(str).join(", ") : JSON.stringify(v)}</span>
            : <span className="deck-text">{k.endsWith("_html") ? htmlText(str(v)) : str(v)}</span>}
        </div>
      ))}
    </div>
  );
}

/* deferred_tool: a tool call the safety guard held back ({tool, args, agent, reason, label?}). */
export function DeferredToolView({ payload }: { payload: Json }) {
  const args = payload.args && typeof payload.args === "object" && !Array.isArray(payload.args) ? (payload.args as Json) : null;
  return (
    <div className="deck-stack">
      {str(payload.label) && <p className="deck-text">{str(payload.label)}</p>}
      <p className="deck-meta">Nástroj <span className="deck-mono">{str(payload.tool) || "?"}</span>{str(payload.agent) ? ` · agent ${agentName(str(payload.agent))}` : ""}</p>
      {str(payload.reason) && (
        <div className="deck-field">
          <span className="deck-label">Proč čeká na schválení</span>
          <span className="deck-text">{str(payload.reason)}</span>
        </div>
      )}
      {args && Object.keys(args).length > 0 && (
        <div className="deck-field">
          <span className="deck-label">Parametry</span>
          <FieldList data={args} />
        </div>
      )}
    </div>
  );
}

const MESSAGE_KEYS = ["to", "cc", "subject", "summary", "start", "end", "location", "body", "text", "message", "caption", "content", "description"];

/* Readable, read-only payload for the chat dock's inline approval. */
export function ActionDetails({ kind, payload }: { kind: string; payload: Json }) {
  if (kind === "vault_write") return <VaultWriteView payload={payload} />;
  if (kind === "deferred_tool") return <DeferredToolView payload={payload} />;
  if (kind.startsWith("raqeto_")) return <FieldList data={payload} />;
  const main = MESSAGE_KEYS.filter((k) => typeof payload[k] === "string" && payload[k]);
  if (!main.length) return <FieldList data={payload} />;
  return (
    <div className="deck-stack">
      {main.map((k) => (
        <div key={k} className="deck-field">
          <span className="deck-label">{EDITABLE[k]?.label ?? k}</span>
          <span className="deck-text">{str(payload[k])}</span>
        </div>
      ))}
    </div>
  );
}

/* Tells the chat dock, the Deck and the status badge that an action changed. */
export const ACTIONS_CHANGED = "apex:actions-changed";
export const notifyActionsChanged = () => window.dispatchEvent(new Event(ACTIONS_CHANGED));

function ActionCard({ a, kind, onDone }: { a: ActionRow; kind?: KindRow; onDone: () => void }) {
  const payload = useMemo(() => parsePayload(a.payload), [a.payload]);
  const isVault = a.kind === "vault_write";
  const isRaqeto = a.kind.startsWith("raqeto_");
  const isDeferred = a.kind === "deferred_tool";
  const editKeys = isVault || isDeferred ? [] : Object.keys(payload).filter((k) => EDITABLE[k] && typeof payload[k] === "string");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ActionRow | null>(null);
  const { busy, error, run } = useOp();
  const row = result ?? a;
  const pending = row.status === "pending";
  const rest = Object.fromEntries(Object.entries(payload).filter(([k]) => !(pending && editKeys.includes(k))));

  const decide = (decision: "approve" | "reject") => run(decision, async () => {
    const changed = Object.fromEntries(Object.entries(edits).filter(([k, v]) => v !== payload[k]));
    const body = { decision, ...(decision === "approve" && Object.keys(changed).length ? { edits: changed } : {}) };
    const r = await apiJson<ActionRow | { action?: ActionRow }>(`/api/actions/${a.id}`, { method: "POST", body: JSON.stringify(body) });
    const next = r && typeof r === "object" && "action" in r && r.action ? r.action : (r as ActionRow);
    if (next && typeof next === "object" && "status" in next) setResult(next);
  }, () => { onDone(); notifyActionsChanged(); });

  return (
    <article className={`deck-card${pending ? " deck-card-hot" : ""}`}>
      <header className="deck-row">
        <span className="deck-label">#{a.id} · {kind?.label ?? a.kind}</span>
        <span className={`deck-pill deck-pill-${row.status}`}>{ACTION_STATUS[row.status] ?? row.status}</span>
      </header>
      <p className="deck-title">{a.summary}</p>
      <p className="deck-meta">{agentName(a.agent)} · {fmtTime(a.created_at)}{row.decided_at ? ` · rozhodnuto ${fmtTime(row.decided_at)}` : ""}</p>
      {pending && kind && (kind.ready === false || (typeof kind.ready === "string" && !!kind.ready)) && (
        <p className="deck-note deck-warn">{typeof kind.ready === "string" && kind.ready ? kind.ready : "Integrace pro tuto akci není připravená – provedení by selhalo. Zkontroluj záložku Integrace."}</p>
      )}

      {pending && editKeys.map((k) => {
        const id = `act-${a.id}-${k}`;
        const value = edits[k] ?? str(payload[k]);
        return (
          <label key={k} htmlFor={id} className="deck-field">
            <span className="deck-label">{EDITABLE[k].label}</span>
            {EDITABLE[k].long
              ? <textarea id={id} className="deck-input" rows={5} value={value} onChange={(e) => setEdits((m) => ({ ...m, [k]: e.target.value }))} />
              : <input id={id} className="deck-input" value={value} onChange={(e) => setEdits((m) => ({ ...m, [k]: e.target.value }))} />}
          </label>
        );
      })}
      {isVault && <VaultWriteView payload={payload} />}
      {isDeferred && <DeferredToolView payload={payload} />}
      {isRaqeto && Object.keys(rest).length > 0 && <FieldList data={rest} />}
      {!isVault && !isRaqeto && !isDeferred && Object.keys(rest).length > 0 && (
        <details className="deck-details" open={pending && editKeys.length === 0}>
          <summary>Data akce</summary>
          <pre className="deck-pre">{JSON.stringify(rest, null, 2)}</pre>
        </details>
      )}

      {pending ? (
        <div className="deck-row deck-actions">
          <button type="button" className="deck-btn deck-btn-gold" disabled={!!busy} onClick={() => void decide("approve")}>
            {busy === "approve" ? "Provádím…" : "Schválit"}
          </button>
          <button type="button" className="deck-btn" disabled={!!busy} onClick={() => void decide("reject")}>
            {busy === "reject" ? "…" : "Zamítnout"}
          </button>
        </div>
      ) : (
        <>
          {row.evidence && (
            <div className="deck-row deck-wrap">
              <p className="deck-note deck-ok deck-grow">Důkaz: <span className="deck-mono">{row.evidence}</span></p>
              <CopyButton text={row.evidence} label="Kopírovat důkaz" />
            </div>
          )}
          {row.error && <p className="deck-note deck-err">{row.error}</p>}
        </>
      )}
      {error && <p className="deck-note deck-err" role="alert">{error}</p>}
    </article>
  );
}

function ApprovalsTab({ reloadKey, onChanged }: { reloadKey: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useDeckData<{ actions?: ActionRow[]; kinds?: KindRow[] }>("/api/actions", reloadKey);
  const actions = useMemo(() => {
    const list = asList<ActionRow>(data, "actions");
    return list.slice().sort((x, y) => Number(y.status === "pending") - Number(x.status === "pending") || y.id - x.id);
  }, [data]);
  const kinds = useMemo(() => Object.fromEntries((data?.kinds ?? []).map((k) => [k.kind, k])), [data]);
  const pendingCount = actions.filter((a) => a.status === "pending").length;
  return (
    <div className="deck-stack">
      <p className="deck-note">
        {pendingCount ? `${pendingCount} ${pendingCount === 1 ? "návrh čeká" : pendingCount < 5 ? "návrhy čekají" : "návrhů čeká"} na tvoje rozhodnutí.` : "Nic nečeká na schválení."}
        {" "}Odeslání e-mailu, událost v kalendáři, příspěvek, zápis do AI Mozku nebo změna v Raqeto proběhne až po schválení.
      </p>
      <State loading={loading} error={error} empty={!actions.length} emptyText="Zatím žádné návrhy akcí." />
      {actions.map((a) => <ActionCard key={a.id} a={a} kind={kinds[a.kind]} onDone={() => { reload(); onChanged(); }} />)}
    </div>
  );
}

/* ─────────────────────────── Úlohy ─────────────────────────── */

type JobRow = { id: number; agent?: string; status?: string; source?: string; input?: string; output?: string; created_at?: string; finished_at?: string | null };

function JobsTab({ reloadKey }: { reloadKey: string }) {
  const [agent, setAgent] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const url = `/api/deck?section=jobs&limit=50${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`;
  const { data, error, loading } = useDeckData<unknown>(url, reloadKey);
  const jobs = asList<JobRow>(data, "jobs");
  return (
    <div className="deck-stack">
      <label className="deck-field deck-inline" htmlFor="deck-job-agent">
        <span className="deck-label">Agent</span>
        <select id="deck-job-agent" className="deck-input" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">Všichni</option>
          {ROSTER.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
        </select>
      </label>
      <State loading={loading} error={error} empty={!jobs.length} emptyText="Žádné úlohy." />
      <ul className="deck-list">
        {jobs.map((j) => {
          const expanded = open === j.id;
          return (
            <li key={j.id} className="deck-card">
              <button type="button" className="deck-rowbtn" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : j.id)}>
                <span className={`deck-dot deck-dot-${j.status ?? "x"}`} aria-hidden="true" />
                <span className="deck-grow deck-ellipsis">{j.input || `Úloha #${j.id}`}</span>
                <span className="deck-meta deck-none">{agentName(j.agent)} · {fmtTime(j.created_at)}</span>
              </button>
              {expanded && (
                <div className="deck-stack deck-pad">
                  <p className="deck-meta">#{j.id} · {j.status} · zdroj: {j.source || "–"}{j.finished_at ? ` · hotovo ${fmtTime(j.finished_at)}` : ""}</p>
                  <div className="deck-label">Zadání</div>
                  <p className="deck-text">{j.input}</p>
                  <div className="deck-row">
                    <div className="deck-label deck-grow">Výstup</div>
                    {j.output && <CopyButton text={j.output} label="Kopírovat výstup" />}
                  </div>
                  <p className="deck-text">{j.output || (j.status === "running" ? "Pracuje se na tom…" : "Bez výstupu.")}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ─────────────────────────── CRM ─────────────────────────── */

type ClientRow = { id: number; name?: string; company?: string; email?: string; phone?: string; notes?: string };
type LeadRow = { id: number; client_id?: number | null; client_name?: string; client?: string; title?: string; stage?: string; value?: number; currency?: string; next_step?: string; next_date?: string | null };
type PaymentRow = { id: number; client_id?: number | null; client_name?: string; amount?: number; currency?: string; paid_at?: string; note?: string };

const STAGES: { id: string; label: string }[] = [
  { id: "enquiry", label: "Poptávka" }, { id: "quote", label: "Nabídka" }, { id: "won", label: "Vyhráno" }, { id: "lost", label: "Prohráno" },
];
const money = (v?: number, cur = "CZK") => (typeof v === "number" ? `${v.toLocaleString("cs-CZ")} ${cur}` : "");

function LocalCrm({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading, reload } = useDeckData<{ clients?: ClientRow[]; leads?: LeadRow[]; payments?: PaymentRow[] }>("/api/deck?section=crm", reloadKey);
  const { busy, error: opError, run } = useOp();
  const clients = data?.clients ?? [];
  const leads = data?.leads ?? [];
  const payments = data?.payments ?? [];
  const clientName = (id?: number | null, fallback?: string) => fallback || clients.find((c) => c.id === id)?.name || "";
  const stages = [...STAGES, ...[...new Set(leads.map((l) => l.stage ?? ""))].filter((s) => s && !STAGES.some((x) => x.id === s)).map((s) => ({ id: s, label: s }))];

  return (
    <div className="deck-stack">
      <State loading={loading} error={error} empty={!data} emptyText="" />
      {opError && <p className="deck-note deck-err" role="alert">{opError}</p>}
      {data && (
        <>
          <h3 className="deck-h">Leady</h3>
          {!leads.length && <p className="deck-note">Žádné leady.</p>}
          {stages.map((st) => {
            const inStage = leads.filter((l) => (l.stage ?? "") === st.id);
            if (!inStage.length) return null;
            return (
              <section key={st.id} className="deck-stack">
                <div className="deck-label">{st.label} ({inStage.length})</div>
                {inStage.map((l) => (
                  <div key={l.id} className="deck-card deck-row deck-wrap">
                    <div className="deck-grow">
                      <div className="deck-title">{l.title}</div>
                      <div className="deck-meta">
                        {[clientName(l.client_id, l.client_name || l.client), money(l.value, l.currency), l.next_step, l.next_date].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <label className="visually-hidden" htmlFor={`lead-${l.id}`}>Fáze leadu {l.title}</label>
                    <select id={`lead-${l.id}`} className="deck-input deck-select-sm" value={l.stage ?? ""} disabled={busy === `lead-${l.id}`}
                      onChange={(e) => { const stage = e.target.value; void run(`lead-${l.id}`, () => deckOp("lead_stage", { id: l.id, stage }), reload); }}>
                      {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  </div>
                ))}
              </section>
            );
          })}

          <h3 className="deck-h">Klienti</h3>
          {!clients.length && <p className="deck-note">Žádní klienti.</p>}
          <ul className="deck-list">
            {clients.map((c) => (
              <li key={c.id} className="deck-card">
                <div className="deck-title">{c.name}{c.company ? ` – ${c.company}` : ""}</div>
                <div className="deck-meta">{[c.email, c.phone, c.notes].filter(Boolean).join(" · ")}</div>
              </li>
            ))}
          </ul>

          <h3 className="deck-h">Platby</h3>
          {!payments.length && <p className="deck-note">Žádné platby.</p>}
          <ul className="deck-list">
            {payments.map((p) => (
              <li key={p.id} className="deck-card deck-row deck-wrap">
                <span className="deck-title deck-grow">{money(p.amount, p.currency)}</span>
                <span className="deck-meta">{[clientName(p.client_id, p.client_name), p.paid_at, p.note].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

type RqProject = { id: string; name?: string; client_name?: string; status?: string; status_label?: string; deadline?: string | null; days_left?: number | null; budget_usage_pct?: number | null; tracked_hours?: number | null; budget_hours?: number | null };
type RqTask = {
  id: string; title?: string; name?: string; project_name?: string; client_name?: string; priority?: string; priority_label?: string;
  deadline?: string | null; status?: string; status_label?: string; overdue?: boolean; ai_state?: string; description?: string;
};
type RqClient = { id: string; name?: string; company?: string; email?: string; phone?: string; ico?: string; is_active?: boolean };
type RqInvoice = { id: string; number?: string; client_name?: string; project_name?: string; status?: string; status_label?: string; due_date?: string | null; issued_date?: string | null; total?: number; currency?: string; remaining?: number; remaining_czk?: number; overdue?: boolean };
type RqInteraction = { id: string; client_name?: string; project_name?: string; channel?: string; direction?: string; occurred_at?: string; from_display?: string; subject?: string; excerpt?: string; needs_reply?: boolean; replied_at?: string | null };
type RqSchedule = { id: string; task_title?: string; project_name?: string; completed?: boolean };
type RqTimer = { task_title?: string; description?: string; project_name?: string; started_at?: string; hours?: number };
type RqOverview = {
  configured?: boolean; ok?: boolean; base?: string; error?: string; errors?: string[]; workspace?: { name?: string } | null;
  counts?: Record<string, number>; projects?: RqProject[]; tasks?: RqTask[]; overdue_tasks?: RqTask[]; due_today?: RqTask[];
  schedule_today?: RqSchedule[]; running_timer?: RqTimer | null; running_timers?: number;
  invoices?: { unpaid_czk?: number; overdue_czk?: number; unpaid_count?: number; overdue_count?: number } | null; overdue_invoices?: RqInvoice[];
};

/* The only Raqeto web URL the API guide documents; deeper links are not specified. */
const RAQETO_WEB = "https://www.raqeto.com/dashboard/";
const fmtDate = (d?: string | null) => {
  if (!d) return "";
  const t = new Date(d.slice(0, 10) + "T00:00:00");
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
};
const czk = (v?: number | null, cur = "CZK") => (typeof v !== "number" ? "" : `${Math.round(v).toLocaleString("cs-CZ")} ${cur === "CZK" ? "Kč" : cur}`);
const daysLeft = (n?: number | null) => (typeof n !== "number" ? "" : n < 0 ? `${-n} d po termínu` : n === 0 ? "dnes" : `za ${n} d`);
const taskTitle = (t: RqTask) => t.title || t.name || "(bez názvu)";
const isUnpaid = (i: RqInvoice) => (i.remaining ?? 0) > 0;
const COUNT_LABEL: Record<string, string> = {
  open_tasks: "Otevřené úkoly", overdue_tasks: "Po termínu", due_today: "Termín dnes", due_this_week: "Termín tento týden", scheduled_today: "V plánu dnes",
  needs_reply: "Čeká na odpověď", unpaid_invoices: "Nezaplacené faktury", overdue_invoices: "Faktury po splatnosti", active_projects: "Aktivní projekty", over_budget: "Přes rozpočet",
};
const HOT_COUNTS = new Set(["overdue_tasks", "over_budget", "overdue_invoices", "needs_reply"]);

function RaqetoHint({ reason }: { reason?: string }) {
  return (
    <section className="deck-card deck-stack">
      <h3 className="deck-h">Připoj Raqeto CRM</h3>
      {reason && <p className="deck-note deck-err">{reason}</p>}
      <p className="deck-note">
        Raqeto je zdroj pravdy pro klienty, projekty, úkoly a hodiny. Doplň do <span className="deck-mono">.env.local</span>{" "}
        <span className="deck-mono">RAQETO_API_TOKEN=…</span> (a případně <span className="deck-mono">RAQETO_API_BASE=https://…/api/ai</span>) a restartuj server.
      </p>
    </section>
  );
}

function TaskMeta({ t }: { t: RqTask }) {
  return (
    <div className="deck-meta">
      {[t.project_name, t.client_name, t.priority_label || t.priority, t.deadline ? `${t.overdue ? "po termínu " : "termín "}${fmtDate(t.deadline)}` : "", t.status_label || t.status, t.ai_state && t.ai_state !== "none" ? `AI: ${t.ai_state}` : ""]
        .filter(Boolean).join(" · ")}
    </div>
  );
}

/* ── Dnes ── */

function TodayBlock({ ov }: { ov: RqOverview }) {
  const overdue = ov.overdue_tasks ?? [];
  const dueToday = (ov.due_today ?? []).filter((t) => !overdue.some((o) => o.id === t.id));
  const schedule = ov.schedule_today ?? [];
  const timer = ov.running_timer ?? null;
  const reply = ov.counts?.needs_reply ?? 0;
  const inv = ov.invoices;
  const empty = !overdue.length && !dueToday.length && !schedule.length && !timer && !reply && !inv?.unpaid_count;
  return (
    <section className="deck-card deck-stack">
      <h3 className="deck-h">Dnes</h3>
      {empty && <p className="deck-note">Na dnešek nic nehoří.</p>}
      {timer && (
        <p className="deck-note deck-warn">
          Běží časovač: {timer.task_title || timer.description || "bez popisu"}{timer.project_name ? ` · ${timer.project_name}` : ""}
          {timer.started_at ? ` · od ${fmtTime(timer.started_at)}` : ""}{(ov.running_timers ?? 0) > 1 ? ` (+${(ov.running_timers ?? 1) - 1} další)` : ""}
        </p>
      )}
      {(overdue.length > 0 || dueToday.length > 0) && (
        <div>
          <div className="deck-label">Po termínu ({overdue.length}) · termín dnes ({dueToday.length})</div>
          <ul className="deck-list deck-compact">
            {[...overdue, ...dueToday].slice(0, 8).map((t) => (
              <li key={t.id} className="deck-row">
                <span className={`deck-dot ${t.overdue ? "deck-dot-failed" : "deck-dot-running"}`} aria-hidden="true" />
                <span className="deck-grow deck-ellipsis deck-text">{taskTitle(t)}</span>
                <span className="deck-meta deck-none">{t.overdue && t.deadline ? fmtDate(t.deadline) : t.project_name}</span>
              </li>
            ))}
          </ul>
          {overdue.length + dueToday.length > 8 && <p className="deck-meta">…a další v záložce Úkoly.</p>}
        </div>
      )}
      {schedule.length > 0 && (
        <div>
          <div className="deck-label">Plán na dnes ({schedule.filter((s) => s.completed).length}/{schedule.length} hotovo)</div>
          <ul className="deck-list deck-compact">
            {schedule.slice(0, 10).map((s) => (
              <li key={s.id} className="deck-row">
                <span className={`deck-dot${s.completed ? " deck-dot-done" : ""}`} aria-hidden="true" />
                <span className="deck-grow deck-ellipsis deck-text" style={s.completed ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>{s.task_title}</span>
                <span className="deck-meta deck-none">{s.project_name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {reply > 0 && <p className="deck-note deck-warn">Čeká na odpověď: {reply} {reply === 1 ? "zpráva" : reply < 5 ? "zprávy" : "zpráv"} (záložka Komunikace).</p>}
      {!!inv?.unpaid_count && (
        <p className="deck-note">
          Nezaplacené faktury: {inv.unpaid_count} · {czk(inv.unpaid_czk)}
          {!!inv.overdue_count && <span className="deck-err"> · po splatnosti {inv.overdue_count} ({czk(inv.overdue_czk)})</span>}
        </p>
      )}
    </section>
  );
}

/* ── Úkoly ── */

/* The API route has no per-task detail, so the expanded row shows the list record. */
function TaskDetail({ t }: { t: RqTask }) {
  return (
    <div className="deck-stack deck-pad">
      {t.description ? <p className="deck-text">{htmlText(t.description)}</p> : <p className="deck-meta">Bez popisu.</p>}
    </div>
  );
}

function RqTasks({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading } = useDeckData<{ tasks?: RqTask[] }>("/api/raqeto?section=tasks", reloadKey);
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const all = asList<RqTask>(data, "tasks");
  const projects = useMemo(() => [...new Set(all.map((t) => t.project_name || ""))].filter(Boolean).sort((a, b) => a.localeCompare(b, "cs")), [all]);
  const statuses = useMemo(() => [...new Map(all.map((t) => [t.status ?? "", t.status_label || t.status || ""])).entries()].filter(([k]) => k), [all]);
  const tasks = useMemo(() => all
    .filter((t) => (!project || t.project_name === project) && (!status || t.status === status))
    .sort((x, y) => Number(!!y.overdue) - Number(!!x.overdue) || (x.deadline ?? "9999").localeCompare(y.deadline ?? "9999")), [all, project, status]);
  return (
    <div className="deck-stack">
      <div className="deck-row deck-wrap">
        <label className="visually-hidden" htmlFor="rq-task-project">Projekt</label>
        <select id="rq-task-project" className="deck-input deck-select-sm" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">Všechny projekty</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="visually-hidden" htmlFor="rq-task-status">Stav</label>
        <select id="rq-task-status" className="deck-input deck-select-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Všechny stavy</option>
          {statuses.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <span className="deck-meta">{tasks.length} úkolů</span>
      </div>
      <State loading={loading} error={error} empty={!tasks.length} emptyText="Žádné otevřené úkoly." />
      <ul className="deck-list deck-compact">
        {tasks.map((t) => {
          const expanded = open === t.id;
          return (
            <li key={t.id} className={`deck-card${t.overdue ? " deck-card-hot" : ""}`}>
              <button type="button" className="deck-rowbtn" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : t.id)}>
                <span className="deck-grow deck-min" style={{ textAlign: "left" }}>
                  <span className="deck-title" style={{ display: "block" }}>{taskTitle(t)}</span>
                  <TaskMeta t={t} />
                </span>
              </button>
              {expanded && <TaskDetail t={t} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Projekty ── */

function RqProjects({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading } = useDeckData<{ projects?: RqProject[] }>("/api/raqeto?section=projects", reloadKey);
  const projects = useMemo(() => asList<RqProject>(data, "projects").slice().sort((x, y) => (y.budget_usage_pct ?? -1) - (x.budget_usage_pct ?? -1)), [data]);
  return (
    <div className="deck-stack">
      <State loading={loading} error={error} empty={!projects.length} emptyText="Žádné aktivní projekty." />
      <ul className="deck-list deck-compact">
        {projects.map((p) => {
          const pct = typeof p.budget_usage_pct === "number" ? p.budget_usage_pct : null;
          const hours = typeof p.tracked_hours === "number" ? p.tracked_hours : null;
          const budget = p.budget_hours;
          return (
            <li key={p.id} className="deck-card deck-row deck-wrap">
              <div className="deck-grow deck-min">
                <div className="deck-title">{p.name}</div>
                <div className="deck-meta">
                  {[p.client_name, hours !== null ? `${hours.toLocaleString("cs-CZ")}${budget ? ` / ${budget.toLocaleString("cs-CZ")}` : ""} h` : "",
                    p.deadline ? `termín ${fmtDate(p.deadline)}${p.days_left != null ? ` (${daysLeft(p.days_left)})` : ""}` : ""].filter(Boolean).join(" · ")}
                </div>
              </div>
              {pct !== null && (
                <span className={`deck-pill ${pct > 100 ? "deck-pill-failed" : pct >= 80 ? "deck-pill-pending" : "deck-pill-executed"}`} title="Čerpání rozpočtu">{Math.round(pct)} %</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Klienti ── */

/* Search runs in Raqeto (all clients); without a query the first page is shown. */
function RqClients({ reloadKey }: { reloadKey: string }) {
  const [q, setQ] = useState("");
  const [needle, setNeedle] = useState("");
  useEffect(() => { const t = setTimeout(() => setNeedle(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  const { data, error, loading } = useDeckData<{ clients?: RqClient[] }>(`/api/raqeto?section=clients${needle ? `&search=${encodeURIComponent(needle)}` : ""}`, reloadKey);
  const clients = asList<RqClient>(data, "clients");
  return (
    <div className="deck-stack">
      <label className="visually-hidden" htmlFor="rq-client-q">Hledat klienta</label>
      <input id="rq-client-q" className="deck-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hledat klienta (jméno, firma, e-mail, IČO)" />
      <State loading={loading} error={error} empty={!clients.length} emptyText={needle ? "Nic nenalezeno." : "Žádní klienti."} />
      <ul className="deck-list deck-compact">
        {clients.map((c) => (
          <li key={c.id} className="deck-card">
            <div className="deck-title">{c.name}{c.company && c.company !== c.name ? ` – ${c.company}` : ""}</div>
            {(c.email || c.phone || c.ico) && <div className="deck-meta">{[c.email, c.phone, c.ico ? `IČO ${c.ico}` : ""].filter(Boolean).join(" · ")}</div>}
          </li>
        ))}
      </ul>
      {!needle && clients.length >= 50 && <p className="deck-meta">Zobrazeno prvních {clients.length} – pro ostatní použij hledání.</p>}
    </div>
  );
}

/* ── Faktury ── */

function RqInvoices({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading } = useDeckData<{ invoices?: RqInvoice[] }>("/api/raqeto?section=invoices", reloadKey);
  const invoices = useMemo(() => asList<RqInvoice>(data, "invoices").slice().sort((x, y) =>
    Number(!!y.overdue) - Number(!!x.overdue) || Number(isUnpaid(y)) - Number(isUnpaid(x)) || (y.issued_date ?? "").localeCompare(x.issued_date ?? "")), [data]);
  const unpaid = invoices.filter(isUnpaid);
  return (
    <div className="deck-stack">
      {unpaid.length > 0 && <p className="deck-note">Nezaplaceno v posledních {invoices.length} fakturách: {unpaid.length} · {czk(unpaid.reduce((s, i) => s + (i.remaining_czk ?? 0), 0))}</p>}
      <State loading={loading} error={error} empty={!invoices.length} emptyText="Žádné faktury." />
      <ul className="deck-list deck-compact">
        {invoices.slice(0, 100).map((i) => {
          const od = !!i.overdue;
          return (
            <li key={i.id} className={`deck-card deck-row deck-wrap${od ? " deck-card-hot" : ""}`}>
              <div className="deck-grow deck-min">
                <div className="deck-title">{i.number || "(koncept)"} · {i.client_name}</div>
                <div className="deck-meta">{[i.project_name, i.issued_date ? `vystaveno ${fmtDate(i.issued_date)}` : "", i.due_date ? `splatnost ${fmtDate(i.due_date)}` : ""].filter(Boolean).join(" · ")}</div>
              </div>
              <span className="deck-meta deck-none">{czk(i.total, i.currency || "CZK")}</span>
              <span className={`deck-pill ${od ? "deck-pill-failed" : isUnpaid(i) ? "deck-pill-pending" : "deck-pill-executed"}`}>{od ? "po splatnosti" : i.status_label || i.status}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Komunikace ── */

function RqInteractions({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading } = useDeckData<{ items?: RqInteraction[]; count?: number }>("/api/raqeto?section=interactions", reloadKey);
  const items = useMemo(() => asList<RqInteraction>(data, "items", "interactions").slice().sort((x, y) =>
    Number(!!y.needs_reply && !y.replied_at) - Number(!!x.needs_reply && !x.replied_at) || (y.occurred_at ?? "").localeCompare(x.occurred_at ?? "")), [data]);
  return (
    <div className="deck-stack">
      <p className="deck-note">Zprávy klientů, které čekají na tvoji odpověď{typeof data?.count === "number" ? ` (${data.count})` : ""}.</p>
      <State loading={loading} error={error} empty={!items.length} emptyText="Nic nečeká na odpověď." />
      <ul className="deck-list deck-compact">
        {items.slice(0, 60).map((i) => {
          const waiting = !!i.needs_reply && !i.replied_at;
          return (
            <li key={i.id} className={`deck-card${waiting ? " deck-card-hot" : ""}`}>
              <div className="deck-row deck-wrap">
                <span className="deck-title deck-grow deck-min">{i.subject || i.excerpt?.slice(0, 80) || "(bez předmětu)"}</span>
                {waiting && <span className="deck-pill deck-pill-pending">čeká na odpověď</span>}
              </div>
              <div className="deck-meta">{[i.client_name || i.from_display, i.project_name, i.channel, fmtTime(i.occurred_at)].filter(Boolean).join(" · ")}</div>
              {i.excerpt && i.subject && <p className="deck-text deck-ellipsis">{i.excerpt}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── AI fronta ── */

const RUN_STATUS: Record<string, { label: string; pill: string }> = {
  running: { label: "pracuje", pill: "deck-pill-pending" }, review: { label: "ke kontrole", pill: "deck-pill-executed" },
  failed: { label: "selhalo", pill: "deck-pill-failed" }, skipped: { label: "přeskočeno", pill: "" },
};

function AiQueue({ status, onChanged }: { status: ApexStatus | null; onChanged: () => void }) {
  const q = status?.raqetoQueue;
  const { busy, error, run } = useOp();
  if (!q) return <p className="deck-note">Stav fronty se načítá…</p>;
  return (
    <div className="deck-stack">
      <section className="deck-card deck-stack">
        <div className="deck-row deck-wrap">
          <h3 className="deck-h deck-grow">Fronta pro AI (AI Command Center)</h3>
          <span className={`deck-pill ${q.enabled ? "deck-pill-executed" : "deck-pill-pending"}`}>{q.enabled ? "zapnuto" : "vypnuto"}</span>
        </div>
        <p className="deck-note">
          Apex každou minutu převezme úkol, který jsi v Raqeto předal AI, zpracuje ho agentem a vrátí výsledek ke kontrole (nikdy ho sám neuzavře).
          {!q.enabled && " Zapneš ji tokenem RAQETO_API_TOKEN a bez RAQETO_AI_QUEUE=0."}
        </p>
        <p className="deck-meta">{q.lastPollAt ? `poslední kontrola ${fmtTime(q.lastPollAt)} · ve frontě ${q.queued}` : "Fronta se zatím nekontrolovala (spouští se se serverem)."}</p>
        {q.processing && (
          <p className="deck-note deck-warn">Právě zpracovává {agentName(q.processing.agent)}: „{q.processing.title}“ (od {fmtTime(q.processing.startedAt)})</p>
        )}
        {q.error && <p className="deck-note deck-err">{q.error}</p>}
        <div className="deck-row deck-actions">
          <button type="button" className="deck-btn deck-btn-gold" disabled={!q.enabled || !!q.processing || !!busy}
            onClick={() => void run("run", () => apiJson("/api/raqeto/queue", { method: "POST", body: JSON.stringify({ op: "run" }) }), onChanged)}>
            {busy === "run" ? "Spouštím…" : "Zpracovat frontu teď"}
          </button>
        </div>
        {error && <p className="deck-note deck-err" role="alert">{error}</p>}
      </section>
      <h3 className="deck-h">Poslední běhy</h3>
      {!q.recent.length && <p className="deck-note">Zatím žádné zpracované úkoly.</p>}
      <ul className="deck-list deck-compact">
        {q.recent.map((r) => (
          <li key={`${r.taskId}-${r.at}`} className="deck-card deck-stack">
            <div className="deck-row deck-wrap">
              <span className="deck-title deck-grow deck-min">{r.title}</span>
              <span className={`deck-pill ${RUN_STATUS[r.status]?.pill ?? ""}`}>{RUN_STATUS[r.status]?.label ?? r.status}</span>
            </div>
            <div className="deck-meta">{[agentName(r.agent), fmtTime(r.at), r.jobId ? `úloha #${r.jobId}` : ""].filter(Boolean).join(" · ")}</div>
            {(r.result || r.error) && <p className={`deck-text${r.error ? " deck-err" : ""}`}>{(r.error || r.result || "").slice(0, 300)}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── CRM tab ── */

type CrmView = "today" | "tasks" | "projects" | "clients" | "invoices" | "interactions" | "queue";
const CRM_VIEWS: { id: CrmView; label: string }[] = [
  { id: "today", label: "Přehled" }, { id: "tasks", label: "Úkoly" }, { id: "projects", label: "Projekty" }, { id: "clients", label: "Klienti" },
  { id: "invoices", label: "Faktury" }, { id: "interactions", label: "Komunikace" }, { id: "queue", label: "AI fronta" },
];

function CrmTab({ reloadKey, status, onChanged }: { reloadKey: string; status: ApexStatus | null; onChanged: () => void }) {
  const { data, error, loading } = useDeckData<RqOverview>("/api/raqeto?section=overview", reloadKey);
  const [view, setView] = useState<CrmView>("today");
  const [localOpen, setLocalOpen] = useState(false);
  const configured = data?.configured === true;
  const workspace = data?.workspace?.name || status?.raqeto?.workspace?.name;
  const queued = status?.raqetoQueue?.lastPollAt ? status.raqetoQueue.queued : 0;
  return (
    <div className="deck-stack">
      {loading && !data && !error && <p className="deck-note">Načítám…</p>}
      {(error || (data && !configured)) && <RaqetoHint reason={error && !/není k dispozici/.test(error) ? error : undefined} />}
      {configured && (
        <>
          <div className="deck-row deck-wrap">
            <div className="deck-grow deck-min">
              <div className="deck-title">Raqeto CRM{workspace ? ` · ${workspace}` : ""}</div>
              <div className="deck-meta">Jen pro čtení – změny dělá Apex nástroji nebo po tvém schválení.</div>
            </div>
            <a className="deck-btn deck-btn-sm" href={RAQETO_WEB} target="_blank" rel="noopener noreferrer">Otevřít Raqeto</a>
          </div>
          {data?.error && <p className="deck-note deck-err" role="alert">{data.error}</p>}
          {!!data?.errors?.length && <p className="deck-note deck-warn">Část dat se nenačetla: {data.errors.join("; ")}</p>}
          <div className="deck-row deck-wrap" role="tablist" aria-label="Sekce CRM">
            {CRM_VIEWS.map((v) => (
              <button key={v.id} type="button" role="tab" className="deck-tab" aria-selected={view === v.id} aria-current={view === v.id ? "page" : undefined} onClick={() => setView(v.id)}>
                {v.label}
                {v.id === "queue" && queued ? <span className="deck-badge" aria-label={`${queued} ve frontě`}>{queued}</span> : null}
              </button>
            ))}
          </div>
          {view === "today" && data && (
            <>
              {data.counts && (
                <div className="deck-kpis">
                  {Object.entries(data.counts).map(([k, v]) => (
                    <div key={k} className="deck-kpi">
                      <div className="deck-label">{COUNT_LABEL[k] ?? k.replace(/_/g, " ")}</div>
                      <div className={`deck-title${HOT_COUNTS.has(k) && v > 0 ? " deck-warn" : ""}`}>{v}</div>
                    </div>
                  ))}
                </div>
              )}
              <TodayBlock ov={data} />
            </>
          )}
          {view === "tasks" && <RqTasks reloadKey={reloadKey} />}
          {view === "projects" && <RqProjects reloadKey={reloadKey} />}
          {view === "clients" && <RqClients reloadKey={reloadKey} />}
          {view === "invoices" && <RqInvoices reloadKey={reloadKey} />}
          {view === "interactions" && <RqInteractions reloadKey={reloadKey} />}
          {view === "queue" && <AiQueue status={status} onChanged={onChanged} />}
        </>
      )}

      <details className="deck-details" onToggle={(e) => setLocalOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Lokální CRM (starší)</summary>
        {localOpen && <LocalCrm reloadKey={reloadKey} />}
      </details>
    </div>
  );
}

/* ─────────────────────────── Smyčky ─────────────────────────── */

type LoopRun = { id: number; period?: string; status?: string; started_at?: string; finished_at?: string | null; job_id?: number | null };
type LoopRow = { id: string; name?: string; agent?: string; prompt?: string; schedule?: string; enabled?: number | boolean; speak?: number | boolean; runs?: LoopRun[]; next_run?: string; nextRun?: string };

function LoopCard({ l, onChanged }: { l: LoopRow; onChanged: () => void }) {
  const [schedule, setSchedule] = useState(l.schedule ?? "");
  const [prompt, setPrompt] = useState(l.prompt ?? "");
  const { busy, error, run } = useOp();
  const enabled = !!l.enabled;
  const dirty = schedule !== (l.schedule ?? "") || prompt !== (l.prompt ?? "");
  useEffect(() => { setSchedule(l.schedule ?? ""); setPrompt(l.prompt ?? ""); }, [l.schedule, l.prompt]);
  return (
    <article className="deck-card deck-stack">
      <header className="deck-row deck-wrap">
        <div className="deck-grow">
          <div className="deck-title">{l.name || l.id}</div>
          <div className="deck-meta">{agentName(l.agent)}{(l.next_run || l.nextRun) ? ` · další běh ${fmtTime(l.next_run || l.nextRun)}` : ""}</div>
        </div>
        <button type="button" className={`deck-btn${enabled ? " deck-btn-cyan" : ""}`} aria-pressed={enabled} disabled={!!busy}
          onClick={() => void run("toggle", () => deckOp("loop_toggle", { id: l.id, enabled: !enabled }), onChanged)}>
          {enabled ? "Zapnuto" : "Vypnuto"}
        </button>
        <button type="button" className="deck-btn" aria-pressed={!!l.speak} disabled={!!busy}
          onClick={() => void run("speak", () => deckOp("loop_update", { id: l.id, speak: !l.speak }), onChanged)}>
          {l.speak ? "Mluví" : "Tiše"}
        </button>
      </header>
      <label className="deck-field" htmlFor={`loop-s-${l.id}`}>
        <span className="deck-label">Rozvrh (např. daily 08:00, weekly mon 09:00)</span>
        <input id={`loop-s-${l.id}`} className="deck-input deck-mono" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
      </label>
      <label className="deck-field" htmlFor={`loop-p-${l.id}`}>
        <span className="deck-label">Zadání</span>
        <textarea id={`loop-p-${l.id}`} className="deck-input" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="deck-row deck-actions">
        <button type="button" className="deck-btn deck-btn-gold" disabled={!dirty || !!busy}
          onClick={() => void run("save", () => deckOp("loop_update", { id: l.id, schedule, prompt }), onChanged)}>Uložit</button>
        <button type="button" className="deck-btn" disabled={!!busy}
          onClick={() => void run("run", () => deckOp("loop_run", { id: l.id }), onChanged)}>{busy === "run" ? "Spouštím…" : "Spustit teď"}</button>
      </div>
      {error && <p className="deck-note deck-err" role="alert">{error}</p>}
      {l.runs && l.runs.length > 0 && (
        <div>
          <div className="deck-label">Poslední běhy</div>
          <ul className="deck-list deck-compact">
            {l.runs.slice(0, 5).map((r) => (
              <li key={r.id} className="deck-row deck-meta">
                <span className={`deck-dot deck-dot-${r.status ?? "x"}`} aria-hidden="true" />
                <span className="deck-grow">{r.period}</span>
                <span>{r.status} · {fmtTime(r.started_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function LoopsTab({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading, reload } = useDeckData<unknown>("/api/deck?section=loops", reloadKey);
  const loops = asList<LoopRow>(data, "loops");
  return (
    <div className="deck-stack">
      <p className="deck-note">Smyčky jsou pravidelné úlohy (ranní brief, týdenní revize…), které agenti spouští sami.</p>
      <State loading={loading} error={error} empty={!loops.length} emptyText="Žádné smyčky." />
      {loops.map((l) => <LoopCard key={l.id} l={l} onChanged={reload} />)}
    </div>
  );
}

/* ─────────────────────────── Paměť ─────────────────────────── */

type VaultResult = { path: string; title?: string; snippet?: string; score?: number; abs?: string };
type VaultNote = { path: string; title?: string; body?: string; truncated?: boolean; abs?: string; frontmatter?: Record<string, unknown> };

const obsidianUrl = (abs?: string) => (abs ? `obsidian://open?path=${encodeURIComponent(abs)}` : undefined);

/* Semantic index state in words (shared by Paměť and Integrace). */
function semanticLabel(status: ApexStatus | null): { text: string; tone: "ok" | "warn" | "err" } {
  const sem = status?.semantic;
  if (!sem) return { text: "nedostupné", tone: "warn" };
  if (sem.ready) return { text: `připraveno (${sem.indexed?.vault ?? 0} poznámek v indexu)`, tone: "ok" };
  if (sem.error && !sem.indexing) return { text: `chyba: ${sem.error}`, tone: "err" };
  return { text: `indexuji ${sem.indexed?.vault ?? 0}/${status?.vault?.notes ?? "?"}`, tone: "warn" };
}

function VaultSection({ status }: { status: ApexStatus | null }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ mode?: string; results: VaultResult[] } | null>(null);
  const [note, setNote] = useState<VaultNote | null>(null);
  const { busy, error, run } = useOp();
  const vault = status?.vault;
  const sem = semanticLabel(status);
  return (
    <section className="deck-card deck-stack">
      <div className="deck-row">
        <h3 className="deck-h deck-grow">AI Mozek (Obsidian vault)</h3>
        <span className={`deck-pill ${vault?.configured ? "deck-pill-executed" : "deck-pill-pending"}`}>{vault?.configured ? `${vault.notes ?? 0} poznámek` : "nenalezen"}</span>
      </div>
      {vault?.configured
        ? <p className="deck-meta deck-mono">{vault.path}</p>
        : <p className="deck-note">Vault nebyl nalezen. Nastav <span className="deck-mono">APEX_VAULT_DIR</span> v <span className="deck-mono">.env.local</span> (výchozí ~/ai-mozek).</p>}
      <p className={`deck-note deck-${sem.tone}`}>Sémantické hledání: {sem.text}</p>
      {vault?.configured && (
        <form className="deck-row" role="search" onSubmit={(e) => {
          e.preventDefault();
          const query = q.trim();
          if (query.length < 2) return;
          void run("search", async () => {
            setNote(null);
            const r = await apiJson<{ mode?: string; results?: VaultResult[] }>(`/api/vault?q=${encodeURIComponent(query)}`);
            setRes({ mode: r.mode, results: r.results ?? [] });
          });
        }}>
          <label className="visually-hidden" htmlFor="vault-q">Hledat v AI Mozku</label>
          <input id="vault-q" className="deck-input deck-grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hledat v AI Mozku (např. XML feed Pima)" />
          <button type="submit" className="deck-btn deck-btn-gold" disabled={q.trim().length < 2 || !!busy}>{busy === "search" ? "Hledám…" : "Hledat"}</button>
        </form>
      )}
      {error && <p className="deck-note deck-err" role="alert">{error}</p>}
      {res && (
        <div className="deck-stack">
          <p className="deck-meta">{res.results.length ? `${res.results.length} výsledků · ${res.mode === "semantic" ? "podle významu" : "podle klíčových slov"}` : "Nic nenalezeno."}</p>
          <ul className="deck-list deck-compact">
            {res.results.map((r) => (
              <li key={r.path} className="deck-card deck-stack">
                <div className="deck-row deck-wrap">
                  <div className="deck-grow deck-min">
                    <div className="deck-title">{r.title || r.path}</div>
                    <div className="deck-meta deck-mono">{r.path}</div>
                  </div>
                  <button type="button" className="deck-btn deck-btn-sm" disabled={!!busy}
                    onClick={() => void run(`open-${r.path}`, async () => setNote(await apiJson<VaultNote>(`/api/vault?path=${encodeURIComponent(r.path)}`)))}>
                    {busy === `open-${r.path}` ? "…" : "Náhled"}
                  </button>
                  {r.abs && <a className="deck-btn deck-btn-sm" href={obsidianUrl(r.abs)}>Obsidian</a>}
                </div>
                {r.snippet && <p className="deck-text">{r.snippet}</p>}
                {note?.path === r.path && (
                  <div>
                    <div className="deck-label">Náhled{note.truncated ? " (zkráceno)" : ""}</div>
                    <pre className="deck-pre" style={{ maxHeight: 360 }}>{note.body}</pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

type FactRow = { id: number; subject?: string; fact?: string; source?: string; created_at?: string };

function MemoryTab({ reloadKey, status }: { reloadKey: string; status: ApexStatus | null }) {
  const { data, error, loading, reload } = useDeckData<unknown>("/api/deck?section=memory&limit=200", reloadKey);
  const facts = asList<FactRow>(data, "facts", "memory");
  const [subject, setSubject] = useState("");
  const [fact, setFact] = useState("");
  const [filter, setFilter] = useState("");
  const { busy, error: opError, run } = useOp();
  const q = filter.trim().toLowerCase();
  const shown = q ? facts.filter((f) => `${f.subject} ${f.fact}`.toLowerCase().includes(q)) : facts;
  return (
    <div className="deck-stack">
      <VaultSection status={status} />
      <h3 className="deck-h">Fakta v paměti Apexu</h3>
      <form className="deck-card deck-stack" onSubmit={(e) => {
        e.preventDefault();
        if (!fact.trim()) return;
        void run("add", () => deckOp("memory_add", { subject: subject.trim(), fact: fact.trim() }), () => { setSubject(""); setFact(""); reload(); });
      }}>
        <div className="deck-label">Nový fakt</div>
        <label className="deck-field" htmlFor="mem-subject">
          <span className="deck-label">Téma</span>
          <input id="mem-subject" className="deck-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="např. Klient Novák" />
        </label>
        <label className="deck-field" htmlFor="mem-fact">
          <span className="deck-label">Fakt</span>
          <textarea id="mem-fact" className="deck-input" rows={2} value={fact} onChange={(e) => setFact(e.target.value)} />
        </label>
        <div className="deck-row deck-actions">
          <button type="submit" className="deck-btn deck-btn-gold" disabled={!fact.trim() || !!busy}>Uložit do paměti</button>
        </div>
      </form>
      {opError && <p className="deck-note deck-err" role="alert">{opError}</p>}
      <label className="deck-field" htmlFor="mem-filter">
        <span className="deck-label">Hledat</span>
        <input id="mem-filter" className="deck-input" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <State loading={loading} error={error} empty={!facts.length} emptyText="Paměť je zatím prázdná." />
      <ul className="deck-list">
        {shown.map((f) => (
          <li key={f.id} className="deck-card deck-row">
            <div className="deck-grow">
              {f.subject && <div className="deck-label">{f.subject}</div>}
              <div className="deck-text">{f.fact}</div>
              <div className="deck-meta">{[f.source, fmtTime(f.created_at)].filter(Boolean).join(" · ")}</div>
            </div>
            <button type="button" className="deck-btn deck-btn-sm" aria-label={`Smazat fakt ${f.subject || f.id}`} disabled={busy === `del-${f.id}`}
              onClick={() => void run(`del-${f.id}`, () => deckOp("memory_delete", { id: f.id }), reload)}>Smazat</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────────────────────── Pokyny ─────────────────────────── */

type GuideVersion = { id: number; body?: string; created_at?: string };

function GuideTab({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading, reload } = useDeckData<{ current?: string | GuideVersion | null; versions?: GuideVersion[] }>("/api/deck?section=guide", reloadKey);
  const current = typeof data?.current === "string" ? data.current : data?.current?.body ?? "";
  const [body, setBody] = useState<string | null>(null);
  const { busy, error: opError, run } = useOp();
  const [saved, setSaved] = useState(false);
  const value = body ?? current;
  const versions = data?.versions ?? [];
  return (
    <div className="deck-stack">
      <p className="deck-note">Stálé pokyny, které Apex dostává v každé konverzaci (tón, pravidla, kontext firmy).</p>
      <State loading={loading} error={error} empty={!data} emptyText="" />
      <label className="deck-field" htmlFor="guide-body">
        <span className="deck-label">Pokyny</span>
        <textarea id="guide-body" className="deck-input deck-mono" rows={14} value={value} onChange={(e) => { setBody(e.target.value); setSaved(false); }} />
      </label>
      <div className="deck-row deck-actions">
        <button type="button" className="deck-btn deck-btn-gold" disabled={body === null || body === current || !!busy}
          onClick={() => void run("save", () => deckOp("guide_save", { body: value }), () => { setBody(null); setSaved(true); reload(); })}>
          {busy === "save" ? "Ukládám…" : "Uložit"}
        </button>
        {body !== null && body !== current && <button type="button" className="deck-btn" onClick={() => setBody(null)}>Zahodit změny</button>}
        {saved && <span className="deck-note deck-ok">Uloženo.</span>}
      </div>
      {opError && <p className="deck-note deck-err" role="alert">{opError}</p>}
      {versions.length > 0 && (
        <>
          <h3 className="deck-h">Verze</h3>
          <ul className="deck-list">
            {versions.map((v) => (
              <li key={v.id} className="deck-card deck-row">
                <div className="deck-grow deck-min">
                  <div className="deck-meta">#{v.id} · {fmtTime(v.created_at)}</div>
                  {v.body && <div className="deck-text deck-ellipsis">{v.body.slice(0, 160)}</div>}
                </div>
                <button type="button" className="deck-btn deck-btn-sm" disabled={!!busy}
                  onClick={() => void run(`restore-${v.id}`, () => deckOp("guide_restore", { id: v.id }), () => { setBody(null); reload(); })}>Obnovit</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ─────────────────────────── Integrace ─────────────────────────── */

const SOCIAL_LABEL: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };
const TTS_LABEL: Record<string, string> = { elevenlabs: "ElevenLabs (serverový hlas)", openai: "OpenAI (serverový hlas)", browser: "Hlas prohlížeče" };

function IntegrationsTab({ status, notice, onChanged, onEdit }: { status: ApexStatus | null; notice: string | null; onChanged: () => void; onEdit?: (group: string) => void }) {
  const { busy, error, run } = useOp();
  const g = status?.google;
  return (
    <div className="deck-stack">
      {notice && <p className={`deck-note ${notice.startsWith("Google účet připojen") ? "deck-ok" : "deck-err"}`} role="status">{notice}</p>}
      {!status && <p className="deck-note">Stav integrací se načítá…</p>}

      <section className="deck-card deck-stack">
        <div className="deck-row">
          <h3 className="deck-h deck-grow">Google (Gmail, Kalendář, Drive)</h3>
          <span className={`deck-pill ${g?.connected ? "deck-pill-executed" : "deck-pill-pending"}`}>{g?.connected ? "připojeno" : g?.configured ? "nepřipojeno" : "nenastaveno"}</span>
        </div>
        {g?.account && <p className="deck-meta">Účet: {g.account}</p>}
        {g?.error && <p className="deck-note deck-err">{g.error}</p>}
        {g && !g.configured && (
          <p className="deck-note">Nastav <span className="deck-mono">GOOGLE_CLIENT_ID</span> a <span className="deck-mono">GOOGLE_CLIENT_SECRET</span> v <span className="deck-mono">.env.local</span> a restartuj server.</p>
        )}
        <div className="deck-row deck-actions">
          {g?.configured && !g.connected && <a className="deck-btn deck-btn-gold" href="/api/integrations/google/start">Připojit Google</a>}
          {g?.connected && (
            <>
              <a className="deck-btn" href="/api/integrations/google/start">Připojit znovu</a>
              <button type="button" className="deck-btn" disabled={!!busy}
                onClick={() => void run("gd", () => apiJson("/api/integrations/google/disconnect", { method: "POST", body: "{}" }), onChanged)}>
                {busy === "gd" ? "Odpojuji…" : "Odpojit"}
              </button>
            </>
          )}
        {onEdit && <button type="button" className="deck-btn deck-btn-sm" onClick={() => onEdit("google")}>Upravit v Nastavení</button>}
        </div>
        {error && <p className="deck-note deck-err" role="alert">{error}</p>}
      </section>

      <section className="deck-card deck-stack">
        <h3 className="deck-h">Sociální sítě</h3>
        {Object.keys(SOCIAL_LABEL).map((k) => {
          const ok = !!status?.social?.[k]?.configured;
          return (
            <div key={k} className="deck-row">
              <span className="deck-grow">{SOCIAL_LABEL[k]}</span>
              <span className={`deck-pill ${ok ? "deck-pill-executed" : "deck-pill-pending"}`}>{ok ? "nastaveno" : "nenastaveno"}</span>
            </div>
          );
        })}
        <p className="deck-meta">Příspěvky se publikují jen po tvém schválení v záložce Schválení.</p>
        {onEdit && <div><button type="button" className="deck-btn deck-btn-sm" onClick={() => onEdit("social")}>Upravit v Nastavení</button></div>}
      </section>

      <section className="deck-card deck-stack">
        <div className="deck-row">
          <h3 className="deck-h deck-grow">AI Mozek (vault)</h3>
          <span className={`deck-pill ${status?.vault?.configured ? "deck-pill-executed" : "deck-pill-pending"}`}>{status?.vault?.configured ? "připojeno" : "nenalezen"}</span>
        </div>
        {status?.vault?.configured ? (
          <>
            <p className="deck-meta deck-mono">{status.vault.path}</p>
            <p className="deck-meta">{status.vault.notes ?? 0} poznámek · index: <span className={`deck-${semanticLabel(status).tone}`}>{semanticLabel(status).text}</span></p>
          </>
        ) : (
          <p className="deck-note">Nastav <span className="deck-mono">APEX_VAULT_DIR</span> v <span className="deck-mono">.env.local</span> (výchozí ~/ai-mozek).</p>
        )}
        <p className="deck-meta">Zápisy do vaultu jdou jen přes schválení (s přesným diffem) a commitují se do gitu vaultu.</p>
        {onEdit && <div><button type="button" className="deck-btn deck-btn-sm" onClick={() => onEdit("vault")}>Upravit v Nastavení</button></div>}
      </section>

      <section className="deck-card deck-stack">
        <div className="deck-row">
          <h3 className="deck-h deck-grow">Raqeto CRM</h3>
          <span className={`deck-pill ${!status?.raqeto?.configured ? "deck-pill-pending" : status.raqeto.ok === false ? "deck-pill-failed" : "deck-pill-executed"}`}>
            {!status?.raqeto?.configured ? "nenastaveno" : status.raqeto.ok === false ? "chyba" : status.raqeto.ok ? "připojeno" : "nastaveno"}
          </span>
        </div>
        {status?.raqeto?.workspace?.name && <p className="deck-meta">Workspace: {status.raqeto.workspace.name}</p>}
        {status?.raqeto?.base && <p className="deck-meta deck-mono">{status.raqeto.base}</p>}
        {!!status?.raqeto?.scopes?.length && <p className="deck-meta">Oprávnění: <span className="deck-mono">{status.raqeto.scopes.join(", ")}</span></p>}
        {status?.raqeto?.configured && (
          <p className="deck-meta">
            Fronta pro AI: {status.raqetoQueue?.enabled ? "zapnuto" : "vypnuto"}
            {status.raqetoQueue?.lastPollAt ? ` · poslední kontrola ${fmtTime(status.raqetoQueue.lastPollAt)}` : ""}
            {status.raqetoQueue?.processing ? ` · zpracovává „${status.raqetoQueue.processing.title}“` : ""}
          </p>
        )}
        {status?.raqeto?.error && <p className="deck-note deck-err">{status.raqeto.error}</p>}
        {status && !status.raqeto?.configured && (
          <p className="deck-note">Nastav <span className="deck-mono">RAQETO_API_TOKEN</span> (a případně <span className="deck-mono">RAQETO_API_BASE</span>) v <span className="deck-mono">.env.local</span> a restartuj server.</p>
        )}
        {onEdit && <div><button type="button" className="deck-btn deck-btn-sm" onClick={() => onEdit("raqeto")}>Upravit v Nastavení</button></div>}
      </section>

      <section className="deck-card deck-stack">
        <h3 className="deck-h">AI poskytovatelé</h3>
        {!status?.providers?.length && <p className="deck-note">Žádný poskytovatel nenalezen.</p>}
        {status?.providers?.map((p) => (
          <div key={p.id} className="deck-row">
            <span className="deck-grow">{p.label}</span>
            <span className="deck-meta">{p.kind === "api" ? "API klíč" : "předplatné"}{p.tools ? " · nástroje a agenti" : " · jen chat"}</span>
          </div>
        ))}
        {onEdit && <div><button type="button" className="deck-btn deck-btn-sm" onClick={() => onEdit("ai")}>Upravit v Nastavení</button></div>}
      </section>

      <section className="deck-card deck-row">
        <h3 className="deck-h deck-grow">Hlas (TTS)</h3>
        <span className="deck-meta">{TTS_LABEL[status?.tts ?? ""] ?? status?.tts ?? "–"}</span>
        {onEdit && <button type="button" className="deck-btn deck-btn-sm" onClick={() => onEdit("voice")}>Upravit v Nastavení</button>}
      </section>
    </div>
  );
}

/* ─────────────────────────── Log ─────────────────────────── */

const TOTAL_LABEL: Record<string, string> = { count: "Volání", ok: "V pořádku", failed: "Chyby", cost_usd: "Cena", avg_ms: "Průměr", last24h: "Za 24 h" };
function fmtTotal(k: string, v: unknown): string {
  if (typeof v !== "number") return str(v);
  if (k === "cost_usd") return `$${v.toFixed(2)}`;
  if (k.endsWith("_ms")) return `${(v / 1000).toFixed(1)} s`;
  return Number.isInteger(v) ? v.toLocaleString("cs-CZ") : v.toFixed(2);
}

type CallRow = { id: number; provider?: string; agent?: string; ms?: number; ok?: number | boolean; cost_usd?: number | null; error?: string; created_at?: string };

function LogTab({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading } = useDeckData<{ calls?: CallRow[]; totals?: Record<string, unknown> }>("/api/deck?section=calls&limit=100", reloadKey);
  const calls = asList<CallRow>(data, "calls");
  const totals = data && !Array.isArray(data) ? data.totals : undefined;
  return (
    <div className="deck-stack">
      {totals && typeof totals === "object" && (
        <div className="deck-kpis">
          {Object.entries(totals).filter(([, v]) => typeof v !== "object").map(([k, v]) => (
            <div key={k} className="deck-kpi">
              <div className="deck-label">{TOTAL_LABEL[k] ?? k}</div>
              <div className="deck-title">{fmtTotal(k, v)}</div>
            </div>
          ))}
        </div>
      )}
      <State loading={loading} error={error} empty={!calls.length} emptyText="Zatím žádná volání." />
      <ul className="deck-list deck-compact">
        {calls.map((c) => (
          <li key={c.id} className="deck-card deck-row deck-wrap deck-meta">
            <span className={`deck-dot deck-dot-${c.ok ? "done" : "failed"}`} aria-label={c.ok ? "v pořádku" : "chyba"} />
            <span className="deck-mono">{fmtTime(c.created_at)}</span>
            <span className="deck-grow">{c.provider} · {agentName(c.agent)}</span>
            <span className="deck-mono">{typeof c.ms === "number" ? `${(c.ms / 1000).toFixed(1)} s` : ""}</span>
            <span className="deck-mono">{typeof c.cost_usd === "number" ? `$${c.cost_usd.toFixed(4)}` : ""}</span>
            {c.error && <span className="deck-err deck-full">{c.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────────────────────── Drawer ─────────────────────────── */

export default function ApexDeck({ section, onSection, onClose, status, refreshKey, onChanged, onOpenSettings }: {
  section: DeckSection | null;
  onSection: (s: DeckSection) => void;
  onClose: () => void;
  status: ApexStatus | null;
  refreshKey: number;
  onChanged: () => void;
  onOpenSettings?: (group?: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = section !== null;

  // ?deck=section (and the Google OAuth result) → open the drawer, then clean the URL.
  useEffect(() => {
    const url = new URL(window.location.href);
    const target = toSection(url.searchParams.get("deck"));
    const google = url.searchParams.get("google");
    if (google === "connected") setNotice("Google účet připojen.");
    else if (google === "error") setNotice(`Připojení Googlu selhalo${url.searchParams.get("reason") ? `: ${url.searchParams.get("reason")}` : "."}`);
    if (target || google) onSection(target ?? "integrations");
    if (url.searchParams.has("deck") || google || url.searchParams.has("reason")) {
      // null state (not history.state) lets the app router adopt the new URL -
      // with its own state it would restore the param on its next update. Deferred
      // until after the router's own mount effect.
      const t = setTimeout(() => {
        const u = new URL(window.location.href);
        ["deck", "google", "reason"].forEach((k) => u.searchParams.delete(k));
        window.history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
      }, 0);
      return () => clearTimeout(t);
    }
  }, [onSection]);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") setTick((x) => x + 1); }, REFRESH_MS);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(t); window.removeEventListener("keydown", onKey); };
  }, [open, onClose]);

  // Focus the drawer on open; hand focus back to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, [open]);

  // Integrations read /api/status; refresh it with the drawer's own clock too.
  useEffect(() => { if (open && tick) onChanged(); }, [open, tick, onChanged]);

  // An approval decided in the chat dock → refetch the open tab.
  useEffect(() => {
    if (!open) return;
    const bump = () => setTick((x) => x + 1);
    window.addEventListener(ACTIONS_CHANGED, bump);
    return () => window.removeEventListener(ACTIONS_CHANGED, bump);
  }, [open]);

  if (!open) return null;
  const reloadKey = `${refreshKey}:${tick}`;
  const pending = status?.pendingActions ?? 0;

  return (
    <div className="deck" role="dialog" aria-modal="false" aria-labelledby="deck-title">
      <header className="deck-head">
        <h2 id="deck-title" className="deck-brand">Command Deck</h2>
        {onOpenSettings && (
          <button type="button" className="deck-btn deck-btn-sm" onClick={() => onOpenSettings()} title="Klíče, modely, hlas a integrace">
            <Settings size={14} aria-hidden="true" /> Nastavení
          </button>
        )}
        <button type="button" className="deck-icon" aria-label="Obnovit" title="Obnovit" onClick={() => { setTick((x) => x + 1); onChanged(); }}>
          <RefreshCw size={15} />
        </button>
        <button ref={closeRef} type="button" className="deck-icon" aria-label="Zavřít Command Deck" title="Zavřít (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <nav className="deck-tabs" aria-label="Sekce Command Decku">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="deck-tab" aria-current={section === t.id ? "page" : undefined} onClick={() => onSection(t.id)}>
            {t.label}
            {t.id === "approvals" && pending > 0 && <span className="deck-badge" aria-label={`${pending} čeká`}>{pending}</span>}
          </button>
        ))}
      </nav>
      <div className="deck-body">
        {section === "approvals" && <ApprovalsTab reloadKey={reloadKey} onChanged={onChanged} />}
        {section === "jobs" && <JobsTab reloadKey={reloadKey} />}
        {section === "crm" && <CrmTab reloadKey={reloadKey} status={status} onChanged={onChanged} />}
        {section === "loops" && <LoopsTab reloadKey={reloadKey} />}
        {section === "memory" && <MemoryTab reloadKey={reloadKey} status={status} />}
        {section === "guide" && <GuideTab reloadKey={reloadKey} />}
        {section === "integrations" && <IntegrationsTab status={status} notice={notice} onChanged={onChanged} onEdit={onOpenSettings} />}
        {section === "log" && <LogTab reloadKey={reloadKey} />}
      </div>
    </div>
  );
}
