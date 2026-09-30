/* Raqeto CRM (the owner's main CRM) over its AI API at RAQETO_API_BASE with
 * the bearer token RAQETO_API_TOKEN from .env.local. Raqeto is the source of
 * truth for clients, projects, tasks, time, invoices, quotes, calendar,
 * schedule, e-mail drafts and client communication (AI Mozek SCHEMA §10).
 * Field names follow the live OpenAPI schema (/api/ai/schema.json). Every
 * write carries ?strict=1 so unknown / read-only fields fail loudly instead
 * of being dropped. The token is never returned, logged or cached anywhere
 * but process.env; errors are readable Czech sentences. Writes do the
 * SCHEMA §10 dedup check before any POST. No relative imports: unit-testable
 * as is. */

const DEFAULT_BASE = "https://www.raqeto.com/api/ai";
const TIMEOUT_MS = 20_000;
const MAX_ITEMS = 500;
const ME_TTL = 10 * 60_000;
const ME_ERR_TTL = 60_000;
const STATUS_TTL = 10 * 60_000;

type Obj = Record<string, any>;
type Query = Record<string, string | number | boolean | undefined | null>;
type Workspace = { id: string; name: string; slug: string | null };
type Me = { at: number; ok: boolean; workspace?: Workspace; scopes?: string[]; endpoints?: Record<string, string>; error?: string };
type TaskStatus = { id: string; slug: string; label: string; is_done: boolean; position: number };

const g = globalThis as { __apexRaqeto?: { me?: Me; statuses?: { at: number; rows: TaskStatus[] }; refreshing?: boolean } };
const cache = (g.__apexRaqeto ??= {});

export function raqetoBase(): string {
  return (process.env.RAQETO_API_BASE || DEFAULT_BASE).trim().replace(/\/+$/, "");
}
function token(): string {
  return (process.env.RAQETO_API_TOKEN || "").trim();
}
export function raqetoConfigured(): boolean {
  return !!token();
}
export const NOT_CONFIGURED = "Raqeto není nastavené – doplň RAQETO_API_TOKEN do .env.local a restartuj server.";

