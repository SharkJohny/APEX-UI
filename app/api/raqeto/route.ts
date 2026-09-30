import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import {
  aiQueueList, listClients, listInteractions, listInvoices, listProjects, listSchedule, listTasks, localDate,
  raqetoConfigured, raqetoOverview, raqetoPing, raqetoStatus,
} from "@/server/integrations/raqeto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Read-only Raqeto data for the Deck:
 * ?section=overview|clients|projects|tasks|invoices|interactions|queue|schedule.
 * The token stays on the server; only normalized records go out. Tasks carry
 * `name` as an alias of `title` for older Deck components. */
const SECTIONS = ["overview", "clients", "projects", "tasks", "invoices", "interactions", "queue", "schedule"] as const;
type Section = (typeof SECTIONS)[number];

const withName = <T extends { title: string }>(t: T) => ({ ...t, name: t.title });

async function load(section: Section, q: URLSearchParams): Promise<Record<string, unknown>> {
  switch (section) {
    case "overview": {
      const { open_tasks, ...o } = await raqetoOverview();
      return { ...o, tasks: open_tasks.map(withName), overdue_tasks: o.overdue_tasks.map(withName), due_today: o.due_today.map(withName), due_this_week: o.due_this_week.map(withName) };
    }
    case "clients":
      return { clients: await listClients({ includeArchived: q.get("archived") === "1", search: q.get("search") || undefined }) };
    case "projects":
      return { projects: await listProjects({ status: q.get("status") || "active", clientId: q.get("client") || undefined }) };
    case "tasks": {
      const r = await listTasks({ project: q.get("project") || undefined, status: q.get("status") || undefined, openOnly: q.get("all") !== "1", limit: 200 });
      return { count: r.count, truncated: r.truncated, tasks: r.tasks.map(withName) };
    }
    case "invoices":
      return await listInvoices({ unpaidOnly: q.get("unpaid") === "1", overdueOnly: q.get("overdue") === "1", status: q.get("status") || undefined, client: q.get("client") || undefined });
    case "interactions":
      return await listInteractions({ needsReply: q.get("needs_reply") !== "0", client: q.get("client") || undefined, limit: 50 });
    case "queue": {
      const [queued, running, review, failed] = await Promise.all([aiQueueList("queued"), aiQueueList("running", 20), aiQueueList("review", 20), aiQueueList("failed", 10)]);
      return { queued, running, review, failed };
    }
    case "schedule": {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(q.get("date") ?? "") ? q.get("date")! : localDate();
      return { date: day, entries: await listSchedule(day, day) };
    }
  }
}

export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const url = new URL(request.url);
  const section = (url.searchParams.get("section") || "overview") as Section;
  if (!SECTIONS.includes(section)) return NextResponse.json({ error: `Neznámá sekce – povolené: ${SECTIONS.join(", ")}.` }, { status: 400 });
  if (!raqetoConfigured()) return NextResponse.json({ ...raqetoStatus(), section });
  try {
    const [status, data] = await Promise.all([raqetoPing(), load(section, url.searchParams)]);
    return NextResponse.json({ ...status, section, ...data });
  } catch (e) {
    return NextResponse.json({ ...raqetoStatus(), section, error: e instanceof Error ? e.message : String(e) });
  }
}
