import { z } from "zod";
import { defineTool, NeedsApproval, untrusted } from "./registry";
import { defineAction } from "../actions";
import { getRun, type Run } from "../events";
import * as R from "../integrations/raqeto";

/* Raqeto CRM tools – Raqeto is Apex's main CRM (clients, projects, tasks,
 * time, invoices, quotes, calendar, schedule, e-mail drafts, communication).
 * Reads: live API calls; CRM text can come from clients (portal, mail), so
 * every read taints the run and free text is wrapped in untrusted().
 * Direct writes (raqeto_task_*, raqeto_schedule_*, raqeto_time_log,
 * raqeto_timer_*, raqeto_calendar_create/update, raqeto_email_draft_*,
 * raqeto_brief_upsert, raqeto_interaction_mark_replied,
 * raqeto_comment_internal): internal only, dedup before POST, never delete,
 * never send. Not cleanOnly on purpose – "read a client mail, create a task"
 * is the core use case – but guarded once the run is tainted (read external
 * content, or a loop / AI queue run): at most 10 direct writes, no portal-
 * visible task text on client projects, no done/archive moves, no big
 * reorders, and a queue run never edits its own task; text / project of a
 * coding-agent task never changes directly. Time entries, timers and
 * mark-replied touch billing or the owner's live state → cleanOnly.
 * A guard never dead-ends: it throws NeedsApproval (cleanOnly works the same
 * way in the registry) and the call becomes a deferred action – an approve
 * button for the owner; on approval it runs in a clean run (source
 * "approval"). Anything client-visible, money or destructive stays a
 * dedicated approval action (propose_raqeto_*). */