/* The token may only travel over https (plain http only to this machine). */
function safeBase(): URL {
  let u: URL;
  try { u = new URL(raqetoBase() + "/"); } catch { throw new Error("RAQETO_API_BASE není platná URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("RAQETO_API_BASE musí používat https.");
  return u;
}

function scrub(text: string): string {
  const t = token();
  return (t ? text.split(t).join("***") : text).replace(/raq_live_[A-Za-z0-9_-]+/g, "raq_live_***");
}

/* Error with the HTTP status and parsed body, so callers can branch on e.g.
 * 400 {existing_entry} or 409 without parsing messages. */
export class RaqetoError extends Error {
  readonly status: number;
  readonly data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = "RaqetoError";
    this.status = status;
    this.data = data;
  }
}

/* DRF error body → short readable detail (field errors or "detail"). */
function drfDetail(body: string): string {
  try {
    const j = JSON.parse(body);
    if (j?.error === "unknown_fields" && Array.isArray(j.fields)) return `neznámá nebo jen pro čtení pole: ${j.fields.join(", ")}`;
    if (typeof j?.detail === "string") return j.detail;
    if (typeof j?.error === "string") return j.error;
    if (j && typeof j === "object") {
      return Object.entries(j).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : JSON.stringify(v)}`).join("; ");
    }
  } catch { /* not JSON */ }
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function httpError(status: number, path: string, body: string): RaqetoError {
  const detail = drfDetail(body).slice(0, 300);
  let data: unknown = null;
  try { data = JSON.parse(body); } catch { /* not JSON */ }
  let msg: string;
  if (status === 401) msg = "Raqeto odmítlo přístupový token (401) – zkontroluj RAQETO_API_TOKEN v .env.local.";
  else if (status === 403) msg = `Raqeto: chybí oprávnění (403) ${path}${detail ? ` – ${detail}` : ""}. Scopes klíče ukáže raqeto_status.`;
  else if (status === 404) msg = `V Raqeto nenalezeno (404): ${path}.`;
  else if (status === 409) msg = `Raqeto změnu odmítlo – položka je v jiném stavu (409)${detail ? `: ${detail}` : ""}.`;
  else if (status === 429) msg = "Raqeto dočasně omezuje počet požadavků (429) – zkus to za chvíli.";
  else if (status >= 500) msg = `Raqeto má potíže na serveru (${status}) – zkus to později.`;
  else msg = `Raqeto požadavek selhal (${status}) ${path}${detail ? `: ${detail}` : ""}`;
  return new RaqetoError(scrub(msg), status, data);
}

/* Resolve a path ("/tasks/") or an absolute URL (DRF "next") against the base.
 * Absolute URLs must stay on the base origin, so the token never leaks. */
function resolveUrl(pathOrUrl: string, query?: Query): URL {
  const base = safeBase();
  let url: URL;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    url = new URL(pathOrUrl);
    if (url.origin !== base.origin) throw new Error("Raqeto vrátilo odkaz mimo svou doménu – požadavek zablokován.");
  } else {
    url = new URL(base.href + pathOrUrl.replace(/^\/+/, ""));
  }
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url;
}

/* Custom action endpoints (move/, send/, ai/claim/ …) document their body as
 * the model serializer; if strict mode ever rejects the action's own
 * parameters as unknown, the request is retried once without strict (a 400
 * from the strict check happens before anything is written). */
const ACTION_PATH = /\/(move|set-priority|approval|send|decide|stop|reorder|mark-replied|ai\/claim|ai\/finish)\/$/;

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export async function raqetoFetch<T = any>(
  pathOrUrl: string,
  opts: { method?: Method; body?: unknown; query?: Query; strict?: boolean } = {},
): Promise<T> {
  const t = token();
  if (!t) throw new Error(NOT_CONFIGURED);
  const method = opts.method ?? "GET";
  const strict = opts.strict ?? (method === "POST" || method === "PATCH");
  const url = resolveUrl(pathOrUrl, { ...opts.query, ...(strict ? { strict: 1 } : {}) });
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${t}`,
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new Error(`Raqeto neodpovědělo do ${TIMEOUT_MS / 1000} s.`);
    throw new Error(scrub(`Raqeto není dostupné: ${e instanceof Error ? e.message : String(e)}`));
  }
  const text = await res.text();
  if (!res.ok) {
    const err = httpError(res.status, url.pathname, text);
    if (strict && res.status === 400 && ACTION_PATH.test(url.pathname) && (err.data as Obj | null)?.error === "unknown_fields") {
      return raqetoFetch<T>(pathOrUrl, { ...opts, strict: false });
    }
    throw err;
  }
  if (!text) return null as T;
  try { return JSON.parse(text) as T; } catch { throw new Error(`Raqeto vrátilo neplatnou odpověď (${url.pathname}).`); }
}

/* Follow DRF pagination ("results"/"next"), at most `cap` (≤ 500) items in
 * pages of `pageSize` (default: all at once); `total` is the API's count
 * (null for plain arrays). */
export async function raqetoPage<T = any>(path: string, query: Query = {}, cap = MAX_ITEMS, pageSize = cap): Promise<{ items: T[]; total: number | null }> {
  const out: T[] = [];
  const limit = Math.max(1, Math.min(cap, MAX_ITEMS));
  let next: string | null = path;
  let first = true;
  let total: number | null = null;
  while (next && out.length < limit) {
    const page: any = await raqetoFetch(next, first ? { query: { ...query, page_size: Math.max(1, Math.min(pageSize, limit)) } } : {});
    if (first && page && typeof page.count === "number") total = page.count;
    first = false;
    const items: T[] = Array.isArray(page) ? page : Array.isArray(page?.results) ? page.results : [];
    out.push(...items);
    next = !Array.isArray(page) && typeof page?.next === "string" && page.next ? page.next : null;
  }
  return { items: out.slice(0, limit), total: total ?? out.length };
}

export async function raqetoList<T = any>(path: string, query: Query = {}, cap = MAX_ITEMS): Promise<T[]> {
  return (await raqetoPage<T>(path, query, cap)).items;
}

async function countOf(path: string, query: Query = {}): Promise<number> {
  const page = await raqetoFetch<Obj>(path, { query: { ...query, page_size: 1 } });
  return typeof page?.count === "number" ? page.count : Array.isArray(page?.results) ? page.results.length : 0;
}

/* ── status, discovery (/me/) ── */

export type RaqetoStatus = { configured: boolean; base: string; ok?: boolean; workspace?: Workspace; scopes?: string[]; error?: string };

function statusFrom(me: Me | undefined): RaqetoStatus {
  const configured = raqetoConfigured();
  const base = raqetoBase();
  if (!configured || !me) return { configured, base };
  return {
    configured, base, ok: me.ok,
    ...(me.workspace ? { workspace: me.workspace } : {}),
    ...(me.scopes ? { scopes: me.scopes } : {}),
    ...(me.error ? { error: me.error } : {}),
  };
}

/* Self-discovery: workspace, key scopes and endpoint map. The API root is 401
 * for AI keys, so /me/ is the ping. Cached (errors only briefly). */
export async function raqetoMe(force = false): Promise<Me | null> {
  if (!raqetoConfigured()) return null;
  const c = cache.me;
  if (!force && c && Date.now() - c.at < (c.ok ? ME_TTL : ME_ERR_TTL)) return c;
  try {
    const j = await raqetoFetch<Obj>("/me/");
    const endpoints: Record<string, string> = {};
    for (const [k, v] of Object.entries(j?.endpoints && typeof j.endpoints === "object" ? j.endpoints : {})) {
      if (typeof v === "string" && v.startsWith("/")) endpoints[k] = v;
    }
    cache.me = {
      at: Date.now(), ok: true,
      workspace: { id: str(j?.workspace?.id), name: str(j?.workspace?.name), slug: j?.workspace?.slug != null ? str(j.workspace.slug) : null },
      // A legacy key without scopes has full access; report that explicitly.
      scopes: Array.isArray(j?.key?.scopes) ? (j.key.scopes.length ? j.key.scopes.map(String) : ["read", "write"]) : [],
      endpoints,
    };
  } catch (e) {
    cache.me = { at: Date.now(), ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return cache.me;
}

/* Synchronous status for the Deck; refreshes a stale cache in the background. */
export function raqetoStatus(): RaqetoStatus {
  const me = cache.me;
  if (raqetoConfigured() && (!me || Date.now() - me.at >= (me.ok ? ME_TTL : ME_ERR_TTL)) && !cache.refreshing) {
    cache.refreshing = true;
    raqetoMe(true).catch(() => { /* stored in cache.me */ }).finally(() => { cache.refreshing = false; });
  }
  return statusFrom(me);
}

export async function raqetoPing(force = false): Promise<RaqetoStatus> {
  return statusFrom((await raqetoMe(force)) ?? undefined);
}

/* ── small helpers ── */

const idOf = (v: any): string | null => (v && typeof v === "object" ? (v.id != null ? String(v.id) : null) : v != null && v !== "" ? String(v) : null);
const num = (v: any): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
function str(v: any): string {
  return v == null ? "" : String(v);
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const enc = encodeURIComponent;
/* Decimal fields are strings in the API ("1.5"). */
const dec = (n: number, places = 2) => String(Number(n.toFixed(places)));

export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
}
/* Monday..Sunday of the week containing `day`. */
export function weekRange(day = localDate()): { from: string; to: string } {
  const dow = (new Date(`${day}T12:00:00`).getDay() + 6) % 7;
  const from = addDays(day, -dow);
  return { from, to: addDays(from, 6) };
}
const dayStartIso = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const dayEndIso = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();

export function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter((w) => w.length >= 2));
}

/* Same thing? Normalized equality, substring (≥ 5 chars) or token Jaccard ≥ 0.6. */
export function similarTitle(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length >= 5 && ` ${long} `.includes(` ${short} `)) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  const inter = [...ta].filter((w) => tb.has(w)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.6;
}

function appendText(existing: string, add: string): string {
  const e = existing.trim();
  const a = add.trim();
  if (!a || normalize(e).includes(normalize(a))) return e;
  return e ? `${e}\n\n${a}` : a;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
export function priorityRank(p: unknown): number {
  return PRIORITY_RANK[str(p)] ?? 2;
}

/* ── task statuses (per-workspace; is_done decides open vs. closed) ── */

export async function taskStatuses(force = false): Promise<TaskStatus[]> {
  if (!force && cache.statuses && Date.now() - cache.statuses.at < STATUS_TTL) return cache.statuses.rows;
  const rows = (await raqetoList<Obj>("/task-statuses/")).map((s) => ({
    id: str(s.id), slug: str(s.slug), label: str(s.label), is_done: s.is_done === true, position: num(s.position) ?? 0,
  })).sort((a, b) => a.position - b.position);
  cache.statuses = { at: Date.now(), rows };
  return rows;
}

async function doneSlugs(): Promise<Set<string>> {
  try {
    return new Set((await taskStatuses()).filter((s) => s.is_done).map((s) => s.slug));
  } catch {
    return new Set(["done"]);
  }
}

/* ── normalization (live schema field names) ── */

export function normClient(c: Obj) {
  return {
    id: str(c.id), name: str(c.name), company: str(c.company), ico: str(c.ico), dic: str(c.dic),
    email: str(c.email), phone: str(c.phone), address: str(c.address), notes: str(c.notes), is_active: c.is_active !== false,
  };
}

export function normProject(p: Obj) {
  return {
    id: str(p.id), name: str(p.name), status: str(p.status), status_label: str(p.status_display),
    client_id: idOf(p.client), client_name: str(p.client_name),
    deadline: p.deadline ? str(p.deadline) : null, hourly_rate: num(p.hourly_rate),
    budget_hours: num(p.budget_hours), budget_amount: num(p.budget_amount),
    tracked_hours: num(p.total_tracked_hours), budget_usage_pct: num(p.budget_usage_pct),
    description: str(p.description),
  };
}

export function normTask(t: Obj, today = localDate(), done: Set<string> = new Set(["done"])) {
  const deadline = t.deadline ? str(t.deadline).slice(0, 10) : null;
  const open = !done.has(str(t.status));
  return {
    id: str(t.id), title: str(t.title), status: str(t.status), status_label: str(t.status_display),
    priority: str(t.priority), priority_label: str(t.priority_display),
    deadline, start_date: t.start_date ? str(t.start_date) : null,
    project_id: idOf(t.project), project_name: str(t.project_name), client_name: str(t.client_name),
    assignee_id: t.assignee ?? null, assignee_name: str(t.assignee_name),
    estimated_hours: num(t.estimated_hours), tracked_hours: num(t.total_tracked_hours),
    approval_status: str(t.approval_status) || "none", ai_state: str(t.ai_state) || "none",
    description: str(t.description), open, overdue: open && !!deadline && deadline < today,
    updated_at: str(t.updated_at),
  };
}
export type RaqetoTask = ReturnType<typeof normTask>;

/* Task plus the AI Command Center fields (queue engineer). */
export function normAiTask(t: Obj, today = localDate(), done?: Set<string>) {
  return {
    ...normTask(t, today, done),
    ai_brief: str(t.ai_brief), ai_agent: str(t.ai_agent), ai_may_commit: t.ai_may_commit === true,
    ai_result: str(t.ai_result), ai_run_ref: str(t.ai_run_ref), ai_queued_at: t.ai_queued_at ?? null,
    ai_started_at: t.ai_started_at ?? null, ai_finished_at: t.ai_finished_at ?? null,
    project_repo_path: str(t.project_repo_path), approval_note: str(t.approval_note),
  };
}

export function normBrief(b: Obj) {
  return {
    id: str(b.id), project_id: idOf(b.project), project_name: str(b.project_name), title: str(b.title), content: str(b.content),
    task_ids: Array.isArray(b.task_ids) ? b.task_ids.map(String) : [], updated_at: str(b.updated_at),
  };
}

export function normTimeEntry(e: Obj) {
  let hours = num(e.duration_hours) ?? 0;
  if (e.is_running === true && e.started_at) hours = round2(Math.max(0, (Date.now() - Date.parse(e.started_at)) / 3_600_000));
  return {
    id: str(e.id), project_id: idOf(e.project), project_name: str(e.project_name), task_id: idOf(e.task), task_title: str(e.task_title),
    description: str(e.description), started_at: str(e.started_at), ended_at: e.ended_at ? str(e.ended_at) : null,
    hours, is_billable: e.is_billable !== false, is_invoiced: e.is_invoiced === true || !!e.invoice,
    is_running: e.is_running === true, user_name: str(e.user_name), tag_name: str(e.tag_name),
  };
}

export function normInvoice(i: Obj, today = localDate()) {
  const total = num(i.total) ?? 0;
  const paid = num(i.paid_amount) ?? 0;
  const totalCzk = num(i.total_czk) ?? total;
  const remaining = ["sent", "overdue"].includes(str(i.status)) ? Math.max(0, round2(total - paid)) : 0;
  const due = i.due_date ? str(i.due_date) : null;
  return {
    id: str(i.id), number: str(i.number), client_id: idOf(i.client), client_name: str(i.client_name),
    project_id: idOf(i.project), project_name: str(i.project_name), status: str(i.status), status_label: str(i.status_display),
    issued_date: i.issued_date ? str(i.issued_date) : null, due_date: due,
    total, currency: str(i.currency) || "CZK", total_czk: totalCzk, paid_amount: paid,
    remaining, remaining_czk: total ? round2((totalCzk * remaining) / total) : 0,
    overdue: str(i.status) === "overdue" || (str(i.status) === "sent" && !!due && due < today),
    approval_status: str(i.approval_status), has_pdf: i.has_pdf === true, variable_symbol: str(i.variable_symbol), notes: str(i.notes),
  };
}

export function normQuote(q: Obj) {
  return {
    id: str(q.id), client_id: idOf(q.client), client_name: str(q.client_name), project_id: idOf(q.project), project_name: str(q.project_name),
    task_id: idOf(q.task), title: str(q.title), body: str(q.body), amount: num(q.amount), currency: str(q.currency) || "CZK",
    amount_czk: num(q.amount_czk), status: str(q.status), sent_at: q.sent_at ?? null, decided_at: q.decided_at ?? null, decided_note: str(q.decided_note),
  };
}

export function normEvent(e: Obj) {
  return {
    id: str(e.id), title: str(e.title), description: str(e.description), location: str(e.location),
    start: str(e.start), end: str(e.end), all_day: e.all_day === true, category: str(e.category),
    project_id: idOf(e.project), project_name: str(e.project_name), client_id: idOf(e.client), client_name: str(e.client_name), task_id: idOf(e.task),
  };
}

export function normSchedule(s: Obj) {
  return {
    id: str(s.id), task_id: idOf(s.task), task_title: str(s.task_title), project_name: str(s.project_name), client_name: str(s.client_name),
    date: str(s.date), position: num(s.position) ?? 0, completed: s.completed === true,
  };
}

export function normEmail(m: Obj) {
  return {
    id: str(m.id), mode: str(m.mode), status: str(m.status), subject: str(m.subject), source_text: str(m.source_text),
    instructions: str(m.instructions), body: str(m.body), project_id: idOf(m.project), project_name: str(m.project_name),
    client_id: idOf(m.client), client_name: str(m.client_name), task_id: idOf(m.task), task_title: str(m.task_title),
    created_at: str(m.created_at), sent_at: m.sent_at ?? null,
  };
}

export function normInteraction(i: Obj) {
  return {
    id: str(i.id), client_id: idOf(i.client), client_name: str(i.client_name), project_id: idOf(i.project), project_name: str(i.project_name),
    task_id: idOf(i.task), channel: str(i.channel), direction: str(i.direction), external_id: i.external_id ?? null,
    occurred_at: str(i.occurred_at), from_display: str(i.from_display), from_address: str(i.from_address), subject: str(i.subject),
    excerpt: str(i.excerpt), body_url: str(i.body_url), attachments_count: num(i.attachments_count) ?? 0,
    needs_reply: i.needs_reply === true, replied_at: i.replied_at ?? null,
  };
}

export function normComment(c: Obj) {
  return {
    id: str(c.id), task_id: idOf(c.task), project_id: idOf(c.project), author_name: str(c.author_name), body: str(c.body),
    is_internal: c.is_internal === true, from_portal: c.from_portal === true, portal_user_name: str(c.portal_user_name),
    parent: idOf(c.parent), created_at: str(c.created_at),
  };
}

/* ── reads ── */

export async function search(q: string, types?: string[]) {
  const j = await raqetoFetch<Obj>("/search/", { query: { q, types: types?.length ? types.join(",") : undefined } });
  const rows: Obj[] = Array.isArray(j?.results) ? j.results : [];
  return rows.map((r) => ({ type: str(r.type), id: str(r.id), title: str(r.title), snippet: str(r.snippet) }));
}

export async function listClients(opts: { search?: string; includeArchived?: boolean; limit?: number } = {}) {
  const rows = await raqetoList("/clients/", { search: opts.search, is_active: opts.includeArchived ? undefined : "true", ordering: "name" }, opts.limit ?? MAX_ITEMS);
  return rows.map(normClient).filter((c) => opts.includeArchived || c.is_active);
}

export async function clientDetail(id: string) {
  const [client, billing, interactions, projects] = await Promise.all([
    raqetoFetch<Obj>(`/clients/${enc(id)}/`),
    raqetoFetch<Obj>(`/clients/${enc(id)}/billing-summary/`).catch(() => null),
    raqetoList<Obj>("/interactions/", { client: id, ordering: "-occurred_at" }, 10).catch(() => []),
    raqetoList<Obj>("/projects/", { client: id, ordering: "-updated_at" }, 100),
  ]);
  return {
    client: normClient(client),
    billing: billing ? { unbilled_amount: num(billing.unbilled_amount) ?? 0, currency: str(billing.currency) || "CZK" } : null,
    projects: projects.map(normProject).filter((p) => !p.client_id || p.client_id === id),
    recent_interactions: interactions.map(normInteraction).filter((i) => !i.client_id || i.client_id === id),
  };
}

export async function listProjects(opts: { status?: string; clientId?: string; search?: string; limit?: number } = {}) {
  const rows = await raqetoList("/projects/", { status: opts.status, client: opts.clientId, search: opts.search, ordering: "-updated_at" }, opts.limit ?? MAX_ITEMS);
  return rows.map(normProject).filter((p) => (!opts.status || p.status === opts.status) && (!opts.clientId || p.client_id === opts.clientId));
}

export type TaskFilter = {
  project?: string; status?: string; priority?: string; assignee?: number; deadlineFrom?: string; deadlineTo?: string;
  noProject?: boolean; aiState?: string; search?: string; openOnly?: boolean; includeArchived?: boolean; limit?: number;
};

/* Overdue first, then nearest deadline, then priority. */
export function sortTasks<T extends { overdue: boolean; priority: string; deadline: string | null }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")
    || priorityRank(a.priority) - priorityRank(b.priority));
}

