"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, RefreshCw } from "lucide-react";
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

type ActionRow = { id: number; kind: string; summary: string; payload: string; agent: string; status: string; evidence?: string; error?: string; created_at?: string; decided_at?: string | null };
type KindRow = { kind: string; label: string; ready: boolean | string };  // true, or the reason it is not ready

const EDITABLE: Record<string, { label: string; long?: boolean }> = {
  to: { label: "Komu" }, cc: { label: "Kopie" }, subject: { label: "Předmět" },
  body: { label: "Text e-mailu", long: true }, text: { label: "Text", long: true },
  message: { label: "Zpráva", long: true }, caption: { label: "Popisek", long: true }, content: { label: "Obsah", long: true },
  summary: { label: "Název události" }, start: { label: "Začátek" }, end: { label: "Konec" },
  location: { label: "Místo" }, description: { label: "Popis", long: true },
};
const ACTION_STATUS: Record<string, string> = { pending: "čeká", approved: "schváleno", rejected: "zamítnuto", executed: "provedeno", failed: "selhalo" };

function parsePayload(p: unknown): Json {
  if (p && typeof p === "object") return p as Json;
  try { const v = JSON.parse(String(p)); return v && typeof v === "object" ? (v as Json) : { value: v }; } catch { return { value: str(p) }; }
}

