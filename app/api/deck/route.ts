import { NextResponse } from "next/server";
import { z } from "zod";
import { all, get, run as dbRun } from "@/server/db";
import { latestGuide } from "@/server/orchestrator";
import { listLoops, loopRuns, runLoopNow, updateLoop } from "@/server/loops";
import { isLoopback } from "@/lib/localOnly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Command Deck data. GET ?section=… returns plain JSON for one panel;
 * POST {op, …} applies one owner edit (guide, loops, memory, tasks, leads). */

const SECTIONS = ["jobs", "crm", "memory", "loops", "guide", "calls", "tasks", "overview"] as const;
type Section = (typeof SECTIONS)[number];

function read(section: Section, agent: string | null, limit: number): unknown {
  switch (section) {
    case "jobs":
      return agent
        ? all("SELECT id, agent, status, source, input, output, created_at, finished_at FROM jobs WHERE agent = ? ORDER BY id DESC LIMIT ?", agent, limit)
        : all("SELECT id, agent, status, source, input, output, created_at, finished_at FROM jobs ORDER BY id DESC LIMIT ?", limit);
    case "crm":
      return {
        clients: all("SELECT * FROM clients ORDER BY name COLLATE NOCASE LIMIT ?", limit),
        leads: all(
          `SELECT l.*, c.name AS client_name FROM leads l LEFT JOIN clients c ON c.id = l.client_id
           ORDER BY (l.stage IN ('enquiry','quote')) DESC, l.updated_at DESC LIMIT ?`, limit),
        payments: all(
          `SELECT p.*, c.name AS client_name FROM payments p LEFT JOIN clients c ON c.id = p.client_id
           ORDER BY p.paid_at DESC, p.id DESC LIMIT 50`),
      };
    case "memory":
      return all("SELECT id, subject, fact, source, created_at FROM memory_facts ORDER BY id DESC LIMIT ?", limit);
    case "loops":
      return listLoops().map((l) => ({ ...l, enabled: !!l.enabled, speak: !!l.speak, runs: loopRuns(l.id, 10) }));
    case "guide":
      return {
        current: latestGuide(),
        versions: all("SELECT id, created_at, substr(body, 1, 160) AS preview FROM guide_versions ORDER BY id DESC LIMIT ?", limit),
      };
    case "calls":
      return {
        calls: all("SELECT * FROM llm_calls ORDER BY id DESC LIMIT 100"),
        totals: get(
          `SELECT COUNT(*) AS count, COALESCE(SUM(ok), 0) AS ok, COUNT(*) - COALESCE(SUM(ok), 0) AS failed,
                  ROUND(COALESCE(SUM(cost_usd), 0), 4) AS cost_usd, CAST(COALESCE(AVG(ms), 0) AS INTEGER) AS avg_ms,
                  COALESCE(SUM(created_at >= datetime('now', '-1 day')), 0) AS last24h
           FROM llm_calls`),
      };
    case "tasks":
      return {
        tasks: all(
          `SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
           WHERE t.done = 0 ORDER BY t.due_date IS NULL, t.due_date, t.priority, t.id LIMIT ?`, limit),
        projects: all("SELECT * FROM projects WHERE status != 'done' ORDER BY due_date IS NULL, due_date, id LIMIT ?", limit),
      };
    case "overview":
      return get(
        `SELECT
           (SELECT COUNT(*) FROM actions WHERE status = 'pending') AS pendingActions,
           (SELECT COUNT(*) FROM jobs WHERE status = 'running') AS runningJobs,
           (SELECT COUNT(*) FROM jobs WHERE created_at >= datetime('now', '-1 day')) AS jobs24h,
           (SELECT COUNT(*) FROM jobs WHERE status = 'failed' AND created_at >= datetime('now', '-1 day')) AS failedJobs24h,
           (SELECT COUNT(*) FROM tasks WHERE done = 0) AS openTasks,
           (SELECT COUNT(*) FROM tasks WHERE done = 0 AND due_date IS NOT NULL AND due_date < date('now', 'localtime')) AS overdueTasks,
           (SELECT COUNT(*) FROM leads WHERE stage IN ('enquiry','quote')) AS openLeads,
           (SELECT COUNT(*) FROM clients) AS clients,
           (SELECT COUNT(*) FROM memory_facts) AS memoryFacts,
           (SELECT COUNT(*) FROM loops WHERE enabled = 1) AS enabledLoops,
           (SELECT COUNT(*) FROM guide_versions) AS guideVersions`,
      );
  }
}