export async function listTasks(f: TaskFilter = {}) {
  const [page, done] = await Promise.all([
    raqetoPage<Obj>("/tasks/", {
      project: f.project, status: f.status, priority: f.priority, assignee: f.assignee,
      deadline__gte: f.deadlineFrom, deadline__lte: f.deadlineTo, project__isnull: f.noProject ? "true" : undefined,
      ai_state: f.aiState, search: f.search, is_archived: f.includeArchived ? undefined : "false",
    }),
    doneSlugs(),
  ]);
  const today = localDate();
  // Unknown filters are silently ignored by the API, so re-check locally.
  const tasks = page.items.map((t) => normTask(t, today, done)).filter((t) =>
    (!f.project || t.project_id === f.project)
    && (!f.noProject || !t.project_id)
    && (!f.status || t.status === f.status)
    && (!f.priority || t.priority === f.priority)
    && (!f.aiState || t.ai_state === f.aiState)
    && (!f.deadlineFrom || (!!t.deadline && t.deadline >= f.deadlineFrom))
    && (!f.deadlineTo || (!!t.deadline && t.deadline <= f.deadlineTo))
    && (f.openOnly === false || !!f.status || t.open));
  const sorted = sortTasks(tasks);
  return { count: sorted.length, truncated: (page.total ?? 0) > page.items.length, tasks: sorted.slice(0, f.limit ?? 50) };
}

export async function taskDetail(id: string) {
  const [task, comments, history, done] = await Promise.all([
    raqetoFetch<Obj>(`/tasks/${enc(id)}/`),
    raqetoList<Obj>("/task-comments/", { task: id, ordering: "created_at" }, 100).catch(() => []),
    raqetoFetch<Obj[] | Obj>(`/tasks/${enc(id)}/history/`).catch(() => []),
    doneSlugs(),
  ]);
  const hist: Obj[] = Array.isArray(history) ? history : Array.isArray((history as Obj)?.results) ? (history as Obj).results : [];
  return {
    task: normAiTask(task, localDate(), done),
    comments: comments.map(normComment).filter((c) => !c.task_id || c.task_id === id),
    history: hist.slice(0, 20).map((h) => ({ field: str(h.field), old: h.old ?? null, new: h.new ?? null, actor_type: str(h.actor_type), created_at: str(h.created_at) })),
  };
}

export async function listBriefs(projectId: string) {
  const rows = await raqetoList("/briefs/", { project: projectId });
  return rows.map(normBrief).filter((b) => b.project_id === projectId);
}

export async function runningTimers() {
  const j = await raqetoFetch<Obj[] | Obj>("/time-entries/running/");
  const rows: Obj[] = Array.isArray(j) ? j : Array.isArray((j as Obj)?.results) ? (j as Obj).results : [];
  return rows.map(normTimeEntry);
}

function timeTotals(entries: ReturnType<typeof normTimeEntry>[]) {
  const sum = (xs: typeof entries) => round2(xs.reduce((s, e) => s + e.hours, 0));
  const byProject = new Map<string, { project_id: string | null; project_name: string; hours: number }>();
  for (const e of entries) {
    const key = e.project_id ?? "";
    const p = byProject.get(key) ?? { project_id: e.project_id, project_name: e.project_name, hours: 0 };
    p.hours = round2(p.hours + e.hours);
    byProject.set(key, p);
  }
  return {
    total_hours: sum(entries),
    billable_hours: sum(entries.filter((e) => e.is_billable)),
    non_billable_hours: sum(entries.filter((e) => !e.is_billable)),
    uninvoiced_billable_hours: sum(entries.filter((e) => e.is_billable && !e.is_invoiced)),
    by_project: [...byProject.values()].sort((a, b) => b.hours - a.hours),
  };
}