/* A unified diff, +/- lines colored; read-only. */
function DiffBlock({ diff }: { diff: string }) {
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
function VaultWriteView({ payload }: { payload: Json }) {
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
function FieldList({ data }: { data: Json }) {
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

function ActionCard({ a, kind, onDone }: { a: ActionRow; kind?: KindRow; onDone: () => void }) {
  const payload = useMemo(() => parsePayload(a.payload), [a.payload]);
  const isVault = a.kind === "vault_write";
  const isRaqeto = a.kind.startsWith("raqeto_");
  const editKeys = isVault ? [] : Object.keys(payload).filter((k) => EDITABLE[k] && typeof payload[k] === "string");
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
  }, onDone);

  return (
    <article className={`deck-card${pending ? " deck-card-hot" : ""}`}>
      <header className="deck-row">
        <span className="deck-label">#{a.id} · {kind?.label ?? a.kind}</span>
        <span className={`deck-pill deck-pill-${row.status}`}>{ACTION_STATUS[row.status] ?? row.status}</span>
      </header>
      <p className="deck-title">{a.summary}</p>
      <p className="deck-meta">{agentName(a.agent)} · {fmtTime(a.created_at)}{row.decided_at ? ` · rozhodnuto ${fmtTime(row.decided_at)}` : ""}</p>
      {pending && kind && kind.ready !== true && (
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
      {isRaqeto && Object.keys(rest).length > 0 && <FieldList data={rest} />}
      {!isVault && !isRaqeto && Object.keys(rest).length > 0 && (
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
          {row.evidence && <p className="deck-note deck-ok">Důkaz: <span className="deck-mono">{row.evidence}</span></p>}
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
                  <div className="deck-label">Výstup</div>
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

type RqProject = { id: string; name?: string; client_name?: string; status?: string; deadline?: string | null; days_left?: number | null; budget_usage_pct?: number | null; tracked_hours?: number | null; budget_hours?: number | null };
type RqTask = { id: string; name?: string; project_name?: string; priority?: string; deadline?: string | null; status?: string; overdue?: boolean };
type RqClient = { id: string; name?: string; company?: string; email?: string; phone?: string; is_active?: boolean };
type RqOverview = { configured?: boolean; ok?: boolean; base?: string; error?: string; projects?: RqProject[]; tasks?: RqTask[]; counts?: Record<string, number> };

const fmtDate = (d?: string | null) => {
  if (!d) return "";
  const t = new Date(d.slice(0, 10) + "T00:00:00");
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
};
const daysLeft = (n?: number | null) => (typeof n !== "number" ? "" : n < 0 ? `${-n} d po termínu` : n === 0 ? "dnes" : `za ${n} d`);
const COUNT_LABEL: Record<string, string> = { active_projects: "Aktivní projekty", open_tasks: "Otevřené úkoly", overdue_tasks: "Po termínu", over_budget: "Přes rozpočet" };

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

function RaqetoClients({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading } = useDeckData<{ clients?: RqClient[]; error?: string }>("/api/raqeto?section=clients", reloadKey);
  const clients = asList<RqClient>(data, "clients");
  return (
    <>
      <h3 className="deck-h">Klienti ({clients.length})</h3>
      <State loading={loading} error={error} empty={!clients.length} emptyText="Žádní aktivní klienti." />
      <ul className="deck-list deck-compact">
        {clients.map((c) => (
          <li key={c.id} className="deck-card">
            <div className="deck-title">{c.name}{c.company && c.company !== c.name ? ` – ${c.company}` : ""}</div>
            {(c.email || c.phone) && <div className="deck-meta">{[c.email, c.phone].filter(Boolean).join(" · ")}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

function CrmTab({ reloadKey }: { reloadKey: string }) {
  const { data, error, loading } = useDeckData<RqOverview>("/api/raqeto?section=overview", reloadKey);
  const [localOpen, setLocalOpen] = useState(false);
  const configured = data?.configured === true;
  const projects = data?.projects ?? [];
  const tasks = useMemo(() => (data?.tasks ?? []).slice().sort((x, y) =>
    Number(!!y.overdue) - Number(!!x.overdue) || (x.deadline ?? "9999").localeCompare(y.deadline ?? "9999")), [data]);
  return (
    <div className="deck-stack">
      {loading && !data && !error && <p className="deck-note">Načítám…</p>}
      {(error || (data && !configured)) && <RaqetoHint reason={error && !/není k dispozici/.test(error) ? error : undefined} />}
      {configured && (
        <>
          <p className="deck-note">Zdroj pravdy: Raqeto CRM · jen pro čtení (změny navrhuje Apex ke schválení).</p>
          {data?.error && <p className="deck-note deck-err" role="alert">{data.error}</p>}
          {data?.counts && (
            <div className="deck-kpis">
              {Object.entries(data.counts).map(([k, v]) => (
                <div key={k} className="deck-kpi">
                  <div className="deck-label">{COUNT_LABEL[k] ?? k}</div>
                  <div className={`deck-title${(k === "overdue_tasks" || k === "over_budget") && v > 0 ? " deck-warn" : ""}`}>{v}</div>
                </div>
              ))}
            </div>
          )}

          <h3 className="deck-h">Aktivní projekty ({projects.length})</h3>
          {!projects.length && !data?.error && <p className="deck-note">Žádné aktivní projekty.</p>}
          <ul className="deck-list deck-compact">
            {projects.map((p) => {
              const pct = typeof p.budget_usage_pct === "number" ? p.budget_usage_pct : null;
              return (
                <li key={p.id} className="deck-card deck-row deck-wrap">
                  <div className="deck-grow deck-min">
                    <div className="deck-title">{p.name}</div>
                    <div className="deck-meta">{[p.client_name, p.deadline ? `termín ${fmtDate(p.deadline)}${p.days_left != null ? ` (${daysLeft(p.days_left)})` : ""}` : "bez termínu"].filter(Boolean).join(" · ")}</div>
                  </div>
                  {pct !== null && (
                    <span className={`deck-pill ${pct > 100 ? "deck-pill-failed" : pct >= 80 ? "deck-pill-pending" : "deck-pill-executed"}`} title="Čerpání rozpočtu">
                      {Math.round(pct)} %
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          <h3 className="deck-h">Otevřené úkoly ({tasks.length})</h3>
          {!tasks.length && !data?.error && <p className="deck-note">Žádné otevřené úkoly.</p>}
          <ul className="deck-list deck-compact">
            {tasks.map((t) => (
              <li key={t.id} className={`deck-card${t.overdue ? " deck-card-hot" : ""}`}>
                <div className="deck-title">{t.name}</div>
                <div className="deck-meta">
                  {[t.project_name, t.priority, t.deadline ? `${t.overdue ? "po termínu " : "termín "}${fmtDate(t.deadline)}` : "", t.status].filter(Boolean).join(" · ")}
                </div>
              </li>
            ))}
          </ul>

          <RaqetoClients reloadKey={reloadKey} />
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

function IntegrationsTab({ status, notice, onChanged }: { status: ApexStatus | null; notice: string | null; onChanged: () => void }) {
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
      </section>

      <section className="deck-card deck-stack">
        <div className="deck-row">
          <h3 className="deck-h deck-grow">Raqeto CRM</h3>
          <span className={`deck-pill ${!status?.raqeto?.configured ? "deck-pill-pending" : status.raqeto.ok === false ? "deck-pill-failed" : "deck-pill-executed"}`}>
            {!status?.raqeto?.configured ? "nenastaveno" : status.raqeto.ok === false ? "chyba" : status.raqeto.ok ? "připojeno" : "nastaveno"}
          </span>
        </div>
        {status?.raqeto?.base && <p className="deck-meta deck-mono">{status.raqeto.base}</p>}
        {status?.raqeto?.error && <p className="deck-note deck-err">{status.raqeto.error}</p>}
        {status && !status.raqeto?.configured && (
          <p className="deck-note">Nastav <span className="deck-mono">RAQETO_API_TOKEN</span> (a případně <span className="deck-mono">RAQETO_API_BASE</span>) v <span className="deck-mono">.env.local</span> a restartuj server.</p>
        )}
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
      </section>

      <section className="deck-card deck-row">
        <h3 className="deck-h deck-grow">Hlas (TTS)</h3>
        <span className="deck-meta">{TTS_LABEL[status?.tts ?? ""] ?? status?.tts ?? "–"}</span>
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

export default function ApexDeck({ section, onSection, onClose, status, refreshKey, onChanged }: {
  section: DeckSection | null;
  onSection: (s: DeckSection) => void;
  onClose: () => void;
  status: ApexStatus | null;
  refreshKey: number;
  onChanged: () => void;
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
      ["deck", "google", "reason"].forEach((k) => url.searchParams.delete(k));
      window.history.replaceState(window.history.state, "", url.pathname + (url.search || "") + url.hash);
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

  if (!open) return null;
  const reloadKey = `${refreshKey}:${tick}`;
  const pending = status?.pendingActions ?? 0;

  return (
    <div className="deck" role="dialog" aria-modal="false" aria-labelledby="deck-title">
      <header className="deck-head">
        <h2 id="deck-title" className="deck-brand">Command Deck</h2>
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
        {section === "crm" && <CrmTab reloadKey={reloadKey} />}
        {section === "loops" && <LoopsTab reloadKey={reloadKey} />}
        {section === "memory" && <MemoryTab reloadKey={reloadKey} status={status} />}
        {section === "guide" && <GuideTab reloadKey={reloadKey} />}
        {section === "integrations" && <IntegrationsTab status={status} notice={notice} onChanged={onChanged} />}
        {section === "log" && <LogTab reloadKey={reloadKey} />}
      </div>
    </div>
  );
}