type Obj = Record<string, any>;
const wrap = (text: string) => (text ? untrusted("raqeto", text) : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/* Drop empty fields (null / "") – keeps results under the tool result limit. */
function lean<T extends Obj>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== "" && v !== undefined)) as T;
}
/* Wrap the named free-text fields (clipped) of a record; empty fields dropped. */
function w<T extends Obj>(o: T, keys: (keyof T)[], max = 600): T {
  const out: Obj = lean(o);
  for (const k of keys) if (typeof out[k as string] === "string") out[k as string] = wrap(clip(out[k as string], max));
  return out as T;
}
/* Task in a list: labels, timestamps and "none" states dropped; details via raqeto_task_detail. */
function listTask(t: R.RaqetoTask) {
  const { status_label: _s, priority_label: _p, updated_at: _u, open: _o, assignee_id: _a, ...rest } = t;
  return w({
    ...rest,
    approval_status: t.approval_status === "none" ? "" : t.approval_status,
    ai_state: t.ai_state === "none" ? "" : t.ai_state,
  }, ["description"], 150);
}
const notReady = () => (R.raqetoConfigured() ? null : "RAQETO_API_TOKEN není nastavený v .env.local – akce po schválení selže.");
function need() {
  if (!R.raqetoConfigured()) throw new Error(R.NOT_CONFIGURED);
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ve tvaru YYYY-MM-DD.");
const DATETIME = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Neplatné datum a čas (ISO 8601, ideálně s časovou zónou, např. 2026-09-30T09:00:00+02:00).");
const ID = z.string().min(1).describe("UUID v Raqeto.");
const today = () => R.localDate();

/* ── write guards (see header) ── */

const WRITE_BUDGET = 10;
const REORDER_MAX = 20;
/* The run and its parents: budget, taint and queue source are per whole turn. */
function runChain(run: Run): Run[] {
  const out: Run[] = [];
  for (let r: Run | undefined = run; r && out.length < 16; r = r.parentId ? getRun(r.parentId) : undefined) out.push(r);
  return out;
}
const isTainted = (run: Run) => runChain(run).some((r) => r.tainted || /^(loop|raqeto):/.test(r.source ?? ""));
/* Task id of the AI queue item this run works on (source "raqeto:<id>"). */
const ownTask = (run: Run) => runChain(run).map((r) => /^raqeto:(.+)$/.exec(r.source ?? "")?.[1]).find(Boolean);

/* Call before every direct write: budget in tainted runs, counted up the chain. */
function spendWrite(run: Run) {
  const chain = runChain(run);
  if (isTainted(run) && Math.max(...chain.map((r) => r.writes ?? 0)) >= WRITE_BUDGET) {
    throw new NeedsApproval(`v tomto kroku byl přečten externí obsah a limit ${WRITE_BUDGET} přímých zápisů do Raqeto je vyčerpán.`);
  }
  for (const r of chain) r.writes = (r.writes ?? 0) + 1;
}
/* After a successful write: "tool id" for the AI queue result trail. */
function logWrite(run: Run, tool: string, id: unknown) {
  for (const r of runChain(run)) (r.trail ??= []).push(`${tool} ${String(id ?? "") || "?"}`);
}
function notOwnTask(run: Run, id: string) {
  if (ownTask(run) === id) {
    throw new NeedsApproval("úkol právě zpracovává AI fronta – vlastní úkol (stav, priorita, popis, komentáře) agent sám neměnit nesmí.");
  }
}
const PORTAL = "úkol patří do projektu klienta (název, popis, termín, odhad i projekt vidí klient v portálu) a v tomto kroku byl přečten externí obsah (pošta, web, CRM).";
const CODING = "úkol zpracovává kódovací agent (AI fronta nebo repozitář projektu) – název, popis a projekt mění jen majitel.";

/* ═════════════ READ tools ═════════════ */

defineTool({
  name: "raqeto_status",
  description: "Stav napojení na Raqeto: nastaveno, dostupné, workspace a oprávnění (scopes) klíče.",
  input: {},
  node: "crm",
  handler: async () => {
    if (!R.raqetoConfigured()) return { configured: false, note: R.NOT_CONFIGURED };
    return R.raqetoPing(true);
  },
});

defineTool({
  name: "raqeto_search",
  description: "Fulltextové hledání napříč Raqeto (úkoly, projekty, klienti, briefy, kalendář, faktury). Vrací typ, id, název a úryvek – detail pak přes příslušný nástroj.",
  input: {
    q: z.string().min(2).describe("Hledaný text."),
    types: z.array(z.enum(["tasks", "projects", "clients", "briefs", "calendar", "invoices"])).optional().describe("Omezit na typy."),
  },
  node: "crm",
  taints: true,
  handler: async ({ q, types }) => {
    need();
    const rows = await R.search(q, types);
    return { count: rows.length, results: rows.slice(0, 60).map((r) => w(r, ["snippet"], 160)) };
  },
});

defineTool({
  name: "raqeto_clients",
  description: "Klienti z Raqeto (zdroj pravdy: IČO, DIČ, adresa, kontakt). Hledání podle jména/IČO/e-mailu; standardně jen aktivní.",
  input: {
    search: z.string().optional().describe("Část jména, firmy, IČO nebo e-mailu."),
    include_archived: z.boolean().default(false).describe("Zahrnout i neaktivní klienty."),
  },
  node: "crm",
  taints: true,
  handler: async ({ search, include_archived }) => {
    need();
    const rows = await R.listClients({ search, includeArchived: include_archived });
    // List view: contact basics; notes/address via raqeto_client_detail.
    return {
      count: rows.length,
      clients: rows.slice(0, 120).map((c) => lean({ id: c.id, name: c.name, company: c.company === c.name ? "" : c.company, ico: c.ico, email: c.email, phone: c.phone, ...(c.is_active ? {} : { is_active: false }) })),
    };
  },
});

defineTool({
  name: "raqeto_client_detail",
  description: "Detail klienta v Raqeto: kontaktní a fakturační údaje, nevyfakturovaná částka (billing-summary, jen pevné položky bez času), projekty a posledních 10 komunikací.",
  input: { id: ID },
  node: "crm",
  taints: true,
  handler: async ({ id }) => {
    need();
    const d = await R.clientDetail(id);
    return {
      client: w(d.client, ["notes"], 2000),
      billing: d.billing,
      projects: d.projects.map((p) => w(p, ["description"], 300)),
      recent_interactions: d.recent_interactions.map((i) => w(i, ["subject", "from_display", "excerpt"], 400)),
    };
  },
});

defineTool({
  name: "raqeto_projects",
  description: "Projekty z Raqeto: stav, klient, deadline, sazba, budget a jeho čerpání (budget_usage_pct).",
  input: {
    status: z.enum(["active", "on_hold", "completed", "archived"]).optional().describe("Bez zadání všechny."),
    client: z.string().optional().describe("UUID klienta."),
    search: z.string().optional().describe("Část názvu."),
  },
  node: "crm",
  taints: true,
  handler: async ({ status, client, search }) => {
    need();
    const rows = await R.listProjects({ status, clientId: client, search });
    return { count: rows.length, projects: rows.slice(0, 100).map(({ status_label: _l, ...p }) => w(p, ["description"], 80)) };
  },
});

defineTool({
  name: "raqeto_tasks",
  description: "Úkoly z Raqeto s filtry. Standardně jen otevřené a nearchivované; řazení: po termínu nejdřív, pak nejbližší deadline, pak priorita.",
  input: {
    project: z.string().optional().describe("UUID projektu."),
    status: z.string().optional().describe("Slug stavu (viz raqeto_task_statuses) – přebije open_only."),
    priority: z.string().optional().describe("low / medium / high / urgent (nebo vlastní slug)."),
    assignee: z.number().int().optional().describe("ID uživatele."),
    deadline_from: DATE.optional(),
    deadline_to: DATE.optional(),
    no_project: z.boolean().optional().describe("Jen úkoly bez projektu."),
    ai_state: z.enum(["none", "queued", "running", "review", "done", "failed"]).optional(),
    search: z.string().optional().describe("Text v názvu / popisu."),
    open_only: z.boolean().default(true),
    include_archived: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(30),
  },
  node: "crm",
  taints: true,
  handler: async (a) => {
    need();
    const r = await R.listTasks({
      project: a.project, status: a.status, priority: a.priority, assignee: a.assignee, deadlineFrom: a.deadline_from, deadlineTo: a.deadline_to,
      noProject: a.no_project, aiState: a.ai_state, search: a.search, openOnly: a.open_only, includeArchived: a.include_archived, limit: a.limit,
    });
    return { today: today(), count: r.count, truncated: r.truncated, tasks: r.tasks.map(listTask) };
  },
});

defineTool({
  name: "raqeto_task_detail",
  description: "Detail úkolu v Raqeto: všechna pole (vč. AI fronty a schvalování), komentáře a posledních 20 změn z historie.",
  input: { id: ID },
  node: "crm",
  taints: true,
  handler: async ({ id }) => {
    need();
    const d = await R.taskDetail(id);
    return {
      task: w(d.task, ["description", "ai_brief", "ai_result", "approval_note"], 4000),
      comments: d.comments.map((c) => w(c, ["body"], 1500)),
      history: d.history.map((h) => ({ ...h, old: typeof h.old === "string" ? wrap(clip(h.old, 200)) : h.old, new: typeof h.new === "string" ? wrap(clip(h.new, 200)) : h.new })),
    };
  },
});

defineTool({
  name: "raqeto_task_statuses",
  description: "Stavy úkolů ve workspace Raqeto (slug, název, zda znamená hotovo). Použij před raqeto_task_move.",
  input: {},
  node: "crm",
  taints: true,
  handler: async () => {
    need();
    return { statuses: await R.taskStatuses(true), archive: "__archived__ = archivovat (stav se nemění)" };
  },
});

defineTool({
  name: "raqeto_briefs",
  description: "Brief (zadání práce) projektu v Raqeto – HTML obsah a navázané úkoly.",
  input: { project: ID.describe("UUID projektu.") },
  node: "crm",
  taints: true,
  handler: async ({ project }) => {
    need();
    const rows = await R.listBriefs(project);
    return { count: rows.length, briefs: rows.map((b) => w(b, ["content"], 8000)) };
  },
});

defineTool({
  name: "raqeto_time_entries",
  description: "Odpracovaný čas z Raqeto za období (výchozí: tento týden do dneška): součty celkem / fakturovatelné / nefakturovatelné / fakturovatelné dosud nevyfakturované, rozpad podle projektů. running_only = jen běžící timery.",
  input: {
    from: DATE.optional().describe("Od (včetně)."),
    to: DATE.optional().describe("Do (včetně)."),
    project: z.string().optional().describe("UUID projektu."),
    task: z.string().optional().describe("UUID úkolu."),
    running_only: z.boolean().default(false),
  },
  node: "finance",
  taints: true,
  handler: async ({ from, to, project, task, running_only }) => {
    need();
    const r = await R.timeEntries({ from, to, project, task, runningOnly: running_only });
    return {
      ...r,
      entries: r.entries.slice(0, 60).map((e) => w({
        id: e.id, started_at: e.started_at.slice(0, 16), hours: e.hours, project: e.project_name, task: e.task_title,
        description: e.description, is_billable: e.is_billable, is_invoiced: e.is_invoiced, ...(e.is_running ? { is_running: true } : {}),
      }, ["description"], 150)),
    };
  },
});

defineTool({
  name: "raqeto_invoices",
  description: "Faktury z Raqeto + součty (celkem v Kč, nezaplaceno, po splatnosti). unpaid_only = odeslané a po splatnosti s nedoplatkem; overdue_only = jen po splatnosti.",
  input: {
    status: z.enum(["draft", "sent", "paid", "overdue", "cancelled"]).optional(),
    client: z.string().optional().describe("UUID klienta."),
    unpaid_only: z.boolean().default(false),
    overdue_only: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(100).describe("Kolik posledních faktur sečíst (bez unpaid/overdue filtru, nejnovější první); vypíše se max. 60."),
  },
  node: "finance",
  taints: true,
  handler: async ({ status, client, unpaid_only, overdue_only, limit }) => {
    need();
    const r = await R.listInvoices({ status, client, unpaidOnly: unpaid_only, overdueOnly: overdue_only, limit });
    return {
      today: today(), ...r,
      invoices: r.invoices.slice(0, 60).map((i) => lean({
        id: i.id, number: i.number, client: i.client_name, project: i.project_name, status: i.status, issued_date: i.issued_date, due_date: i.due_date,
        total: i.total, currency: i.currency, ...(i.currency !== "CZK" ? { total_czk: i.total_czk } : {}),
        ...(i.remaining > 0 ? { remaining: i.remaining } : {}), ...(i.overdue ? { overdue: true } : {}),
        ...(i.approval_status && i.approval_status !== "none" ? { approval_status: i.approval_status } : {}),
      })),
    };
  },
});

defineTool({
  name: "raqeto_quotes",
  description: "Cenové nabídky z Raqeto (draft / sent / approved / rejected).",
  input: {
    status: z.enum(["draft", "sent", "approved", "rejected"]).optional(),
    client: z.string().optional().describe("UUID klienta."),
  },
  node: "finance",
  taints: true,
  handler: async ({ status, client }) => {
    need();
    const rows = await R.listQuotes({ status, client });
    return { count: rows.length, quotes: rows.slice(0, 100).map((q) => w(q, ["body", "decided_note"], 800)) };
  },
});

defineTool({
  name: "raqeto_calendar",
  description: "Události z kalendáře Raqeto v rozsahu dní (YYYY-MM-DD, včetně).",
  input: { from: DATE, to: DATE },
  node: "calendar",
  taints: true,
  handler: async ({ from, to }) => {
    need();
    const rows = await R.listCalendar(from, to);
    return { count: rows.length, events: rows.slice(0, 200).map((e) => w(e, ["description", "location"], 400)) };
  },
});

defineTool({
  name: "raqeto_schedule",
  description: "Denní rozvrh z Raqeto (naplánované úkoly po dnech a pořadí). Výchozí: dnes.",
  input: { from: DATE.optional(), to: DATE.optional() },
  node: "chief_of_staff",
  taints: true,
  handler: async ({ from, to }) => {
    need();
    const f = from ?? today();
    const rows = await R.listSchedule(f, to ?? f);
    return { from: f, to: to ?? f, count: rows.length, entries: rows };
  },
});

defineTool({
  name: "raqeto_emails",
  description: "Návrhy e-mailů v Raqeto (generating → pending = hotový návrh, sent = odesláno ručně).",
  input: {
    status: z.enum(["generating", "pending", "sent"]).optional(),
    client: z.string().optional().describe("UUID klienta."),
    search: z.string().optional(),
  },
  node: "email",
  taints: true,
  handler: async ({ status, client, search }) => {
    need();
    const rows = await R.listEmails({ status, client, search });
    return { count: rows.length, drafts: rows.map((m) => w(m, ["subject", "source_text", "instructions", "body"], 1500)) };
  },
});

defineTool({
  name: "raqeto_interactions",
  description: "Komunikace s klienty v Raqeto (e-mail, WhatsApp, hovor, poznámka), nejnovější první. needs_reply = čeká na odpověď; unpaired = nespárované s klientem.",
  input: {
    needs_reply: z.boolean().optional(),
    unpaired: z.boolean().optional(),
    client: z.string().optional().describe("UUID klienta."),
    channel: z.enum(["email", "whatsapp", "messenger", "call", "note"]).optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(30).default(20),
  },
  node: "email",
  taints: true,
  handler: async ({ needs_reply, unpaired, client, channel, search, limit }) => {
    need();
    const r = await R.listInteractions({ needsReply: needs_reply, unpaired, client, channel, search, limit });
    return { count: r.count, items: r.items.map(({ body_url: _b, ...i }) => w(i, ["subject", "from_display", "excerpt"], 200)) };
  },
});

defineTool({
  name: "raqeto_overview",
  description: "Přehled dne a týdne z Raqeto: úkoly po termínu / dnes / tento týden, běžící timer, dnešní rozvrh, počet zpráv čekajících na odpověď, nezaplacené a po splatnosti faktury, aktivní projekty s čerpáním budgetu.",
  input: {},
  node: "crm",
  taints: true,
  handler: async () => {
    need();
    // open_tasks (the Deck's full list) repeats the grouped lists – left out.
    const { open_tasks: _all, ...o } = await R.raqetoOverview();
    // Compact shapes: the overview must fit the tool result limit; details via raqeto_task_detail etc.
    const t = (x: R.RaqetoTask) => lean({ id: x.id, title: x.title, project: x.project_name, client: x.client_name, deadline: x.deadline, priority: x.priority, status: x.status });
    return {
      ...o,
      overdue_tasks: o.overdue_tasks.slice(0, 20).map(t),
      due_today: o.due_today.map(t),
      due_this_week: o.due_this_week.slice(0, 20).map(t),
      running_timer: o.running_timer ? w(o.running_timer, ["description"], 200) : null,
      schedule_today: o.schedule_today.map(lean),
      overdue_invoices: o.overdue_invoices.map((i) => lean({ id: i.id, number: i.number, client: i.client_name, due_date: i.due_date, remaining: i.remaining, currency: i.currency, remaining_czk: i.remaining_czk })),
      projects: o.projects.slice(0, 40).map((p) => lean({ id: p.id, name: p.name, client: p.client_name, deadline: p.deadline, days_left: p.days_left, budget_usage_pct: p.budget_usage_pct, tracked_hours: p.tracked_hours, budget_hours: p.budget_hours })),
    };
  },
});

/* ═════════════ DIRECT WRITE tools (internal, dedup, no delete) ═════════════ */

/* Shared with the propose_raqeto_task_* / propose_raqeto_time_log approvals. */
const TASK_CREATE = {
  title: z.string().min(3).max(255),
  description: z.string().optional(),
  project: z.string().optional().describe("UUID projektu (bez něj úkol spadne do „Ostatní“)."),
  deadline: DATE.optional(),
  start_date: DATE.optional(),
  estimated_hours: z.number().min(0).max(9999).optional(),
  priority: z.string().optional().describe("low / medium / high / urgent – nastaví se po založení."),
  status: z.string().optional().describe("Slug stavu – nastaví se po založení (jinak výchozí)."),
  force_new: z.boolean().default(false).describe("Založit i přes podobný existující úkol (jen když jde opravdu o jinou práci)."),
};
const TASK_UPDATE = {
  id: ID,
  title: z.string().min(3).max(255).optional(),
  description: z.string().optional().describe("Nahradí celý popis."),
  append_description: z.string().optional().describe("Připíše na konec popisu."),
  deadline: DATE.nullable().optional().describe("null = smazat deadline."),
  start_date: DATE.nullable().optional(),
  estimated_hours: z.number().min(0).max(9999).nullable().optional(),
  project: z.string().nullable().optional().describe("Přesun do jiného projektu (null = bez projektu)."),
};
const TIME_LOG = {
  project: z.string().optional(),
  task: z.string().optional(),
  resolve_task_title: z.string().optional(),
  create_task: z.boolean().default(false),
  started_at: DATETIME.optional(),
  ended_at: DATETIME.optional(),
  duration_hours: z.number().positive().max(24).optional(),
  description: z.string().max(512).optional(),
  is_billable: z.boolean().default(true),
};

defineTool({
  name: "raqeto_task_create",
  description:
    "Založí úkol v Raqeto (jen BUDOUCÍ práce – ne věci, které jsou podle zdroje hotové). Dedup: když v projektu existuje podobný otevřený úkol, nic se nezaloží a vrátí se existující + rada doplnit ho přes raqeto_task_update. Do popisu uveď zdroj (např. „Zdroj: e-mail Novák 12. 5.“).",
  input: TASK_CREATE,
  node: "crm",
  handler: async (a, { run }) => {
    need();
    if (isTainted(run) && await R.projectHasClient(a.project)) throw new NeedsApproval(PORTAL);
    spendWrite(run);
    const r = await R.createTask(a);
    if (r.created) logWrite(run, "raqeto_task_create", r.id);
    return { ...r, task: w(r.task, ["description"], 300) };
  },
});

defineTool({
  name: "raqeto_task_update",
  description:
    "Upraví úkol v Raqeto (PATCH): název, popis, deadline, start, odhad hodin, projekt. append_description připíše text k popisu (bez duplicity). Prioritu měň přes raqeto_task_set_priority, stav přes raqeto_task_move.",
  input: {
    ...TASK_UPDATE,
    priority: z.string().optional().describe("NEPOUŽÍVAT – jen pro čtení, viz raqeto_task_set_priority."),
    status: z.string().optional().describe("NEPOUŽÍVAT – jen pro čtení, viz raqeto_task_move."),
  },
  node: "crm",
  handler: async ({ id, priority, status, ...fields }, { run }) => {
    need();
    if (priority !== undefined || status !== undefined) {
      throw new Error("Priorita a stav se přes úpravu úkolu nemění (v Raqeto jsou jen pro čtení). Použij raqeto_task_set_priority a raqeto_task_move.");
    }
    notOwnTask(run, id);
    const textOrProject = ["title", "description", "append_description", "project"].some((k) => fields[k as keyof typeof fields] !== undefined);
    const portal = textOrProject || fields.deadline !== undefined || fields.estimated_hours !== undefined;
    const tainted = isTainted(run);
    if (textOrProject || (tainted && portal)) {
      const x = await R.taskExposure(id);
      // the owner's approval (clean "approval" run) is exactly what CODING asks for
      if (textOrProject && x.codingAgent && run.source !== "approval") throw new NeedsApproval(CODING);
      if (tainted && portal && (x.clientVisible || await R.projectHasClient(fields.project))) throw new NeedsApproval(PORTAL);
    }
    spendWrite(run);
    const r = await R.updateTask(id, fields);
    logWrite(run, "raqeto_task_update", id);
    return { ...r, task: w(r.task, ["description"], 300) };
  },
});

defineTool({
  name: "raqeto_task_move",
  description: "Změní stav úkolu v Raqeto. new_status = slug ze seznamu raqeto_task_statuses (název stavu se převede), nebo __archived__ pro archivaci.",
  input: { id: ID, new_status: z.string().min(1) },
  node: "crm",
  handler: async ({ id, new_status }, { run }) => {
    need();
    notOwnTask(run, id);
    if (isTainted(run)) {
      const slug = await R.resolveStatus(new_status);
      if (slug === "__archived__" || (await R.taskStatuses()).find((s) => s.slug === slug)?.is_done) {
        throw new NeedsApproval(`${slug === "__archived__" ? "archivace" : "dokončení"} úkolu v kroku, kde byl přečten externí obsah, potvrzuje majitel.`);
      }
    }
    spendWrite(run);
    const { raw: _raw, ...r } = await R.moveTask(id, new_status);
    logWrite(run, "raqeto_task_move", id);
    return { ...r, task: r.task ? w(r.task, ["description"], 200) : null };
  },
});

defineTool({
  name: "raqeto_task_set_priority",
  description: "Nastaví prioritu úkolu v Raqeto (low / medium / high / urgent nebo vlastní slug workspace).",
  input: { id: ID, priority: z.string().min(2) },
  node: "crm",
  handler: async ({ id, priority }, { run }) => {
    need();
    notOwnTask(run, id);
    spendWrite(run);
    const r = await R.setTaskPriority(id, priority);
    logWrite(run, "raqeto_task_set_priority", id);
    return r;
  },
});

defineTool({
  name: "raqeto_schedule_add",
  description: "Naplánuje úkol na den do rozvrhu Raqeto. Když už na ten den naplánovaný je, nic se nezdvojí (případně se jen změní pozice). position je 0-based; bez ní na konec dne.",
  input: { task: ID.describe("UUID úkolu."), day: DATE, position: z.number().int().min(0).optional() },
  node: "chief_of_staff",
  handler: async ({ task, day, position }, { run }) => {
    need();
    spendWrite(run);
    const r = await R.scheduleAdd(task, day, position);
    logWrite(run, "raqeto_schedule_add", r.id);
    return r;
  },
});

defineTool({
  name: "raqeto_schedule_reorder",
  description: "Přeskládá pořadí položek rozvrhu Raqeto najednou (id položky rozvrhu → 0-based position).",
  input: { items: z.array(z.object({ id: z.string().min(1), position: z.number().int().min(0) })).min(1).max(200) },
  node: "chief_of_staff",
  handler: async ({ items }, { run }) => {
    need();
    if (isTainted(run) && items.length > REORDER_MAX) {
      throw new NeedsApproval(`v kroku s externím obsahem jde přímo přeskládat nejvýš ${REORDER_MAX} položek rozvrhu najednou (tady ${items.length}).`);
    }
    spendWrite(run);
    const r = await R.scheduleReorder(items);
    logWrite(run, "raqeto_schedule_reorder", `${items.length} položek`);
    return r;
  },
});

defineTool({
  name: "raqeto_time_log",
  description:
    "Zapíše odpracovaný čas do Raqeto (ručně). Zadej projekt nebo úkol (UUID) – úkol známý jen názvem: resolve_task_title + project (create_task=true ho případně založí). Délka: duration_hours, nebo started_at + ended_at. Přesná duplicita (stejný den, úkol/projekt a délka) se odmítne.",
  input: TIME_LOG,
  node: "finance",
  cleanOnly: true,
  handler: async (a, { run }) => {
    need();
    spendWrite(run);
    const r = await R.logTime(a);
    logWrite(run, "raqeto_time_log", r.id);
    return { ...r, entry: w(r.entry, ["description"], 200) };
  },
});

defineTool({
  name: "raqeto_timer_start",
  description: "Spustí timer v Raqeto na projekt nebo úkol. Raqeto drží jeden běžící timer na uživatele – jiný běžící se sám zastaví a dopočítá. Když už na stejnou práci timer běží, nic se nezdvojí.",
  input: {
    project: z.string().optional(),
    task: z.string().optional(),
    description: z.string().max(512).optional(),
    is_billable: z.boolean().default(true),
  },
  node: "finance",
  cleanOnly: true,
  handler: async (a, { run }) => {
    need();
    spendWrite(run);
    const r = await R.timerStart(a);
    logWrite(run, "raqeto_timer_start", r.id);
    return { ...r, entry: w(r.entry, ["description"], 200) };
  },
});

defineTool({
  name: "raqeto_timer_stop",
  description: "Zastaví běžící timer v Raqeto (Raqeto dopočítá délku). Bez id zastaví jediný běžící timer.",
  input: { id: z.string().optional() },
  node: "finance",
  cleanOnly: true,
  handler: async ({ id }, { run }) => {
    need();
    spendWrite(run);
    const r = await R.timerStop(id);
    logWrite(run, "raqeto_timer_stop", r.id);
    return { ...r, entry: w(r.entry, ["description"], 200) };
  },
});

const CATEGORY = z.enum(["meeting", "work_block", "booking", "personal", "other"]);

defineTool({
  name: "raqeto_calendar_create",
  description: "Založí interní událost v kalendáři Raqeto (nikomu se neposílá pozvánka). Stejná událost (název + začátek) se nezdvojí.",
  input: {
    title: z.string().min(2).max(255),
    start: DATETIME,
    end: DATETIME,
    all_day: z.boolean().optional(),
    description: z.string().optional(),
    location: z.string().max(255).optional(),
    category: CATEGORY.optional(),
    project: z.string().optional(),
    client: z.string().optional(),
    task: z.string().optional(),
  },
  node: "calendar",
  handler: async (a, { run }) => {
    need();
    spendWrite(run);
    const r = await R.calendarCreate(a);
    logWrite(run, "raqeto_calendar_create", r.id);
    return { ...r, event: w(r.event, ["description", "location"], 200) };
  },
});

defineTool({
  name: "raqeto_calendar_update",
  description: "Upraví událost v kalendáři Raqeto (jen zadaná pole).",
  input: {
    id: ID,
    title: z.string().min(2).max(255).optional(),
    start: DATETIME.optional(),
    end: DATETIME.optional(),
    all_day: z.boolean().optional(),
    description: z.string().optional(),
    location: z.string().max(255).optional(),
    category: CATEGORY.optional(),
    project: z.string().nullable().optional(),
    client: z.string().nullable().optional(),
    task: z.string().nullable().optional(),
  },
  node: "calendar",
  handler: async ({ id, ...fields }, { run }) => {
    need();
    spendWrite(run);
    const r = await R.calendarUpdate(id, fields);
    logWrite(run, "raqeto_calendar_update", id);
    return { ...r, event: w(r.event, ["description", "location"], 200) };
  },
});

defineTool({
  name: "raqeto_email_draft_create",
  description:
    "Založí návrh e-mailu v Raqeto (sekce Psaní e-mailů). Raqeto AI vygeneruje text (status generating → pending). NIC SE NEODESÍLÁ. mode: reply = odpověď na source_text, compose = nový mail z bodů, rewrite = přeformulovat text. Stejný zdrojový text se nezdvojí.",
  input: {
    mode: z.enum(["reply", "compose", "rewrite"]),
    source_text: z.string().min(3),
    subject: z.string().max(255).optional(),
    instructions: z.string().max(255).optional(),
    client: z.string().optional(),
    project: z.string().optional(),
    task: z.string().optional(),
  },
  node: "email",
  handler: async (a, { run }) => {
    need();
    spendWrite(run);
    const r = await R.emailDraftCreate(a);
    logWrite(run, "raqeto_email_draft_create", r.id);
    return r;
  },
});

defineTool({
  name: "raqeto_email_draft_update",
  description: "Upraví návrh e-mailu v Raqeto (tělo, předmět, instrukce). Stav se tu nemění – označit jako odeslaný jde jen návrhem propose_raqeto_email_mark_sent.",
  input: {
    id: ID,
    body: z.string().optional(),
    subject: z.string().max(255).optional(),
    instructions: z.string().max(255).optional(),
  },
  node: "email",
  handler: async ({ id, ...fields }, { run }) => {
    need();
    spendWrite(run);
    const r = await R.emailDraftUpdate(id, fields);
    logWrite(run, "raqeto_email_draft_update", id);
    return r;
  },
});

defineTool({
  name: "raqeto_brief_upsert",
  description:
    "Doplní brief projektu v Raqeto (jeden živý brief na projekt: existující se doplní o nové sekce, jinak se založí). Obsah = POUZE zadání práce ve tvaru <h3>N. Název</h3><p>Co a jak.</p> – bez historie komunikace, kontaktů, ID a odkazů na raw soubory.",
  input: {
    project_id: ID.describe("UUID projektu."),
    content_html: z.string().min(10).superRefine((v, ctx) => {
      const problem = R.briefContentProblem(v);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }).describe("Sekce zadání: <h3>1. Název</h3><p>Co a jak.</p>…"),
    task_ids: z.array(z.string()).optional().describe("UUID úkolů, které k briefu patří."),
    title: z.string().max(255).optional().describe("Název, jen když se brief zakládá."),
  },
  node: "crm",
  handler: async (a, { run }) => {
    need();
    spendWrite(run);
    const r = await R.upsertBrief(a);
    logWrite(run, "raqeto_brief_upsert", r.id);
    return r;
  },
});

defineTool({
  name: "raqeto_interaction_mark_replied",
  description: "Označí zprávu v komunikaci Raqeto jako zodpovězenou (po odeslání odpovědi). Zadej id interakce, nebo channel + external_id.",
  input: {
    id: z.string().optional(),
    channel: z.enum(["email", "whatsapp", "messenger", "call", "note"]).optional(),
    external_id: z.string().optional(),
  },
  node: "email",
  cleanOnly: true,
  handler: async (a, { run }) => {
    need();
    spendWrite(run);
    const r = await R.markInteractionReplied(a);
    logWrite(run, "raqeto_interaction_mark_replied", a.id ?? a.external_id);
    return r;
  },
});

defineTool({
  name: "raqeto_comment_internal",
  description: "Přidá INTERNÍ komentář (klient ho v portálu nevidí) k úkolu nebo projektu v Raqeto. Komentář viditelný klientovi jde jen návrhem propose_raqeto_comment_add.",
  input: {
    target: z.enum(["task", "project"]),
    id: ID.describe("UUID úkolu / projektu."),
    body: z.string().min(2),
  },
  node: "crm",
  handler: async ({ target, id, body }, { run }) => {
    need();
    if (target === "task") notOwnTask(run, id);
    spendWrite(run);
    const r = await R.addComment({ target, id, body, is_internal: true });
    logWrite(run, "raqeto_comment_internal", r.id);
    return r;
  },
});

/* ═════════════ APPROVAL actions (client-visible / money / destructive) ═════════════ */

defineAction({
  kind: "raqeto_client_upsert",
  label: "Klient v Raqeto",
  description:
    "Navrhne klienta v Raqeto. Nejdřív se hledá podle IČO, pak podle jména; existující (i neaktivní – ten se znovu aktivuje) se jen doplní o chybějící údaje, nikdy se nezakládá duplicita.",
  input: {
    name: z.string().min(2).max(255).describe("Jméno / obchodní název."),
    company: z.string().max(255).optional(),
    ico: z.string().regex(/^\s*\d[\d\s]{5,9}\s*$/, "IČO jsou číslice.").optional(),
    dic: z.string().max(32).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(64).optional(),
    address: z.string().optional(),
    notes: z.string().optional(),
  },
  node: "crm",
  summarize: (p) => `Klient v Raqeto: ${p.name}${p.ico ? ` (IČO ${p.ico.trim()})` : ""} – založit, nebo doplnit existujícího`,
  execute: (p) => R.upsertClient(p),
  ready: notReady,
});

defineAction({
  kind: "raqeto_project_upsert",
  label: "Projekt v Raqeto",
  description:
    "Navrhne projekt v Raqeto. S project_id upraví existující; jinak hledá podobný projekt klienta (název) a ten upraví – nový se založí jen když žádný není.",
  input: {
    project_id: z.string().optional().describe("UUID existujícího projektu k úpravě."),
    name: z.string().min(2).max(255),
    client: z.string().optional().describe("UUID klienta."),
    description: z.string().optional().describe("U existujícího se připíše."),
    status: z.enum(["active", "on_hold", "completed", "archived"]).optional(),
    hourly_rate: z.number().min(0).optional().describe("Kč/h."),
    budget_hours: z.number().min(0).optional(),
    budget_amount: z.number().min(0).optional().describe("Kč."),
    deadline: DATE.optional(),
  },
  node: "crm",
  summarize: (p) => [
    `${p.project_id ? "Upravit projekt" : "Projekt"} v Raqeto: „${p.name}“`,
    p.status && `stav ${p.status}`, p.hourly_rate != null && `${p.hourly_rate} Kč/h`,
    p.budget_hours != null && `budget ${p.budget_hours} h`, p.budget_amount != null && `budget ${p.budget_amount} Kč`, p.deadline && `do ${p.deadline}`,
  ].filter(Boolean).join(", "),
  execute: (p) => R.upsertProject(p),
  ready: notReady,
});

defineAction({
  kind: "raqeto_comment_add",
  label: "Komentář v Raqeto",
  description: "Navrhne komentář k úkolu nebo projektu v Raqeto. Neinterní komentář uvidí klient v portálu. Stejný text se nezdvojí.",
  input: {
    target: z.enum(["task", "project"]),
    id: ID.describe("UUID úkolu / projektu."),
    body: z.string().min(2),
    is_internal: z.boolean().default(false).describe("true = klient nevidí."),
    parent: z.string().optional().describe("UUID komentáře, na který se odpovídá."),
  },
  node: "crm",
  summarize: (p) => `${p.is_internal ? "Interní komentář" : "Komentář viditelný klientovi"} k ${p.target === "task" ? "úkolu" : "projektu"}: „${p.body.slice(0, 80)}${p.body.length > 80 ? "…" : ""}“`,
  execute: (p) => R.commentEvidence(p),
  ready: notReady,
});

/* Portal-visible task text / billed time from a tainted run goes through the
 * owner (see header); same validation and dedup as the direct tools. */
defineAction({
  kind: "raqeto_task_create",
  label: "Úkol v Raqeto",
  description: "Navrhne založení úkolu v Raqeto – pro úkoly v projektu klienta (klient je vidí v portálu), když přímé raqeto_task_create odmítne. Podobný otevřený úkol v projektu se nezdvojí.",
  input: TASK_CREATE,
  node: "crm",
  prepare: async (p) => {
    need();
    const dup = p.force_new ? null : await R.findDuplicateTask(p.title, p.project);
    if (dup) throw new Error(`Podobný otevřený úkol už existuje (${dup.id}: „${dup.title}“) – navrhni jeho úpravu přes propose_raqeto_task_update, nebo zopakuj s force_new=true.`);
    return p;
  },
  summarize: (p) => [`Úkol v Raqeto: „${p.title}“`, p.deadline && `do ${p.deadline}`, p.estimated_hours != null && `odhad ${p.estimated_hours} h`, p.project && "(v projektu – vidí ho i klient v portálu)"].filter(Boolean).join(", "),
  execute: async (p) => (await R.createTask(p)).evidence,
  ready: notReady,
});

defineAction({
  kind: "raqeto_task_update",
  label: "Úprava úkolu v Raqeto",
  description: "Navrhne úpravu úkolu v Raqeto (název, popis, termín, odhad, projekt) – pro úkoly klienta (vidí je v portálu) nebo úkoly kódovacího agenta, když přímé raqeto_task_update odmítne.",
  input: TASK_UPDATE,
  node: "crm",
  prepare: async (p) => {
    need();
    const { id, ...fields } = p;
    if (!Object.values(fields).some((v) => v !== undefined)) throw new Error("Není co měnit – zadej aspoň jedno pole.");
    await R.taskExposure(id); // readable error when the task does not exist
    return p;
  },
  summarize: (p) => {
    const parts = [
      p.title !== undefined && `název „${p.title}“`, p.description !== undefined && "nový popis", p.append_description && `doplnit popis: „${clip(p.append_description, 80)}“`,
      p.deadline !== undefined && `termín ${p.deadline ?? "smazat"}`, p.start_date !== undefined && `start ${p.start_date ?? "smazat"}`,
      p.estimated_hours !== undefined && `odhad ${p.estimated_hours ?? "smazat"} h`, p.project !== undefined && (p.project ? "přesun do jiného projektu" : "bez projektu"),
    ].filter(Boolean);
    return `Upravit úkol v Raqeto: ${parts.join(", ")}`;
  },
  execute: async ({ id, ...fields }) => (await R.updateTask(id, fields)).evidence,
  ready: notReady,
});

defineAction({
  kind: "raqeto_time_log",
  label: "Odpracovaný čas v Raqeto",
  description: "Navrhne zápis odpracovaného času do Raqeto (ovlivní fakturaci a čísla v portálu klienta) – když přímé raqeto_time_log nejde. Stejná pravidla i kontrola duplicity.",
  input: TIME_LOG,
  node: "finance",
  prepare: async (p) => {
    need();
    await R.checkTimeLog(p);
    return p;
  },
  summarize: (p) => [
    `Zapsat čas do Raqeto: ${p.duration_hours != null ? `${p.duration_hours} h` : `${p.started_at} – ${p.ended_at}`}`,
    p.resolve_task_title && `úkol „${p.resolve_task_title}“`, p.is_billable === false ? "nefakturovatelně" : "fakturovatelně",
    p.description && `„${clip(p.description, 80)}“`,
  ].filter(Boolean).join(", "),
  execute: async (p) => (await R.logTime(p)).evidence,
  ready: notReady,
});

defineAction({
  kind: "raqeto_invoice_create",
  label: "Faktura (koncept) v Raqeto",
  description:
    "Navrhne koncept faktury v Raqeto (číslo přidělí až vystavení). Položky se doplňují v Raqeto – bez položek nejde fakturu vystavit. Koncept pro stejného klienta, projekt a období se nezdvojí.",
  input: {
    client: ID.describe("UUID klienta."),
    project: z.string().optional(),
    task: z.string().optional(),
    issued_date: DATE.optional(),
    due_date: DATE,
    period_from: DATE.optional(),
    period_to: DATE.optional(),
    tax_rate: z.number().min(0).max(100).optional().describe("Sazba DPH v %."),
    currency: z.string().min(3).max(8).optional().describe("Výchozí CZK."),
    variable_symbol: z.string().max(32).optional(),
    notes: z.string().optional(),
  },
  node: "finance",
  summarize: (p) => `Koncept faktury v Raqeto: splatnost ${p.due_date}${p.period_from ? `, období ${p.period_from}–${p.period_to ?? "?"}` : ""}${p.currency ? `, ${p.currency}` : ""}`,
  execute: (p) => R.invoiceCreate(p),
  ready: notReady,
});

defineAction({
  kind: "raqeto_invoice_send",
  label: "Vystavit fakturu v Raqeto",
  description: "Navrhne vystavení konceptu faktury: přidělí finální číslo z řady, vyrenderuje PDF a pošle klientovi ke schválení. Nevratné.",
  input: {
    id: ID.describe("UUID faktury (koncept)."),
    label: z.string().optional().describe("Klient / částka pro přehled ve schválení."),
  },
  node: "finance",
  summarize: (p) => `Vystavit a poslat fakturu klientovi${p.label ? `: ${p.label}` : ""} (nevratné – číslo se spotřebuje)`,
  execute: (p) => R.invoiceSend(p.id),
  ready: notReady,
});

defineAction({
  kind: "raqeto_quote_create",
  label: "Nabídka (koncept) v Raqeto",
  description: "Navrhne cenovou nabídku v Raqeto jako koncept. Podobný koncept pro stejného klienta se upraví místo duplicity.",
  input: {
    client: ID.describe("UUID klienta."),
    title: z.string().min(2).max(255),
    amount: z.number().min(0),
    currency: z.string().min(3).max(8).optional(),
    body: z.string().optional(),
    project: z.string().optional(),
    task: z.string().optional(),
  },
  node: "finance",
  summarize: (p) => `Nabídka v Raqeto: „${p.title}“ za ${p.amount} ${p.currency ?? "CZK"}`,
  execute: (p) => R.quoteCreate(p),
  ready: notReady,
});

defineAction({
  kind: "raqeto_quote_send",
  label: "Odeslat nabídku v Raqeto",
  description: "Navrhne odeslání konceptu nabídky klientovi (draft → sent).",
  input: { id: ID.describe("UUID nabídky."), label: z.string().optional() },
  node: "finance",
  summarize: (p) => `Odeslat nabídku klientovi${p.label ? `: ${p.label}` : ""}`,
  execute: (p) => R.quoteSend(p.id),
  ready: notReady,
});

defineAction({
  kind: "raqeto_task_approval",
  label: "Schválení úkolu v Raqeto",
  description: "Navrhne rozhodnutí o úkolu čekajícím na schválení (approve = schválit, return = vrátit k úpravě s poznámkou).",
  input: {
    id: ID.describe("UUID úkolu."),
    action: z.enum(["approve", "return"]),
    note: z.string().optional(),
    label: z.string().optional().describe("Název úkolu pro přehled."),
  },
  node: "crm",
  summarize: (p) => `${p.action === "approve" ? "Schválit" : "Vrátit k úpravě"} úkol${p.label ? ` „${p.label}“` : ""}${p.note ? ` – ${p.note.slice(0, 80)}` : ""}`,
  execute: (p) => R.taskApproval(p.id, p.action, p.note),
  ready: notReady,
});

defineAction({
  kind: "raqeto_email_mark_sent",
  label: "E-mail odeslán (Raqeto)",
  description: "Navrhne označení návrhu e-mailu v Raqeto jako odeslaného (po ručním odeslání).",
  input: { id: ID.describe("UUID návrhu e-mailu."), label: z.string().optional().describe("Předmět pro přehled.") },
  node: "email",
  summarize: (p) => `Označit návrh e-mailu jako odeslaný${p.label ? `: ${p.label}` : ""}`,
  execute: (p) => R.emailMarkSent(p.id),
  ready: notReady,
});

defineAction({
  kind: "raqeto_delete",
  label: "Smazat v Raqeto",
  description: "Navrhne smazání položky v Raqeto: úkol, událost v kalendáři, položka rozvrhu, návrh e-mailu nebo časový záznam (vyfakturovaný záznam smazat nejde). Nevratné – uveď důvod.",
  input: {
    resource: z.enum(["task", "calendar", "schedule", "email_draft", "time_entry"]),
    id: ID,
    reason: z.string().min(3).describe("Proč smazat."),
    label: z.string().optional().describe("Doplní se automaticky – co se maže."),
  },
  node: "crm",
  prepare: async (p) => ({ ...p, label: await R.describeForDelete(p.resource, p.id) }),
  summarize: (p) => `Smazat v Raqeto (${({ task: "úkol", calendar: "událost", schedule: "položka rozvrhu", email_draft: "návrh e-mailu", time_entry: "časový záznam" } as const)[p.resource]}): ${p.label || p.id} – ${p.reason}`,
  execute: (p) => R.deleteResource(p.resource, p.id),
  ready: notReady,
});