export async function timeEntries(opts: { from?: string; to?: string; project?: string; task?: string; runningOnly?: boolean } = {}) {
  if (opts.runningOnly) {
    const entries = await runningTimers();
    return { from: null, to: null, count: entries.length, truncated: false, ...timeTotals(entries), entries };
  }
  const to = opts.to ?? localDate();
  const from = opts.from ?? weekRange(to).from;
  const page = await raqetoPage<Obj>("/time-entries/", {
    project: opts.project, task: opts.task, started_at__gte: dayStartIso(from), started_at__lte: dayEndIso(to), ordering: "-started_at",
  });
  const entries = page.items.map(normTimeEntry).filter((e) => {
    const d = e.started_at ? localDate(new Date(e.started_at)) : "";
    return (!opts.project || e.project_id === opts.project) && (!opts.task || e.task_id === opts.task) && d >= from && d <= to;
  });
  return { from, to, count: entries.length, truncated: (page.total ?? 0) > page.items.length, ...timeTotals(entries), entries: entries.slice(0, 100) };
}

function invoiceTotals(invoices: ReturnType<typeof normInvoice>[]) {
  const byCurrency: Record<string, { total: number; remaining: number }> = {};
  for (const i of invoices) {
    const c = (byCurrency[i.currency] ??= { total: 0, remaining: 0 });
    c.total = round2(c.total + i.total);
    c.remaining = round2(c.remaining + i.remaining);
  }
  return {
    total_czk: round2(invoices.reduce((s, i) => s + i.total_czk, 0)),
    unpaid_czk: round2(invoices.reduce((s, i) => s + i.remaining_czk, 0)),
    overdue_czk: round2(invoices.filter((i) => i.overdue).reduce((s, i) => s + i.remaining_czk, 0)),
    unpaid_count: invoices.filter((i) => i.remaining > 0).length,
    overdue_count: invoices.filter((i) => i.overdue).length,
    by_currency: byCurrency,
  };
}

export async function listInvoices(opts: { status?: string; client?: string; unpaidOnly?: boolean; overdueOnly?: boolean; limit?: number } = {}) {
  const today = localDate();
  let rows: Obj[];
  let total: number | null;
  if (opts.unpaidOnly || opts.overdueOnly) {
    const [sent, overdue] = await Promise.all([
      raqetoPage<Obj>("/invoices/", { status: "sent", client: opts.client, ordering: "due_date" }),
      raqetoPage<Obj>("/invoices/", { status: "overdue", client: opts.client, ordering: "due_date" }),
    ]);
    rows = [...overdue.items, ...sent.items];
    total = (sent.total ?? 0) + (overdue.total ?? 0);
  } else {
    const page = await raqetoPage<Obj>("/invoices/", { status: opts.status, client: opts.client, ordering: "-issued_date" }, opts.limit ?? 100);
    rows = page.items;
    total = page.total;
  }
  const invoices = rows.map((i) => normInvoice(i, today)).filter((i) =>
    (!opts.status || i.status === opts.status) && (!opts.client || i.client_id === opts.client)
    && (!opts.unpaidOnly || i.remaining > 0) && (!opts.overdueOnly || i.overdue));
  return { count: invoices.length, total_in_raqeto: total, totals: invoiceTotals(invoices), invoices };
}

export async function listQuotes(opts: { status?: string; client?: string } = {}) {
  const rows = await raqetoList("/quotes/", { status: opts.status, client: opts.client, ordering: "-created_at" }, 200);
  return rows.map(normQuote).filter((q) => (!opts.status || q.status === opts.status) && (!opts.client || q.client_id === opts.client));
}

export async function listCalendar(from: string, to: string) {
  const rows = await raqetoList("/calendar-events/", { start__gte: dayStartIso(from), start__lte: dayEndIso(to), ordering: "start" });
  return rows.map(normEvent).filter((e) => {
    const d = e.start ? localDate(new Date(e.start)) : "";
    return d >= from && d <= to;
  });
}

export async function listSchedule(from: string, to: string) {
  const rows = await raqetoList("/schedule-entries/", { date__gte: from, date__lte: to, ordering: "date" });
  return rows.map(normSchedule).filter((s) => s.date >= from && s.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.position - b.position);
}

export async function listEmails(opts: { status?: string; client?: string; search?: string; limit?: number } = {}) {
  const rows = await raqetoList("/emails/", { status: opts.status, client: opts.client, search: opts.search, ordering: "-created_at" }, opts.limit ?? 50);
  return rows.map(normEmail).filter((m) => (!opts.status || m.status === opts.status) && (!opts.client || m.client_id === opts.client));
}

export async function listInteractions(opts: { needsReply?: boolean; unpaired?: boolean; client?: string; channel?: string; search?: string; limit?: number } = {}) {
  const page = await raqetoPage<Obj>("/interactions/", {
    needs_reply: opts.needsReply ? "true" : undefined, unpaired: opts.unpaired ? "1" : undefined,
    client: opts.client, channel: opts.channel, search: opts.search, ordering: "-occurred_at",
  }, opts.limit ?? 50);
  const items = page.items.map(normInteraction).filter((i) =>
    (!opts.needsReply || i.needs_reply) && (!opts.unpaired || !i.client_id)
    && (!opts.client || i.client_id === opts.client) && (!opts.channel || i.channel === opts.channel));
  return { count: page.total ?? items.length, items };
}

/* Today / this week at a glance. Sections fail independently (e.g. a missing
 * scope) and are reported in `errors`. */
export async function raqetoOverview() {
  const today = localDate();
  const week = weekRange(today);
  const errors: string[] = [];
  const safe = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try { return await p; } catch (e) { errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); return fallback; }
  };
  const [tasks, projects, running, schedule, needsReply, invoices] = await Promise.all([
    safe("úkoly", listTasks({ openOnly: true, limit: MAX_ITEMS }), { count: 0, truncated: false, tasks: [] as RaqetoTask[] }),
    safe("projekty", listProjects({ status: "active" }), []),
    safe("timer", runningTimers(), []),
    safe("rozvrh", listSchedule(today, today), []),
    safe("komunikace", countOf("/interactions/", { needs_reply: "true" }), 0),
    safe("faktury", listInvoices({ unpaidOnly: true }), null),
  ]);
  const open = tasks.tasks;
  const overdue = open.filter((t) => t.overdue);
  const dueToday = open.filter((t) => t.deadline === today);
  const dueWeek = open.filter((t) => !!t.deadline && t.deadline > today && t.deadline <= week.to);
  const dayMs = 86_400_000;
  const active = projects
    .map((p) => ({ ...p, days_left: p.deadline ? Math.round((Date.parse(p.deadline.slice(0, 10)) - Date.parse(today)) / dayMs) : null }))
    .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
  const inv = invoices?.totals;
  return {
    today, week,
    counts: {
      open_tasks: open.length, overdue_tasks: overdue.length, due_today: dueToday.length, due_this_week: dueWeek.length,
      scheduled_today: schedule.length, needs_reply: needsReply,
      unpaid_invoices: inv?.unpaid_count ?? 0, overdue_invoices: inv?.overdue_count ?? 0,
      active_projects: active.length, over_budget: active.filter((p) => (p.budget_usage_pct ?? 0) > 100).length,
    },
    running_timer: running[0] ?? null,
    running_timers: running.length,
    overdue_tasks: overdue.slice(0, 30),
    due_today: dueToday,
    due_this_week: dueWeek.slice(0, 30),
    open_tasks: open.slice(0, 60),
    schedule_today: schedule,
    invoices: inv ? { unpaid_czk: inv.unpaid_czk, overdue_czk: inv.overdue_czk, unpaid_count: inv.unpaid_count, overdue_count: inv.overdue_count } : null,
    overdue_invoices: invoices ? invoices.invoices.filter((i) => i.overdue).slice(0, 20) : [],
    projects: active,
    ...(errors.length ? { errors } : {}),
  };
}

/* ── AI Command Center queue ── */

/* Pages through the whole queue (200 per page, ≤ 500) so the code tasks the
 * worker skips can't hide the rest behind a single page. */
export async function aiQueueList(state: "queued" | "running" | "review" | "failed" | "done" = "queued", limit = MAX_ITEMS) {
  const [{ items: rows }, done] = await Promise.all([
    raqetoPage<Obj>("/tasks/", { ai_state: state, ordering: state === "queued" ? "ai_queued_at" : "-updated_at" }, limit, 200),
    doneSlugs(),
  ]);
  const today = localDate();
  return rows.map((t) => normAiTask(t, today, done)).filter((t) => t.ai_state === state);
}

/* 409 (RaqetoError.status) when the task is no longer queued. */
export async function aiClaim(taskId: string, runRef: string) {
  const t = await raqetoFetch<Obj>(`/tasks/${enc(taskId)}/ai/claim/`, { method: "POST", body: { run_ref: runRef } });
  return normAiTask(t ?? { id: taskId });
}

