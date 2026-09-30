import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getRun, internalToken } from "@/server/events";
import { agentMayUse } from "@/server/agents";
import { allTools, callTool, getTool, jsonSchema } from "@/server/tools";
import { isLoopback } from "@/lib/localOnly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Used only by the MCP bridge processes this server spawns (lib/mcp/apex-mcp.mjs).
 * Auth: loopback + the per-process secret + a live run id. */
function authorize(request: Request) {
  if (!isLoopback(request)) return null;
  const got = Buffer.from(request.headers.get("x-apex-token") || "");
  const want = Buffer.from(internalToken());
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return getRun(request.headers.get("x-apex-run") || "") ?? null;
}

export async function GET(request: Request) {
  const run = authorize(request);
  if (!run) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const tools = allTools()
    .filter((t) => agentMayUse(run.agent, t.name, run.depth))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t) }));
  return NextResponse.json({ tools });
}

export async function POST(request: Request) {
  const run = authorize(request);
  if (!run) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { name, arguments: args } = (await request.json().catch(() => ({}))) as { name?: string; arguments?: unknown };
  const def = name ? getTool(name) : undefined;
  if (!def || !agentMayUse(run.agent, def.name, run.depth)) {
    return NextResponse.json({ text: `Nástroj ${name} není pro agenta ${run.agent} dostupný.`, isError: true });
  }
  return NextResponse.json(await callTool(def, args, { run }));
}
