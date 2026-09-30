import { z } from "zod";
import { defineTool, untrusted } from "./registry";
import { defineAction } from "../actions";
import {
  NOT_CONFIGURED, raqetoConfigured, raqetoPing, raqetoList, raqetoOptionalEndpoint, raqetoOverview,
  listClients, listProjects, listTasks, listBriefs, timeEntries, localDate,
  upsertTask, upsertBrief, upsertClient, createTimeEntry, briefContentProblem,
} from "../integrations/raqeto";

/* Raqeto CRM tools. Reads are live API calls (Raqeto is the source of truth
 * for clients, projects, tasks, hours, briefs). CRM free text can come from
 * clients, so every read taints the run and wraps text in untrusted(). Writes
 * exist only as approved actions; their executors do the SCHEMA §10 dedup
 * check (PATCH instead of a duplicate POST). */

const wrap = (text: string) => (text ? untrusted("raqeto", text) : "");
const notReady = () => (raqetoConfigured() ? null : "RAQETO_API_TOKEN není nastavený v .env.local – akce po schválení selže.");
function need() {
  if (!raqetoConfigured()) throw new Error(NOT_CONFIGURED);
}

defineTool({
  name: "raqeto_clients",
  description: "Klienti z Raqeto CRM (zdroj pravdy o klientech: IČO, DIČ, adresa, kontakt). Hledání podle jména nebo IČO; standardně jen aktivní.",
  input: {
    search: z.string().optional().describe("Část jména / firmy."),
    ico: z.string().optional().describe("IČO – přesná shoda."),
    include_archived: z.boolean().default(false).describe("Zahrnout i archivované (neaktivní) klienty."),
  },
  node: "crm",
  taints: true,
  handler: async ({ search, ico, include_archived }) => {
    need();
    const rows = await listClients({ search, ico, includeArchived: include_archived });
    return { count: rows.length, clients: rows.slice(0, 100).map((c) => ({ ...c, notes: wrap(c.notes) })) };
  },
});

defineTool({
  name: "raqeto_projects",
  description: "Projekty z Raqeto CRM: stav, klient, deadline, hodinová sazba, budget a vyčerpání (odpracované hodiny).",
  input: {
    status: z.string().optional().describe("Stav, např. active / archived. Bez zadání všechny."),
    client_id: z.string().optional().describe("ID klienta v Raqeto (UUID)."),
    search: z.string().optional().describe("Část názvu projektu."),
  },
  node: "crm",
  taints: true,
  handler: async ({ status, client_id, search }) => {
    need();
    const rows = await listProjects({ status, clientId: client_id, search });
    return { count: rows.length, projects: rows.slice(0, 100).map((p) => ({ ...p, description: wrap(p.description) })) };
  },
});

defineTool({
  name: "raqeto_tasks",
  description: "Úkoly z Raqeto CRM (priorita, deadline, projekt). Seřazeno: po termínu nejdřív, pak priorita a deadline.",
  input: {
    project_id: z.string().optional().describe("ID projektu v Raqeto (UUID)."),
    status: z.string().optional().describe("Konkrétní stav úkolu (přebije open_only)."),
    open_only: z.boolean().default(true).describe("Jen otevřené (nedokončené) úkoly."),
    search: z.string().optional().describe("Hledaný text v názvu nebo popisu."),
    limit: z.number().int().min(1).max(200).default(50),
  },
  node: "crm",
  taints: true,
  handler: async ({ project_id, status, open_only, search, limit }) => {
    need();
    const rows = await listTasks({ projectId: project_id, status, openOnly: open_only, search, limit });
    return { count: rows.length, tasks: rows.map((t) => ({ ...t, description: wrap(t.description) })) };
  },
});

defineTool({
  name: "raqeto_briefs",
  description: "Briefy (zadání práce) k projektu v Raqeto – obsah HTML a navázané úkoly.",
  input: { project_id: z.string().min(1).describe("ID projektu v Raqeto (UUID).") },
  node: "crm",
  taints: true,
  handler: async ({ project_id }) => {
    need();
    const rows = await listBriefs(project_id);
    return { count: rows.length, briefs: rows.map((b) => ({ ...b, content: wrap(b.content) })) };
  },
});