export async function aiFinish(taskId: string, p: { status: "review" | "failed" | "done"; result: string; run_ref?: string }) {
  const body: Obj = { status: p.status, result: p.result };
  if (p.run_ref) body.run_ref = p.run_ref;
  const t = await raqetoFetch<Obj>(`/tasks/${enc(taskId)}/ai/finish/`, { method: "POST", body });
  return normAiTask(t ?? { id: taskId });
}

/* ── direct writes (internal; dedup; never delete) ── */

type TaskInput = { title: string; description?: string; project?: string | null; deadline?: string | null; start_date?: string | null; estimated_hours?: number | null };

/* Open task in the same project (or without one) with a similar title. */
export async function findDuplicateTask(title: string, project?: string | null) {
  const { tasks } = await listTasks({ project: project || undefined, noProject: !project, openOnly: true, limit: MAX_ITEMS });
  return tasks.find((t) => similarTitle(t.title, title.trim())) ?? null;
}

/* The client portal (PortalTask) shows title, description, deadline,
 * estimate, status and tracked hours of every task in a client's project. */
export async function projectHasClient(projectId?: string | null): Promise<boolean> {
  if (!projectId) return false;
  const p = await raqetoFetch<Obj>(`/projects/${enc(projectId)}/`);
  return !!(idOf(p?.client) || str(p?.client_name));
}

/* What a write guard needs to know about a task: portal-visible? handled by
 * the coding agent (AI queue state or a project repository)? */
export async function taskExposure(id: string) {
  const task = normAiTask(await raqetoFetch<Obj>(`/tasks/${enc(id)}/`) ?? { id });
  const clientVisible = !!task.client_name || await projectHasClient(task.project_id);
  const codingAgent = (task.ai_state !== "none" && task.ai_state !== "") || !!task.project_repo_path;
  return { task, clientVisible, codingAgent };
}

