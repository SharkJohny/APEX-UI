import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import { listClients, listProjects, listTasks, raqetoConfigured, raqetoOverview, raqetoPing, raqetoStatus } from "@/server/integrations/raqeto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Read-only Raqeto data for the Deck: ?section=overview|clients|projects|tasks.
 * The token stays on the server; only normalized records go out. */
const SECTIONS = ["overview", "clients", "projects", "tasks"] as const;
type Section = (typeof SECTIONS)[number];

export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const url = new URL(request.url);
  const section = (url.searchParams.get("section") || "overview") as Section;
  if (!SECTIONS.includes(section)) return NextResponse.json({ error: `Neznámá sekce – povolené: ${SECTIONS.join(", ")}.` }, { status: 400 });
  if (!raqetoConfigured()) return NextResponse.json({ ...raqetoStatus(), section });
  try {
    let data: Record<string, unknown>;
    if (section === "overview") data = await raqetoOverview();
    else if (section === "clients") data = { clients: await listClients({ includeArchived: url.searchParams.get("archived") === "1" }) };
    else if (section === "projects") data = { projects: await listProjects({ status: url.searchParams.get("status") || "active" }) };
    else data = { tasks: await listTasks({ projectId: url.searchParams.get("project") || undefined, openOnly: true, limit: 200 }) };
    return NextResponse.json({ ...(await raqetoPing()), section, ...data });
  } catch (e) {
    return NextResponse.json({ configured: true, section, error: e instanceof Error ? e.message : String(e) });
  }
}
