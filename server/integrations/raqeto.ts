/* Raqeto CRM (the owner's CRM) over its DRF API at RAQETO_API_BASE with the
 * bearer token RAQETO_API_TOKEN from .env.local. Raqeto is the source of truth
 * for clients, projects, tasks, time entries, invoices, calendar and briefs
 * (AI Mozek SCHEMA §10). This module never returns or logs the token; errors
 * are readable Czech sentences. Writes live here too (upsert*), each doing the
 * SCHEMA §10 dedup check before any POST - they are called only from approved
 * actions (server/tools/raqeto.ts). No relative imports: unit-testable as is. */

const DEFAULT_BASE = "https://project-test-8616.rostiapp.cz/api/ai";
const TIMEOUT_MS = 20_000;
const MAX_ITEMS = 500;
const PING_TTL = 10 * 60_000;
const DISCOVERY_TTL = 60 * 60_000;

type Ping = { at: number; ok: boolean; error?: string };
type Discovery = { at: number; endpoints: Record<string, string> };
const g = globalThis as { __apexRaqeto?: { ping?: Ping; discovery?: Discovery } };
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
  return t ? text.split(t).join("***") : text;
}

/* DRF error body → short readable detail (field errors or "detail"). */
function drfDetail(body: string): string {
  try {
    const j = JSON.parse(body);
    if (typeof j?.detail === "string") return j.detail;
    if (j && typeof j === "object") {
      return Object.entries(j).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : JSON.stringify(v)}`).join("; ");
    }
  } catch { /* not JSON */ }
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function httpError(status: number, path: string, body: string): Error {
  const detail = drfDetail(body).slice(0, 300);
  let msg: string;
  if (status === 401) msg = "Raqeto odmítlo přístupový token (401) – zkontroluj RAQETO_API_TOKEN v .env.local.";
  else if (status === 403) msg = `Token nemá v Raqeto oprávnění k této operaci (403): ${path}.`;
  else if (status === 404) msg = `V Raqeto nenalezeno (404): ${path}.`;
  else if (status === 429) msg = "Raqeto dočasně omezuje počet požadavků (429) – zkus to za chvíli.";
  else if (status >= 500) msg = `Raqeto má potíže na serveru (${status}) – zkus to později.`;
  else msg = `Raqeto požadavek selhal (${status}) ${path}${detail ? `: ${detail}` : ""}`;
  return new Error(scrub(msg));
}

/* Resolve a path ("/tasks/") or an absolute URL (DRF "next") against the base.
 * Absolute URLs must stay on the base origin, so the token never leaks. */
function resolveUrl(pathOrUrl: string, query?: Record<string, string | number | boolean | undefined | null>): URL {
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

export async function raqetoFetch<T = any>(
  pathOrUrl: string,
  opts: { method?: "GET" | "POST" | "PATCH"; body?: unknown; query?: Record<string, string | number | boolean | undefined | null> } = {},
): Promise<T> {
  const t = token();
  if (!t) throw new Error(NOT_CONFIGURED);
  const url = resolveUrl(pathOrUrl, opts.query);
  const method = opts.method ?? "GET";
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
  if (!res.ok) throw httpError(res.status, url.pathname, text);
  if (!text) return null as T;
  try { return JSON.parse(text) as T; } catch { throw new Error(`Raqeto vrátilo neplatnou odpověď (${url.pathname}).`); }
}

/* Follow DRF pagination ("results"/"next"), at most `cap` items. Plain array
 * responses are accepted too. */
export async function raqetoList<T = any>(path: string, query: Record<string, string | number | boolean | undefined | null> = {}, cap = MAX_ITEMS): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  let first = true;
  const limit = Math.min(cap, MAX_ITEMS);
  while (next && out.length < limit) {
    const page: any = await raqetoFetch(next, first ? { query: { page_size: 100, ...query } } : {});
    first = false;
    const items: T[] = Array.isArray(page) ? page : Array.isArray(page?.results) ? page.results : [];
    out.push(...items);
    next = !Array.isArray(page) && typeof page?.next === "string" && page.next ? page.next : null;
  }
  return out.slice(0, limit);
}

/* ── status, ping, discovery ── */

export function raqetoStatus(): { configured: boolean; base: string; ok?: boolean; error?: string } {
  const configured = raqetoConfigured();
  const base = raqetoBase();
  if (!configured || !cache.ping) return { configured, base };
  return { configured, base, ok: cache.ping.ok, ...(cache.ping.error ? { error: cache.ping.error } : {}) };
}

/* API root lists the endpoints (DRF browsable root): {"clients": "https://…/clients/", …}. */
async function fetchRoot(): Promise<Record<string, string>> {
  const root = await raqetoFetch<Record<string, unknown>>("/");
  const base = safeBase();
  const endpoints: Record<string, string> = {};
  for (const [key, value] of Object.entries(root && typeof root === "object" && !Array.isArray(root) ? root : {})) {
    if (typeof value !== "string") continue;
    try {
      const u = new URL(value, base);
      if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) continue;
      endpoints[key] = "/" + u.pathname.slice(base.pathname.length).replace(/^\/+/, "");
    } catch { /* not a URL */ }
  }
  cache.discovery = { at: Date.now(), endpoints };
  return endpoints;
}

export async function raqetoPing(force = false): Promise<{ configured: boolean; base: string; ok?: boolean; error?: string }> {
  if (!raqetoConfigured()) return raqetoStatus();
  if (!force && cache.ping && Date.now() - cache.ping.at < PING_TTL) return raqetoStatus();
  try {
    await fetchRoot();
    cache.ping = { at: Date.now(), ok: true };
  } catch (e) {
    cache.ping = { at: Date.now(), ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return raqetoStatus();
}

export async function raqetoDiscover(): Promise<Record<string, string>> {
  if (cache.discovery && Date.now() - cache.discovery.at < DISCOVERY_TTL) return cache.discovery.endpoints;
  return fetchRoot();
}

/* Optional endpoints exposed only if the API root lists them. */
export async function raqetoOptionalEndpoint(kind: "invoices" | "calendar"): Promise<string | null> {
  const eps = await raqetoDiscover();
  const re = kind === "invoices" ? /invoice|faktur/i : /calendar|^events?$|kalendar/i;
  const key = Object.keys(eps).find((k) => re.test(k));
  return key ? eps[key] : null;
}

/* ── normalization ── */

type Obj = Record<string, any>;
const idOf = (v: any): string | null => (v && typeof v === "object" ? (v.id != null ? String(v.id) : null) : v != null && v !== "" ? String(v) : null);
const num = (v: any): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v: any): string => (v == null ? "" : String(v));

export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const CLOSED = new Set(["done", "completed", "complete", "closed", "cancelled", "canceled", "archived", "finished", "resolved", "hotovo", "dokonceno", "zruseno"]);
export function isOpenTask(t: Obj): boolean {
  if (t.is_completed === true || t.completed === true || t.done === true || t.is_done === true) return false;
  return !CLOSED.has(normalize(str(t.status)).replace(/ /g, "_"));
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, critical: 0, highest: 0, high: 1, vysoka: 1, medium: 2, normal: 2, stredni: 2, low: 3, nizka: 3, lowest: 4 };
export function priorityRank(p: unknown): number {
  if (typeof p === "number") return p;
  return PRIORITY_RANK[normalize(str(p))] ?? 2;
}

export function normClient(c: Obj) {
  return {
    id: str(c.id), name: str(c.name), company: str(c.company), ico: str(c.ico), dic: str(c.dic),
    email: str(c.email), phone: str(c.phone), address: str(c.address), is_active: c.is_active !== false, notes: str(c.notes),
  };
}

export function normProject(p: Obj) {
  const tracked = num(p.total_tracked_hours);
  const budgetHours = num(p.budget_hours);
  const usage = num(p.budget_usage_pct) ?? (tracked != null && budgetHours ? Math.round((tracked / budgetHours) * 1000) / 10 : null);
  return {
    id: str(p.id), name: str(p.name), status: str(p.status),
    client_id: idOf(p.client), client_name: str(p.client_name || (p.client && typeof p.client === "object" ? p.client.name : "")),
    deadline: p.deadline ? str(p.deadline) : null, hourly_rate: num(p.hourly_rate),
    budget_hours: budgetHours, budget_amount: num(p.budget_amount), tracked_hours: tracked, budget_usage_pct: usage,
    description: str(p.description),
  };
}

export function normTask(t: Obj, today = localDate()) {
  const deadline = t.deadline || t.due_date || null;
  const open = isOpenTask(t);
  return {
    id: str(t.id), name: str(t.name ?? t.title), status: str(t.status), priority: str(t.priority),
    deadline: deadline ? str(deadline) : null, project_id: idOf(t.project), project_name: str(t.project_name),
    description: str(t.description), open, overdue: open && !!deadline && str(deadline).slice(0, 10) < today,
  };
}

export function normBrief(b: Obj) {
  return {
    id: str(b.id), project_id: idOf(b.project), title: str(b.title), content: str(b.content),
    task_ids: Array.isArray(b.task_ids) ? b.task_ids.map(String) : [],
  };
}

/* Minutes of a time entry, whatever shape the API uses. */
export function entryMinutes(e: Obj): number {
  const dm = num(e.duration_minutes);
  if (dm != null) return dm;
  if (typeof e.duration === "string") {
    const m = e.duration.match(/^(?:(\d+) )?(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
    if (m) return Number(m[1] || 0) * 1440 + Number(m[2]) * 60 + Number(m[3]) + Math.round(Number(m[4] || 0) / 60);
  }
  if (typeof e.duration === "number") return Math.round(e.duration / 60);
  const hours = num(e.hours ?? e.duration_hours);
  if (hours != null) return Math.round(hours * 60);
  if (e.started_at && e.ended_at) return Math.max(0, Math.round((Date.parse(e.ended_at) - Date.parse(e.started_at)) / 60_000));
  return 0;
}

export function normTimeEntry(e: Obj) {
  return {
    id: str(e.id), project_id: idOf(e.project), project_name: str(e.project_name), started_at: str(e.started_at),
    minutes: entryMinutes(e), billable: e.billable !== false && e.is_billable !== false, description: str(e.description),
  };
}

/* ── reads ── */

export async function listClients(opts: { search?: string; ico?: string; includeArchived?: boolean } = {}) {
  const rows = await raqetoList("/clients/", { search: opts.search, ico: opts.ico, is_active: opts.includeArchived ? undefined : "true" });
  return rows.map(normClient).filter((c) => (opts.includeArchived || c.is_active) && (!opts.ico || c.ico.replace(/\s/g, "") === opts.ico.replace(/\s/g, "")));
}

export async function listProjects(opts: { status?: string; clientId?: string; search?: string } = {}) {
  const rows = await raqetoList("/projects/", { status: opts.status, client: opts.clientId, search: opts.search });
  return rows.map(normProject).filter((p) => (!opts.status || p.status === opts.status) && (!opts.clientId || p.client_id === opts.clientId));
}

function sortTasks<T extends { overdue: boolean; priority: string; deadline: string | null }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || priorityRank(a.priority) - priorityRank(b.priority)
    || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
}

export async function listTasks(opts: { projectId?: string; status?: string; openOnly?: boolean; search?: string; limit?: number } = {}) {
  const rows = await raqetoList("/tasks/", { project: opts.projectId, status: opts.status, search: opts.search });
  const today = localDate();
  const tasks = rows.map((t) => normTask(t, today)).filter((t) =>
    (!opts.projectId || !t.project_id || t.project_id === opts.projectId)
    && (!opts.status || t.status === opts.status)
    && (!opts.openOnly || opts.status || t.open)
    && (!opts.search || normalize(t.name + " " + t.description).includes(normalize(opts.search))));
  return sortTasks(tasks).slice(0, opts.limit ?? 50);
}

export async function listBriefs(projectId: string) {
  const rows = await raqetoList("/briefs/", { project: projectId });
  return rows.map(normBrief).filter((b) => !b.project_id || b.project_id === projectId);
}

export async function timeEntries(opts: { projectId?: string; from?: string; to?: string } = {}) {
  const rows = await raqetoList("/time-entries/", {
    project: opts.projectId,
    started_at__gte: opts.from ? `${opts.from}T00:00:00` : undefined,
    started_at__lte: opts.to ? `${opts.to}T23:59:59` : undefined,
  });
  const entries = rows.map(normTimeEntry).filter((e) => {
    const d = e.started_at ? localDate(new Date(e.started_at)) : "";
    return (!opts.projectId || !e.project_id || e.project_id === opts.projectId) && (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to);
  });
  const h = (m: number) => Math.round((m / 60) * 100) / 100;
  const total = entries.reduce((s, e) => s + e.minutes, 0);
  const billable = entries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0);
  const byProject = new Map<string, { project_id: string | null; project_name: string; minutes: number }>();
  for (const e of entries) {
    const key = e.project_id ?? "";
    const p = byProject.get(key) ?? { project_id: e.project_id, project_name: e.project_name, minutes: 0 };
    p.minutes += e.minutes;
    byProject.set(key, p);
  }
  return {
    total_hours: h(total), billable_hours: h(billable), non_billable_hours: h(total - billable), count: entries.length,
    by_project: [...byProject.values()].map((p) => ({ project_id: p.project_id, project_name: p.project_name, hours: h(p.minutes) })).sort((a, b) => b.hours - a.hours),
    entries: entries.slice(0, 100),
  };
}

/* Active projects (deadline, budget usage) + open tasks (overdue first). */
export async function raqetoOverview() {
  const [projects, tasks] = await Promise.all([listProjects({ status: "active" }), listTasks({ openOnly: true, limit: MAX_ITEMS })]);
  const today = localDate();
  const dayMs = 86_400_000;
  const active = projects
    .map((p) => ({ ...p, days_left: p.deadline ? Math.round((Date.parse(p.deadline.slice(0, 10)) - Date.parse(today)) / dayMs) : null }))
    .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const open = tasks.map((t) => ({ ...t, project_name: t.project_name || (t.project_id ? names.get(t.project_id) ?? "" : "") }));
  return {
    projects: active,
    tasks: open.slice(0, 60),
    counts: {
      active_projects: active.length, open_tasks: open.length, overdue_tasks: open.filter((t) => t.overdue).length,
      over_budget: active.filter((p) => (p.budget_usage_pct ?? 0) > 100).length,
    },
  };
}

/* ── dedup helpers (SCHEMA §10) ── */

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

/* ── writes (only from approved actions) ── */

export async function upsertTask(p: { project_id: string; title: string; description: string; priority?: string; deadline?: string; task_id?: string }): Promise<string> {
  const extra: Obj = {};
  if (p.priority) extra.priority = p.priority;
  if (p.deadline) extra.deadline = p.deadline;
  let target: Obj | null = null;
  if (p.task_id) {
    target = await raqetoFetch(`/tasks/${encodeURIComponent(p.task_id)}/`);
  } else {
    const existing = (await raqetoList("/tasks/", { project: p.project_id }))
      .filter((t) => (!idOf(t.project) || idOf(t.project) === p.project_id) && isOpenTask(t));
    target = existing.find((t) => similarTitle(str(t.name ?? t.title), p.title)) ?? null;
  }
  if (target) {
    const id = str(target.id);
    await raqetoFetch(`/tasks/${encodeURIComponent(id)}/`, { method: "PATCH", body: { description: appendText(str(target.description), p.description), ...extra } });
    return `Raqeto task ${id} (updated) – „${str(target.name ?? target.title)}“`;
  }
  const created = await raqetoFetch<Obj>("/tasks/", { method: "POST", body: { project: p.project_id, name: p.title, description: p.description, ...extra } });
  if (!created?.id) throw new Error("Raqeto nevrátilo id nového úkolu.");
  return `Raqeto task ${created.id} (created) – „${p.title}“`;
}

/* Brief content must be only the work spec: <h3>N. Title</h3><p>…</p>. */
const BRIEF_TAGS = new Set(["h3", "p", "ul", "ol", "li", "strong", "em", "b", "i", "br", "code", "a"]);
export function briefContentProblem(html: string): string | null {
  if (!/<h3[\s>]/i.test(html)) return "Brief musí mít sekce ve tvaru <h3>N. Název</h3><p>Co a jak.</p>.";
  const bad = [...html.matchAll(/<\/?([a-z0-9]+)\b[^>]*>/gi)].map((m) => m[1].toLowerCase()).filter((t) => !BRIEF_TAGS.has(t));
  if (bad.length) return `Brief smí obsahovat jen <h3>, <p>, seznamy a zvýraznění – nepovolené značky: ${[...new Set(bad)].join(", ")}.`;
  if (/on\w+\s*=|javascript:/i.test(html)) return "Brief nesmí obsahovat skripty ani obsluhy událostí.";
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

export async function upsertBrief(p: { project_id: string; content_html: string; task_ids?: string[]; title?: string }): Promise<string> {
  const problem = briefContentProblem(p.content_html);
  if (problem) throw new Error(problem);
  const briefs = await listBriefs(p.project_id);
  const newIds = (p.task_ids ?? []).map(String);
  if (briefs.length) {
    const b = briefs[0];
    const { content, added } = mergeBriefContent(b.content, p.content_html);
    const task_ids = [...new Set([...b.task_ids, ...newIds])];
    const newTasks = task_ids.length - b.task_ids.length;
    if (!added && !newTasks) return `Raqeto brief ${b.id} (updated) – beze změny, vše už v briefu je`;
    await raqetoFetch(`/briefs/${encodeURIComponent(b.id)}/`, { method: "PATCH", body: { content, task_ids } });
    return `Raqeto brief ${b.id} (updated) – +${added} sekcí, +${newTasks} úkolů`;
  }
  let title = p.title?.trim() || "";
  if (!title) {
    try { title = str((await raqetoFetch<Obj>(`/projects/${encodeURIComponent(p.project_id)}/`))?.name); } catch { /* fall back below */ }
    title = title ? `${title} – zadání` : "Zadání";
  }
  const content = p.content_html.trim();
  const created = await raqetoFetch<Obj>("/briefs/", { method: "POST", body: { project: p.project_id, title, content, task_ids: newIds } });
  if (!created?.id) throw new Error("Raqeto nevrátilo id nového briefu.");
  return `Raqeto brief ${created.id} (created) – „${title}“`;
}

export async function upsertClient(p: { name: string; ico?: string; dic?: string; email?: string; phone?: string; address?: string }): Promise<string> {
  const ico = p.ico?.replace(/\s/g, "") || "";
  let match: Obj | null = null;
  if (ico) {
    match = (await raqetoList("/clients/", { ico })).find((c) => str(c.ico).replace(/\s/g, "") === ico) ?? null;
  }
  if (!match) {
    const found = await raqetoList("/clients/", { search: p.name });
    // A name match with a different IČO is a different company.
    match = found.find((c) => similarTitle(str(c.name), p.name) && (!ico || !str(c.ico).trim() || str(c.ico).replace(/\s/g, "") === ico)) ?? null;
  }
  const fields: Obj = { ico, dic: p.dic?.trim(), email: p.email?.trim(), phone: p.phone?.trim(), address: p.address?.trim() };
  if (match) {
    const id = str(match.id);
    // Fill only what is missing; never overwrite IČO/DIČ/address/contacts already in CRM.
    const patch: Obj = {};
    for (const [k, v] of Object.entries(fields)) if (v && !str(match[k]).trim()) patch[k] = v;
    const reactivated = match.is_active === false;
    if (reactivated) patch.is_active = true;
    if (!Object.keys(patch).length) return `Raqeto client ${id} (updated) – „${str(match.name)}“ už existuje, beze změny`;
    await raqetoFetch(`/clients/${encodeURIComponent(id)}/`, { method: "PATCH", body: patch });
    return `Raqeto client ${id} (updated) – „${str(match.name)}“${reactivated ? ", znovu aktivován" : ""}; doplněno: ${Object.keys(patch).filter((k) => k !== "is_active").join(", ") || "nic"}`;
  }
  const body: Obj = { name: p.name.trim(), is_active: true };
  for (const [k, v] of Object.entries(fields)) if (v) body[k] = v;
  const created = await raqetoFetch<Obj>("/clients/", { method: "POST", body });
  if (!created?.id) throw new Error("Raqeto nevrátilo id nového klienta.");
  return `Raqeto client ${created.id} (created) – „${p.name.trim()}“`;
}

export async function createTimeEntry(p: { project_id: string; started_at: string; duration_minutes: number; description: string; billable: boolean }): Promise<string> {
  const start = new Date(p.started_at);
  if (Number.isNaN(start.getTime())) throw new Error("Neplatný začátek (started_at) – použij ISO datum a čas.");
  const day = localDate(start);
  const shift = (d: number) => localDate(new Date(start.getTime() + d * 86_400_000));
  const sameDay = (await raqetoList("/time-entries/", { project: p.project_id, started_at__gte: `${shift(-1)}T00:00:00`, started_at__lte: `${shift(1)}T23:59:59` }))
    .map(normTimeEntry)
    .filter((e) => (!e.project_id || e.project_id === p.project_id) && e.started_at && localDate(new Date(e.started_at)) === day);
  const dup = sameDay.find((e) => e.minutes === p.duration_minutes);
  if (dup) throw new Error(`Duplicita: v projektu už je ${day} záznam se stejnou délkou ${p.duration_minutes} min (id ${dup.id}). Pokud jde opravdu o další práci, uprav délku nebo záznam v Raqeto.`);
  const ended = new Date(start.getTime() + p.duration_minutes * 60_000);
  const created = await raqetoFetch<Obj>("/time-entries/", {
    method: "POST",
    body: { project: p.project_id, started_at: start.toISOString(), ended_at: ended.toISOString(), duration_minutes: p.duration_minutes, description: p.description, billable: p.billable },
  });
  if (!created?.id) throw new Error("Raqeto nevrátilo id nového časového záznamu.");
  return `Raqeto time entry ${created.id} (created) – ${p.duration_minutes} min ${day}`;
}