defineTool({
  name: "raqeto_time_entries",
  description: "Odpracovaný čas z Raqeto: součet hodin, fakturovatelné vs. nefakturovatelné, rozpad podle projektů. Datum ve tvaru YYYY-MM-DD.",
  input: {
    project_id: z.string().optional().describe("ID projektu v Raqeto (UUID)."),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Od data (včetně)."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Do data (včetně)."),
  },
  node: "finance",
  taints: true,
  handler: async ({ project_id, from, to }) => {
    need();
    const r = await timeEntries({ projectId: project_id, from, to });
    return { ...r, entries: r.entries.map((e) => ({ ...e, description: wrap(e.description) })) };
  },
});

defineTool({
  name: "raqeto_overview",
  description: "Přehled z Raqeto: aktivní projekty (deadline, vyčerpání budgetu) a otevřené úkoly – nejdřív po termínu, pak podle priority a deadline.",
  input: {},
  node: "crm",
  taints: true,
  handler: async () => {
    need();
    const o = await raqetoOverview();
    discoverOptional().catch(() => { /* optional sections stay hidden */ });
    return {
      today: localDate(),
      counts: o.counts,
      projects: o.projects.map((p) => ({ ...p, description: wrap(p.description) })),
      tasks: o.tasks.map((t) => ({ ...t, description: wrap(t.description) })),
    };
  },
});

/* Invoices / calendar exist only if the API root lists them (checked at
 * runtime, cached 1 h) - registered once discovered, never guessed. */
const g = globalThis as { __apexRaqetoOptional?: Set<string> };
const optional = (g.__apexRaqetoOptional ??= new Set());

type Obj = Record<string, any>;
const DATE_KEYS = ["start", "start_at", "starts_at", "start_time", "date", "started_at", "issued_at", "issue_date"];
function flat(o: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || ["number", "boolean"].includes(typeof v)) out[k] = v;
    else if (typeof v === "string") out[k] = /name|title|description|note|content|text|location/i.test(k) ? wrap(v) : v;
  }
  return out;
}

function registerOptional(kind: "invoices" | "calendar") {
  if (optional.has(kind)) return;
  optional.add(kind);
  if (kind === "invoices") {
    defineTool({
      name: "raqeto_invoices",
      description: "Faktury z Raqeto (stav, částky, klient). Volitelný filtr stavu.",
      input: { status: z.string().optional().describe("Stav faktury, např. paid / unpaid / overdue.") },
      node: "finance",
      taints: true,
      handler: async ({ status }) => {
        need();
        const path = await raqetoOptionalEndpoint("invoices");
        if (!path) throw new Error("Raqeto API faktury nezpřístupňuje.");
        const rows = (await raqetoList<Obj>(path, { status })).filter((r) => !status || String(r.status ?? "") === status);
        return { count: rows.length, invoices: rows.slice(0, 100).map(flat) };
      },
    });
  } else {
    defineTool({
      name: "raqeto_calendar",
      description: "Události z kalendáře v Raqeto v rozsahu dat (YYYY-MM-DD, včetně).",
      input: {
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Od data."),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Do data."),
      },
      node: "calendar",
      taints: true,
      handler: async ({ from, to }) => {
        need();
        const path = await raqetoOptionalEndpoint("calendar");
        if (!path) throw new Error("Raqeto API kalendář nezpřístupňuje.");
        const rows = (await raqetoList<Obj>(path)).filter((r) => {
          const key = DATE_KEYS.find((k) => r[k]);
          if (!key) return true;
          const d = localDate(new Date(r[key]));
          return d >= from && d <= to;
        });
        return { count: rows.length, events: rows.slice(0, 100).map(flat) };
      },
    });
  }
}

async function discoverOptional() {
  if (!raqetoConfigured()) return;
  for (const kind of ["invoices", "calendar"] as const) {
    if (!optional.has(kind) && (await raqetoOptionalEndpoint(kind))) registerOptional(kind);
  }
}
discoverOptional().catch(() => { /* retried by raqeto_overview / raqeto_status */ });

defineTool({
  name: "raqeto_status",
  description: "Stav napojení na Raqeto (nastaveno, dostupné) a které volitelné sekce API zpřístupňuje (faktury, kalendář).",
  input: {},
  node: "crm",
  handler: async () => {
    if (!raqetoConfigured()) return { configured: false, note: NOT_CONFIGURED };
    const st = await raqetoPing(true);
    if (st.ok) await discoverOptional();
    return { configured: true, ok: !!st.ok, error: st.error, invoices: optional.has("invoices"), calendar: optional.has("calendar") };
  },
});

/* ── approved writes (SCHEMA §10 dedup inside execute) ── */