export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const url = new URL(request.url);
  const section = url.searchParams.get("section") as Section | null;
  if (!section || !SECTIONS.includes(section)) {
    return NextResponse.json({ error: `section musí být jedno z: ${SECTIONS.join(", ")}` }, { status: 400 });
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
  try {
    return NextResponse.json(read(section, url.searchParams.get("agent"), limit));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

const Id = z.number().int().positive();
const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("guide_save"), body: z.string().max(50_000) }),
  z.object({ op: z.literal("guide_restore"), id: Id }),
  z.object({ op: z.literal("loop_toggle"), id: z.string().min(1), enabled: z.boolean() }),
  z.object({ op: z.literal("loop_update"), id: z.string().min(1), schedule: z.string().optional(), prompt: z.string().max(10_000).optional(), speak: z.boolean().optional() }),
  z.object({ op: z.literal("loop_run"), id: z.string().min(1) }),
  z.object({ op: z.literal("memory_delete"), id: Id }),
  z.object({ op: z.literal("memory_add"), subject: z.string().max(200).default(""), fact: z.string().trim().min(1).max(4000) }),
  z.object({ op: z.literal("task_complete"), id: Id }),
  z.object({ op: z.literal("lead_stage"), id: Id, stage: z.enum(["enquiry", "quote", "won", "lost"]) }),
]);

function mustChange(changes: number | bigint, what: string) {
  if (Number(changes) === 0) throw new Error(`${what} neexistuje.`);
}

function apply(op: z.infer<typeof Op>): unknown {
  switch (op.op) {
    case "guide_save":
      return { id: Number(dbRun("INSERT INTO guide_versions (body) VALUES (?)", op.body).lastInsertRowid) };
    case "guide_restore": {
      const v = get<{ body: string }>("SELECT body FROM guide_versions WHERE id = ?", op.id);
      if (!v) throw new Error("Verze průvodce neexistuje.");
      return { id: Number(dbRun("INSERT INTO guide_versions (body) VALUES (?)", v.body).lastInsertRowid), restoredFrom: op.id };
    }
    case "loop_toggle":
      return updateLoop(op.id, { enabled: op.enabled });
    case "loop_update":
      return updateLoop(op.id, { schedule: op.schedule, prompt: op.prompt, speak: op.speak });
    case "loop_run":
      return { started: true, ...runLoopNow(op.id) };
    case "memory_delete":
      mustChange(dbRun("DELETE FROM memory_facts WHERE id = ?", op.id).changes, "Záznam paměti");
      return { deleted: op.id };
    case "memory_add":
      return { id: Number(dbRun("INSERT INTO memory_facts (subject, fact, source) VALUES (?,?,'deck')", op.subject.trim(), op.fact).lastInsertRowid) };
    case "task_complete":
      mustChange(dbRun("UPDATE tasks SET done = 1, done_at = datetime('now') WHERE id = ? AND done = 0", op.id).changes, "Otevřený úkol");
      return { completed: op.id };
    case "lead_stage":
      mustChange(dbRun("UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE id = ?", op.stage, op.id).changes, "Lead");
      return { id: op.id, stage: op.stage };
  }
}

export async function POST(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const op = Op.safeParse(raw);
  if (!op.success) {
    return NextResponse.json({ error: `Neplatný požadavek: ${op.error.issues.map((i) => `${i.path.join(".") || "op"}: ${i.message}`).join("; ")}` }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, result: apply(op.data) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