export async function createTask(p: TaskInput & { priority?: string; status?: string; force_new?: boolean }) {
  const title = p.title.trim();
  const project = p.project || null;
  if (!p.force_new) {
    const dup = await findDuplicateTask(title, project);
    if (dup) {
      return {
        created: false, duplicate: true, id: dup.id, evidence: `Raqeto task ${dup.id} exists`, task: dup,
        hint: "Podobný otevřený úkol už existuje – doplň ho přes raqeto_task_update (append_description), nebo zopakuj s force_new=true, pokud jde opravdu o jinou práci.",
      };
    }
  }
  const body: Obj = { title };
  if (p.description) body.description = p.description;
  if (project) body.project = project;
  if (p.deadline) body.deadline = p.deadline;
  if (p.start_date) body.start_date = p.start_date;
  if (p.estimated_hours != null) body.estimated_hours = dec(p.estimated_hours);
  const created = await raqetoFetch<Obj>("/tasks/", { method: "POST", body });
  if (!created?.id) throw new Error("Raqeto nevrátilo id nového úkolu.");
  const id = str(created.id);
  const warnings: string[] = [];
  let task: Obj = created;
  // priority/status are read-only on the model; they have their own actions.
  if (p.priority) {
    try { task = await raqetoFetch<Obj>(`/tasks/${enc(id)}/set-priority/`, { method: "POST", body: { priority: p.priority } }) ?? task; }
    catch (e) { warnings.push(`Prioritu se nepodařilo nastavit: ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (p.status) {
    try { task = (await moveTask(id, p.status)).raw ?? task; }
    catch (e) { warnings.push(`Stav se nepodařilo nastavit: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { created: true, id, evidence: `Raqeto task ${id} created`, task: normTask({ ...created, ...task }), ...(warnings.length ? { warnings } : {}) };
}

export async function updateTask(id: string, p: Partial<TaskInput> & { append_description?: string }) {
  const body: Obj = {};
  if (p.title !== undefined) body.title = p.title.trim();
  if (p.append_description) {
    const current = await raqetoFetch<Obj>(`/tasks/${enc(id)}/`);
    body.description = appendText(p.description ?? str(current?.description), p.append_description);
  } else if (p.description !== undefined) body.description = p.description;
  if (p.deadline !== undefined) body.deadline = p.deadline || null;
  if (p.start_date !== undefined) body.start_date = p.start_date || null;
  if (p.estimated_hours !== undefined) body.estimated_hours = p.estimated_hours == null ? null : dec(p.estimated_hours);
  if (p.project !== undefined) body.project = p.project || null;
  if (!Object.keys(body).length) throw new Error("Není co měnit – zadej aspoň jedno pole.");
  const t = await raqetoFetch<Obj>(`/tasks/${enc(id)}/`, { method: "PATCH", body });
  return { updated: true, id, fields: Object.keys(body), evidence: `Raqeto task ${id} updated`, task: normTask(t ?? { id }) };
}

/* Resolve a slug / label / "__archived__" against the workspace statuses. */
export async function resolveStatus(input: string): Promise<string> {
  const v = input.trim();
  if (["__archived__", "archived", "archivovat", "archiv"].includes(normalize(v).replace(/ /g, "_")) || v === "__archived__") return "__archived__";
  const rows = await taskStatuses();
  const hit = rows.find((s) => s.slug === v || s.id === v) ?? rows.find((s) => normalize(s.label) === normalize(v) || normalize(s.slug) === normalize(v));
  if (!hit) throw new Error(`Neznámý stav „${v}“. Povolené: ${rows.map((s) => `${s.slug} (${s.label})`).join(", ")}, __archived__.`);
  return hit.slug;
}

export async function moveTask(id: string, newStatus: string) {
  const slug = await resolveStatus(newStatus);
  const raw = await raqetoFetch<Obj>(`/tasks/${enc(id)}/move/`, { method: "POST", body: { new_status: slug } });
  return { moved: true, id, status: slug, evidence: `Raqeto task ${id} moved to ${slug}`, raw, task: raw ? normTask(raw) : null };
}

export async function setTaskPriority(id: string, priority: string) {
  const p = priority.trim();
  if (!/^[a-z0-9_-]+$/i.test(p)) throw new Error("Priorita je slug (low, medium, high, urgent nebo vlastní slug workspace).");
  const t = await raqetoFetch<Obj>(`/tasks/${enc(id)}/set-priority/`, { method: "POST", body: { priority: p } });
  const now = str(t?.priority);
  return {
    updated: true, id, priority: now || p, evidence: `Raqeto task ${id} priority ${now || p}`,
    ...(now && now !== p ? { warning: `Raqeto uložilo prioritu „${now}“ místo „${p}“.` } : {}),
  };
}

export async function scheduleAdd(taskId: string, day: string, position?: number) {
  const body: Obj = { task: taskId, date: day };
  if (position !== undefined) body.position = position;
  try {
    const e = await raqetoFetch<Obj>("/schedule-entries/", { method: "POST", body });
    return { created: true, id: str(e?.id), evidence: `Raqeto schedule ${str(e?.id)} created`, entry: normSchedule(e ?? {}) };
  } catch (err) {
    const data = err instanceof RaqetoError && err.status === 400 ? (err.data as Obj | null) : null;
    const existing = data ? idOf(data.existing_entry) : null;
    if (!existing) throw err;
    if (position === undefined) {
      return { created: false, id: existing, evidence: `Raqeto schedule ${existing} exists`, note: "Úkol už je na tento den v rozvrhu." };
    }
    const e = await raqetoFetch<Obj>(`/schedule-entries/${enc(existing)}/`, { method: "PATCH", body: { position } });
    return { created: false, id: existing, evidence: `Raqeto schedule ${existing} updated`, entry: normSchedule(e ?? { id: existing }), note: "Úkol už v rozvrhu byl – upravena pozice." };
  }
}

export async function scheduleReorder(items: { id: string; position: number }[]) {
  const r = await raqetoFetch<Obj>("/schedule-entries/reorder/", { method: "POST", body: { items } });
  const updated = num(r?.updated) ?? 0;
  return {
    updated, requested: items.length, evidence: `Raqeto schedule reorder ${updated}/${items.length} updated`,
    ...(updated < items.length ? { warning: "Některé položky nebyly nalezeny (mimo workspace nebo neexistují)." } : {}),
  };
}

export type TimeLogInput = {
  project?: string; task?: string; resolve_task_title?: string; create_task?: boolean;
  started_at?: string; ended_at?: string; duration_hours?: number; description?: string; is_billable?: boolean;
};

/* Validation + exact-duplicate check without writing (also used by the
 * propose_raqeto_time_log approval before it is stored). */
export async function checkTimeLog(p: TimeLogInput) {
  if (!p.project && !p.task) throw new Error("Zadej projekt nebo úkol.");
  if (p.resolve_task_title && !p.project) throw new Error("resolve_task_title vyžaduje projekt.");
  const start = p.started_at ? new Date(p.started_at) : null;
  const end = p.ended_at ? new Date(p.ended_at) : null;
  if (start && Number.isNaN(start.getTime())) throw new Error("Neplatný začátek (started_at) – ISO datum a čas s časovou zónou.");
  if (end && Number.isNaN(end.getTime())) throw new Error("Neplatný konec (ended_at) – ISO datum a čas s časovou zónou.");
  if (end && !start) throw new Error("ended_at vyžaduje i started_at.");
  if (start && end && end < start) throw new Error("Konec je před začátkem.");
  const hours = p.duration_hours ?? (start && end ? round2((end.getTime() - start.getTime()) / 3_600_000) : null);
  if (hours == null || hours <= 0) throw new Error("Zadej duration_hours, nebo started_at + ended_at.");
  const day = localDate(start ?? new Date());
  // SCHEMA §10: refuse an exact duplicate (same day, same task/project, same duration).
  const sameDay = (await raqetoList<Obj>("/time-entries/", {
    project: p.project, task: p.task, started_at__gte: dayStartIso(day), started_at__lte: dayEndIso(day),
  })).map(normTimeEntry).filter((e) => e.started_at && localDate(new Date(e.started_at)) === day);
  const dup = sameDay.find((e) => Math.abs(e.hours - hours) < 0.01 && (
    p.task ? e.task_id === p.task
      : p.resolve_task_title ? e.project_id === p.project && normalize(e.task_title) === normalize(p.resolve_task_title)
        : e.project_id === p.project && !e.task_id));
  if (dup) throw new Error(`Duplicita: ${day} už existuje záznam ${hours} h na stejný úkol/projekt (id ${dup.id}). Pokud jde opravdu o další práci, uprav délku nebo popis v Raqeto.`);
  return { hours, start, end };
}

export async function logTime(p: TimeLogInput) {
  const { hours, start, end } = await checkTimeLog(p);
  const body: Obj = { duration_hours: dec(hours, 4), is_billable: p.is_billable ?? true };
  if (p.project) body.project = p.project;
  if (p.task) body.task = p.task;
  if (p.resolve_task_title) body.resolve_task_title = p.resolve_task_title;
  if (p.resolve_task_title && p.create_task) body.create_task = true;
  if (start) body.started_at = start.toISOString();
  if (end) body.ended_at = end.toISOString();
  if (p.description) body.description = p.description.slice(0, 512);
  const e = await raqetoFetch<Obj>("/time-entries/", { method: "POST", body });
  if (!e?.id) throw new Error("Raqeto nevrátilo id časového záznamu.");
  return { created: true, id: str(e.id), evidence: `Raqeto time_entry ${str(e.id)} created`, entry: normTimeEntry(e) };
}

export async function timerStart(p: { project?: string; task?: string; description?: string; is_billable?: boolean }) {
  if (!p.project && !p.task) throw new Error("Zadej projekt nebo úkol.");
  const running = await runningTimers();
  const same = running.find((e) => (p.task ? e.task_id === p.task : e.project_id === p.project && !e.task_id));
  if (same) return { created: false, id: same.id, evidence: `Raqeto time_entry ${same.id} running`, note: "Timer na tuto práci už běží.", entry: same };
  const body: Obj = { is_running: true, is_billable: p.is_billable ?? true };
  if (p.project) body.project = p.project;
  if (p.task) body.task = p.task;
  if (p.description) body.description = p.description.slice(0, 512);
  const e = await raqetoFetch<Obj>("/time-entries/", { method: "POST", body });
  if (!e?.id) throw new Error("Raqeto nevrátilo id timeru.");
  return {
    created: true, id: str(e.id), evidence: `Raqeto time_entry ${str(e.id)} started`, entry: normTimeEntry(e),
    ...(running.length ? { note: `Raqeto zastaví tvůj jiný běžící timer (${running.map((r) => r.id).join(", ")}) a dopočítá mu čas.` } : {}),
  };
}

export async function timerStop(id?: string) {
  let target = id;
  if (!target) {
    const running = await runningTimers();
    if (!running.length) throw new Error("Žádný timer neběží.");
    if (running.length > 1) throw new Error(`Běží víc timerů – zadej id: ${running.map((r) => `${r.id} (${r.project_name || r.task_title})`).join(", ")}.`);
    target = running[0].id;
  }
  const e = await raqetoFetch<Obj>(`/time-entries/${enc(target)}/stop/`, { method: "POST" });
  return { stopped: true, id: target, evidence: `Raqeto time_entry ${target} stopped`, entry: normTimeEntry(e ?? { id: target }) };
}

export type EventInput = {
  title?: string; start?: string; end?: string; all_day?: boolean; description?: string; location?: string;
  category?: "meeting" | "work_block" | "booking" | "personal" | "other"; project?: string | null; client?: string | null; task?: string | null;
};

function eventBody(p: EventInput): Obj {
  const body: Obj = {};
  for (const k of ["title", "description", "location", "category", "all_day"] as const) if (p[k] !== undefined) body[k] = p[k];
  for (const k of ["start", "end"] as const) {
    if (p[k] === undefined) continue;
    const d = new Date(p[k]!);
    if (Number.isNaN(d.getTime())) throw new Error(`Neplatné ${k} – ISO datum a čas.`);
    body[k] = d.toISOString();
  }
  for (const k of ["project", "client", "task"] as const) if (p[k] !== undefined) body[k] = p[k] || null;
  if (body.start && body.end && body.end < body.start) throw new Error("Konec události je před začátkem.");
  return body;
}

export async function calendarCreate(p: EventInput & { title: string; start: string; end: string }) {
  const body = eventBody(p);
  const day = localDate(new Date(body.start));
  const existing = (await listCalendar(day, day)).find((e) => Date.parse(e.start) === Date.parse(body.start) && normalize(e.title) === normalize(p.title));
  if (existing) return { created: false, id: existing.id, evidence: `Raqeto calendar ${existing.id} exists`, event: existing, note: "Stejná událost už v kalendáři je." };
  const e = await raqetoFetch<Obj>("/calendar-events/", { method: "POST", body });
  if (!e?.id) throw new Error("Raqeto nevrátilo id události.");
  return { created: true, id: str(e.id), evidence: `Raqeto calendar ${str(e.id)} created`, event: normEvent(e) };
}

export async function calendarUpdate(id: string, p: EventInput) {
  const body = eventBody(p);
  if (!Object.keys(body).length) throw new Error("Není co měnit – zadej aspoň jedno pole.");
  const e = await raqetoFetch<Obj>(`/calendar-events/${enc(id)}/`, { method: "PATCH", body });
  return { updated: true, id, fields: Object.keys(body), evidence: `Raqeto calendar ${id} updated`, event: normEvent(e ?? { id }) };
}

export async function emailDraftCreate(p: { mode: "reply" | "compose" | "rewrite"; source_text: string; subject?: string; instructions?: string; client?: string; project?: string; task?: string }) {
  const key = normalize(p.source_text).slice(0, 400);
  const recent = await raqetoList<Obj>("/emails/", { client: p.client, ordering: "-created_at" }, 100);
  const dup = recent.map(normEmail).find((m) => m.status !== "sent" && m.mode === p.mode && normalize(m.source_text).slice(0, 400) === key);
  if (dup) return { created: false, id: dup.id, evidence: `Raqeto email ${dup.id} exists`, status: dup.status, note: "Návrh pro stejný text už existuje – uprav ho přes raqeto_email_draft_update." };
  const body: Obj = { mode: p.mode, source_text: p.source_text };
  if (p.subject) body.subject = p.subject.slice(0, 255);
  if (p.instructions) body.instructions = p.instructions.slice(0, 255);
  if (p.client) body.client = p.client;
  if (p.project) body.project = p.project;
  if (p.task) body.task = p.task;
  const m = await raqetoFetch<Obj>("/emails/", { method: "POST", body });
  if (!m?.id) throw new Error("Raqeto nevrátilo id návrhu e-mailu.");
  return { created: true, id: str(m.id), evidence: `Raqeto email ${str(m.id)} created`, status: str(m.status) };
}

export async function emailDraftUpdate(id: string, p: { body?: string; subject?: string; instructions?: string }) {
  const cur = normEmail(await raqetoFetch<Obj>(`/emails/${enc(id)}/`));
  if (cur.status === "sent") throw new Error("Návrh už je označený jako odeslaný – neupravuje se.");
  const body: Obj = {};
  if (p.body !== undefined) body.body = p.body;
  if (p.subject !== undefined) body.subject = p.subject.slice(0, 255);
  if (p.instructions !== undefined) body.instructions = p.instructions.slice(0, 255);
  if (!Object.keys(body).length) throw new Error("Není co měnit – zadej body, subject nebo instructions.");
  await raqetoFetch<Obj>(`/emails/${enc(id)}/`, { method: "PATCH", body });
  return { updated: true, id, fields: Object.keys(body), evidence: `Raqeto email ${id} updated` };
}

export async function markInteractionReplied(p: { id?: string; channel?: string; external_id?: string }) {
  let channel = p.channel;
  let externalId = p.external_id;
  if (p.id) {
    const cur = normInteraction(await raqetoFetch<Obj>(`/interactions/${enc(p.id)}/`));
    if (!cur.needs_reply && cur.replied_at) return { updated: false, id: cur.id, evidence: `Raqeto interaction ${cur.id} already replied` };
    channel = cur.channel;
    externalId = cur.external_id ?? undefined;
    if (!externalId) {
      // Rows without external_id can't be addressed by mark-replied/.
      await raqetoFetch(`/interactions/${enc(cur.id)}/`, { method: "PATCH", body: { needs_reply: false, replied_at: new Date().toISOString() } });
      return { updated: true, id: cur.id, evidence: `Raqeto interaction ${cur.id} replied` };
    }
  }
  if (!channel || !externalId) throw new Error("Zadej id interakce, nebo channel + external_id.");
  const r = await raqetoFetch<Obj>("/interactions/mark-replied/", { method: "POST", body: { channel, external_id: externalId } });
  const id = str(r?.id) || p.id || externalId;
  return { updated: true, id, evidence: `Raqeto interaction ${id} replied` };
}

export async function addComment(p: { target: "task" | "project"; id: string; body: string; is_internal: boolean; parent?: string }) {
  const path = p.target === "task" ? "/task-comments/" : "/project-comments/";
  const existing = (await raqetoList<Obj>(path, { [p.target]: p.id }, 200)).map(normComment)
    .find((c) => (p.target === "task" ? c.task_id : c.project_id) === p.id && normalize(c.body) === normalize(p.body));
  if (existing) return { created: false, id: existing.id, evidence: `Raqeto ${p.target}_comment ${existing.id} exists` };
  const body: Obj = { [p.target]: p.id, body: p.body, is_internal: p.is_internal };
  if (p.parent) body.parent = p.parent;
  const c = await raqetoFetch<Obj>(path, { method: "POST", body });
  if (!c?.id) throw new Error("Raqeto nevrátilo id komentáře.");
  return { created: true, id: str(c.id), evidence: `Raqeto ${p.target}_comment ${str(c.id)} created${p.is_internal ? " (internal)" : ""}` };
}

/* ── briefs (SCHEMA §10: one live brief per project, content = work spec only) ── */

const BRIEF_TAGS = new Set(["h3", "p", "ul", "ol", "li", "strong", "em", "b", "i", "br", "code", "a"]);
export function briefContentProblem(html: string): string | null {
  if (!/<h3[\s>]/i.test(html)) return "Brief musí mít sekce ve tvaru <h3>N. Název</h3><p>Co a jak.</p>.";
  const bad = [...html.matchAll(/<\/?([a-z0-9]+)\b[^>]*>/gi)].map((m) => m[1].toLowerCase()).filter((t) => !BRIEF_TAGS.has(t));
  if (bad.length) return `Brief smí obsahovat jen <h3>, <p>, seznamy a zvýraznění – nepovolené značky: ${[...new Set(bad)].join(", ")}.`;
  if (/on\w+\s*=|javascript:/i.test(html)) return "Brief nesmí obsahovat skripty ani obsluhy událostí.";
  const badLink = [...html.matchAll(/<a\b([^>]*)>/gi)].some((m) => !/^\s+href\s*=\s*(?:"https:\/\/[^"\s<>]+"|'https:\/\/[^'\s<>]+')\s*$/i.test(m[1]));
  if (badLink) return "Odkaz v briefu jen jako <a href=\"https://…\"> (jiné adresy a atributy nejsou povolené).";
  if (/00-raw\/|[\w.+-]+@[\w-]+\.[\w.]+/i.test(html)) return "Brief je jen zadání práce – bez kontaktů, e-mailů a odkazů na raw soubory (ty patří do wiki).";
  return null;
}

function briefSections(html: string): { title: string; body: string }[] {
  return html.split(/(?=<h3[\s>])/i).map((chunk) => {
    const m = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*)/i);
    return m ? { title: m[1].replace(/<[^>]+>/g, "").replace(/^\s*\d+\.\s*/, "").trim(), body: m[2] } : { title: "", body: chunk };
  }).filter((s) => s.title || s.body.trim());
}

/* Append new sections (skip those whose heading already exists), numbering on. */
export function mergeBriefContent(existing: string, add: string): { content: string; added: number } {
  const have = briefSections(existing);
  const titles = have.map((s) => normalize(s.title)).filter(Boolean);
  const numbers = [...existing.matchAll(/<h3[^>]*>\s*(\d+)\./gi)].map((m) => Number(m[1]));
  let n = numbers.length ? Math.max(...numbers) : titles.length;
  let out = existing.trim();
  let added = 0;
  for (const s of briefSections(add)) {
    if (!s.title) {
      const body = s.body.trim();
      if (body && !normalize(out).includes(normalize(body))) { out += body; added += 1; }
      continue;
    }
    if (titles.includes(normalize(s.title))) continue;
    n += 1;
    added += 1;
    titles.push(normalize(s.title));
    out += `<h3>${n}. ${s.title}</h3>${s.body.trim()}`;
  }
  return { content: out, added };
}

export async function upsertBrief(p: { project_id: string; content_html: string; task_ids?: string[]; title?: string }) {
  const problem = briefContentProblem(p.content_html);
  if (problem) throw new Error(problem);
  const briefs = await listBriefs(p.project_id);
  const newIds = (p.task_ids ?? []).map(String);
  if (briefs.length) {
    const b = briefs[0];
    const { content, added } = mergeBriefContent(b.content, p.content_html);
    const task_ids = [...new Set([...b.task_ids, ...newIds])];
    const newTasks = task_ids.length - b.task_ids.length;
    if (!added && !newTasks) return { created: false, id: b.id, evidence: `Raqeto brief ${b.id} unchanged`, note: "Vše už v briefu je." };
    await raqetoFetch(`/briefs/${enc(b.id)}/`, { method: "PATCH", body: { content, task_ids } });
    return { created: false, id: b.id, evidence: `Raqeto brief ${b.id} updated`, added_sections: added, added_tasks: newTasks };
  }
  let title = p.title?.trim() || "";
  if (!title) {
    try { title = str((await raqetoFetch<Obj>(`/projects/${enc(p.project_id)}/`))?.name); } catch { /* fall back below */ }
    title = title ? `${title} – zadání` : "Zadání";
  }
  const created = await raqetoFetch<Obj>("/briefs/", { method: "POST", body: { project: p.project_id, title: title.slice(0, 255), content: p.content_html.trim(), task_ids: newIds } });
  if (!created?.id) throw new Error("Raqeto nevrátilo id nového briefu.");
  return { created: true, id: str(created.id), evidence: `Raqeto brief ${str(created.id)} created` };
}

/* ── approved writes (execute() of defineAction; return evidence strings) ── */

export async function upsertClient(p: { name: string; company?: string; ico?: string; dic?: string; email?: string; phone?: string; address?: string; notes?: string }): Promise<string> {
  const ico = p.ico?.replace(/\s/g, "") || "";
  let match: Obj | null = null;
  if (ico) {
    // /clients/ has no ico filter; search covers it, then match exactly.
    match = (await raqetoList<Obj>("/clients/", { search: ico })).find((c) => str(c.ico).replace(/\s/g, "") === ico) ?? null;
  }
  if (!match) {
    const found = await raqetoList<Obj>("/clients/", { search: p.name });
    // A name match with a different IČO is a different company.
    match = found.find((c) => similarTitle(str(c.name), p.name) && (!ico || !str(c.ico).trim() || str(c.ico).replace(/\s/g, "") === ico)) ?? null;
  }
  const fields: Obj = { company: p.company?.trim(), ico, dic: p.dic?.trim(), email: p.email?.trim(), phone: p.phone?.trim(), address: p.address?.trim() };
  if (match) {
    const id = str(match.id);
    // Fill only what is missing; never overwrite IČO/DIČ/address/contacts already in CRM.
    const patch: Obj = {};
    for (const [k, v] of Object.entries(fields)) if (v && !str(match[k]).trim()) patch[k] = v;
    if (p.notes?.trim()) {
      const notes = appendText(str(match.notes), p.notes);
      if (notes !== str(match.notes).trim()) patch.notes = notes;
    }
    const reactivated = match.is_active === false;
    if (reactivated) patch.is_active = true;
    if (!Object.keys(patch).length) return `Raqeto client ${id} unchanged – „${str(match.name)}“ už existuje`;
    await raqetoFetch(`/clients/${enc(id)}/`, { method: "PATCH", body: patch });
    return `Raqeto client ${id} updated – „${str(match.name)}“${reactivated ? ", znovu aktivován" : ""}; doplněno: ${Object.keys(patch).filter((k) => k !== "is_active").join(", ") || "nic"}`;
  }
  const body: Obj = { name: p.name.trim(), is_active: true };
  for (const [k, v] of Object.entries(fields)) if (v) body[k] = v;
  if (p.notes?.trim()) body.notes = p.notes.trim();
  const created = await raqetoFetch<Obj>("/clients/", { method: "POST", body });
  if (!created?.id) throw new Error("Raqeto nevrátilo id nového klienta.");
  return `Raqeto client ${created.id} created – „${p.name.trim()}“`;
}

export type ProjectInput = {
  project_id?: string; name: string; client?: string; description?: string; status?: "active" | "on_hold" | "completed" | "archived";
  hourly_rate?: number; budget_hours?: number; budget_amount?: number; deadline?: string;
};

export async function upsertProject(p: ProjectInput): Promise<string> {
  const fields: Obj = {};
  if (p.client) fields.client = p.client;
  if (p.status) fields.status = p.status;
  if (p.hourly_rate != null) fields.hourly_rate = dec(p.hourly_rate);
  if (p.budget_hours != null) fields.budget_hours = dec(p.budget_hours);
  if (p.budget_amount != null) fields.budget_amount = dec(p.budget_amount);
  if (p.deadline) fields.deadline = p.deadline;
  let match: Obj | null = null;
  if (p.project_id) match = await raqetoFetch<Obj>(`/projects/${enc(p.project_id)}/`);
  else {
    const found = await raqetoList<Obj>("/projects/", { client: p.client, search: p.name });
    match = found.find((x) => (!p.client || idOf(x.client) === p.client) && similarTitle(str(x.name), p.name)) ?? null;
  }
  if (match) {
    const id = str(match.id);
    const patch: Obj = { ...fields };
    if (p.project_id && p.name.trim() && p.name.trim() !== str(match.name)) patch.name = p.name.trim();
    if (p.description?.trim()) {
      const d = appendText(str(match.description), p.description);
      if (d !== str(match.description).trim()) patch.description = d;
    }
    for (const k of Object.keys(patch)) if (k !== "description" && str(patch[k]) === str(match[k])) delete patch[k];
    if (!Object.keys(patch).length) return `Raqeto project ${id} unchanged – „${str(match.name)}“ už existuje`;
    await raqetoFetch(`/projects/${enc(id)}/`, { method: "PATCH", body: patch });
    return `Raqeto project ${id} updated – „${str(match.name)}“; změněno: ${Object.keys(patch).join(", ")}`;
  }
  const body: Obj = { name: p.name.trim(), status: p.status ?? "active", ...fields };
  if (p.description?.trim()) body.description = p.description.trim();
  const created = await raqetoFetch<Obj>("/projects/", { method: "POST", body });
  if (!created?.id) throw new Error("Raqeto nevrátilo id nového projektu.");
  return `Raqeto project ${created.id} created – „${p.name.trim()}“`;
}

export async function commentEvidence(p: { target: "task" | "project"; id: string; body: string; is_internal: boolean; parent?: string }): Promise<string> {
  return (await addComment(p)).evidence;
}

export type InvoiceInput = {
  client: string; project?: string; task?: string; issued_date?: string; due_date: string; period_from?: string; period_to?: string;
  tax_rate?: number; currency?: string; variable_symbol?: string; notes?: string;
};

export async function invoiceCreate(p: InvoiceInput): Promise<string> {
  const drafts = (await raqetoList<Obj>("/invoices/", { status: "draft", client: p.client })).map((i) => ({ raw: i, n: normInvoice(i) }));
  const dup = drafts.find(({ raw, n }) => n.client_id === p.client && n.project_id === (p.project ?? null)
    && str(raw.period_from) === str(p.period_from ?? "") && str(raw.period_to) === str(p.period_to ?? ""));
  if (dup) return `Raqeto invoice ${dup.n.id} exists – koncept pro stejného klienta/projekt/období už existuje`;
  const body: Obj = { client: p.client, due_date: p.due_date };
  if (p.project) body.project = p.project;
  if (p.task) body.task = p.task;
  if (p.issued_date) body.issued_date = p.issued_date;
  if (p.period_from) body.period_from = p.period_from;
  if (p.period_to) body.period_to = p.period_to;
  if (p.tax_rate != null) body.tax_rate = dec(p.tax_rate);
  if (p.currency) body.currency = p.currency;
  if (p.variable_symbol) body.variable_symbol = p.variable_symbol;
  if (p.notes) body.notes = p.notes;
  const i = await raqetoFetch<Obj>("/invoices/", { method: "POST", body });
  if (!i?.id) throw new Error("Raqeto nevrátilo id faktury.");
  return `Raqeto invoice ${i.id} created (draft${i.number ? `, dočasné číslo ${i.number}` : ""})`;
}

export async function invoiceSend(id: string): Promise<string> {
  const cur = normInvoice(await raqetoFetch<Obj>(`/invoices/${enc(id)}/`));
  if (cur.status !== "draft") throw new Error(`Faktura ${cur.number || id} už není koncept (stav ${cur.status}) – vystavit ji znovu nejde.`);
  const i = await raqetoFetch<Obj>(`/invoices/${enc(id)}/send/`, { method: "POST" });
  return `Raqeto invoice ${id} sent – číslo ${str(i?.number) || "?"}, čeká na schválení klientem`;
}

export async function quoteCreate(p: { client: string; title: string; amount: number; currency?: string; body?: string; project?: string; task?: string }): Promise<string> {
  const drafts = (await raqetoList<Obj>("/quotes/", { status: "draft", client: p.client })).map(normQuote);
  const dup = drafts.find((q) => q.client_id === p.client && q.status === "draft" && similarTitle(q.title, p.title));
  const fields: Obj = { title: p.title.trim(), amount: dec(p.amount) };
  if (p.currency) fields.currency = p.currency;
  if (p.body) fields.body = p.body;
  if (dup) {
    await raqetoFetch(`/quotes/${enc(dup.id)}/`, { method: "PATCH", body: fields });
    return `Raqeto quote ${dup.id} updated – existující koncept „${dup.title}“ upraven`;
  }
  const body: Obj = { client: p.client, ...fields };
  if (p.project) body.project = p.project;
  if (p.task) body.task = p.task;
  const q = await raqetoFetch<Obj>("/quotes/", { method: "POST", body });
  if (!q?.id) throw new Error("Raqeto nevrátilo id nabídky.");
  return `Raqeto quote ${q.id} created (draft) – „${p.title.trim()}“`;
}

export async function quoteSend(id: string): Promise<string> {
  const cur = normQuote(await raqetoFetch<Obj>(`/quotes/${enc(id)}/`));
  if (cur.status !== "draft") throw new Error(`Nabídka už není koncept (stav ${cur.status}).`);
  await raqetoFetch(`/quotes/${enc(id)}/send/`, { method: "POST" });
  return `Raqeto quote ${id} sent – „${cur.title}“`;
}

export async function taskApproval(id: string, action: "approve" | "return", note?: string): Promise<string> {
  const body: Obj = { action };
  if (note) body.note = note;
  const t = await raqetoFetch<Obj>(`/tasks/${enc(id)}/approval/`, { method: "POST", body });
  return `Raqeto task ${id} ${action === "approve" ? "approved" : "returned"}${t?.approval_status ? ` (approval_status ${t.approval_status})` : ""}`;
}

export async function emailMarkSent(id: string): Promise<string> {
  const cur = normEmail(await raqetoFetch<Obj>(`/emails/${enc(id)}/`));
  if (cur.status === "sent") return `Raqeto email ${id} already sent`;
  await raqetoFetch(`/emails/${enc(id)}/`, { method: "PATCH", body: { status: "sent" } });
  return `Raqeto email ${id} marked sent`;
}

export const DELETABLE = { task: "/tasks/", calendar: "/calendar-events/", schedule: "/schedule-entries/", email_draft: "/emails/", time_entry: "/time-entries/" } as const;
export type Deletable = keyof typeof DELETABLE;

/* What is about to be deleted (for the approval summary); refuses invoiced time. */
export async function describeForDelete(resource: Deletable, id: string): Promise<string> {
  const o = await raqetoFetch<Obj>(`${DELETABLE[resource]}${enc(id)}/`);
  if (resource === "time_entry") {
    const e = normTimeEntry(o);
    if (e.is_invoiced) throw new Error("Časový záznam je vyfakturovaný – smazat ho nejde.");
    return `${e.hours} h ${e.started_at.slice(0, 10)} ${e.project_name}${e.task_title ? ` / ${e.task_title}` : ""}`;
  }
  if (resource === "schedule") { const s = normSchedule(o); return `${s.date}: ${s.task_title}`; }
  if (resource === "email_draft") return str(o.subject) || str(o.source_text).slice(0, 60);
  return str(o.title);
}

export async function deleteResource(resource: Deletable, id: string): Promise<string> {
  if (!(resource in DELETABLE)) throw new Error(`Mazat jde jen: ${Object.keys(DELETABLE).join(", ")}.`);
  if (resource === "time_entry") await describeForDelete(resource, id);
  await raqetoFetch(`${DELETABLE[resource]}${enc(id)}/`, { method: "DELETE" });
  return `Raqeto ${resource} ${id} deleted`;
}