const PRIORITY = z.enum(["low", "medium", "high"]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ve tvaru YYYY-MM-DD.");

defineAction({
  kind: "raqeto_task_upsert",
  label: "Úkol v Raqeto",
  description:
    "Navrhne úkol v Raqeto CRM. Jen pro BUDOUCÍ práci – ne pro věci, které jsou podle zdroje hotové. Před vytvořením se zkontrolují úkoly projektu: podobný otevřený úkol se doplní (PATCH) místo duplicity. Popis musí uvádět zdroj (např. „Zdroj: e-mail Novák 12. 5.“).",
  input: {
    project_id: z.string().min(1).describe("ID projektu v Raqeto (UUID)."),
    title: z.string().min(3).max(200).describe("Stručný název úkolu."),
    description: z.string().min(10).refine((d) => /zdroj|source/i.test(d), "Popis musí uvádět zdroj úkolu („Zdroj: …“).").describe("Co a jak udělat + „Zdroj: …“."),
    priority: PRIORITY.optional(),
    deadline: DATE.optional(),
    task_id: z.string().optional().describe("ID existujícího úkolu, pokud víš, že se má upravit."),
  },
  node: "crm",
  summarize: (p) => `${p.task_id ? "Upravit" : "Úkol"} v Raqeto: „${p.title}“${p.priority ? ` (${p.priority})` : ""}${p.deadline ? `, do ${p.deadline}` : ""}`,
  execute: (p) => upsertTask(p),
  ready: notReady,
});

defineAction({
  kind: "raqeto_brief_upsert",
  label: "Brief v Raqeto",
  description:
    "Navrhne doplnění briefu projektu v Raqeto (jeden živý brief na projekt: existující se doplní, jinak se založí). Obsah = POUZE zadání práce ve tvaru <h3>N. Název</h3><p>Co a jak.</p> – bez historie komunikace, kontaktů, ID a odkazů na raw soubory.",
  input: {
    project_id: z.string().min(1).describe("ID projektu v Raqeto (UUID)."),
    content_html: z.string().min(10).superRefine((v, ctx) => {
      const problem = briefContentProblem(v);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }).describe("Sekce zadání: <h3>1. Název</h3><p>Co a jak.</p>…"),
    task_ids: z.array(z.string()).optional().describe("ID úkolů, které k briefu patří."),
    title: z.string().optional().describe("Název briefu, jen pokud se zakládá nový (jinak podle projektu)."),
  },
  node: "crm",
  summarize: (p) => {
    const n = (p.content_html.match(/<h3[\s>]/gi) || []).length;
    return `Brief v Raqeto: +${n} ${n === 1 ? "sekce" : "sekcí"}${p.task_ids?.length ? `, ${p.task_ids.length} úkolů` : ""}`;
  },
  execute: (p) => upsertBrief(p),
  ready: notReady,
});

defineAction({
  kind: "raqeto_client_upsert",
  label: "Klient v Raqeto",
  description:
    "Navrhne klienta v Raqeto. Nejdřív se hledá podle IČO, pak podle jména; existující (i archivovaný – ten se znovu aktivuje) se jen doplní o chybějící údaje, nikdy se nezakládá duplicita.",
  input: {
    name: z.string().min(2).describe("Jméno / obchodní název."),
    ico: z.string().regex(/^\s*\d[\d\s]{5,9}\s*$/, "IČO jsou číslice.").optional(),
    dic: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
  },
  node: "crm",
  summarize: (p) => `Klient v Raqeto: ${p.name}${p.ico ? ` (IČO ${p.ico.trim()})` : ""}`,
  execute: (p) => upsertClient(p),
  ready: notReady,
});

defineAction({
  kind: "raqeto_time_entry",
  label: "Odpracovaný čas v Raqeto",
  description:
    "Navrhne zápis odpracovaného času do projektu v Raqeto. Pokud už ten den v projektu existuje záznam se stejnou délkou, provedení se odmítne jako duplicita.",
  input: {
    project_id: z.string().min(1).describe("ID projektu v Raqeto (UUID)."),
    started_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Neplatné datum a čas (ISO, např. 2026-09-30T09:00).").describe("Začátek práce (ISO datum a čas)."),
    duration_minutes: z.number().int().min(1).max(24 * 60),
    description: z.string().min(3).describe("Co se dělalo."),
    billable: z.boolean().default(true),
  },
  node: "finance",
  summarize: (p) => `Čas v Raqeto: ${p.duration_minutes} min ${p.started_at.slice(0, 10)}${p.billable ? "" : " (nefakturovat)"} – ${p.description.slice(0, 60)} (při shodné délce týž den se odmítne jako duplicita)`,
  execute: (p) => createTimeEntry(p),
  ready: notReady,
});
