import { randomUUID } from "node:crypto";
import { z } from "zod";
import { all, get, run as dbRun } from "./db";
import { defineTool, deferrable, getTool } from "./tools/registry";
import type { Run } from "./events";
import type { AgentKey } from "@/lib/roster";

/* Outbound actions (send a mail, create an event, publish a post) are never
 * executed by an agent. The agent calls a propose_* tool, which stores a
 * pending action. The owner approves it in the Deck; only then does the
 * executor run, and its provider response (message id, event id, post id) is
 * stored as evidence. No evidence → not done. */

export type ActionRow = {
  id: number; kind: string; summary: string; payload: string; agent: string; run_id: string | null;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  evidence: string; error: string; created_at: string; decided_at: string | null;
};

type Executor = {
  label: string;
  schema: z.ZodObject<z.ZodRawShape>;
  /* Throw with a readable reason when it can't run (e.g. not connected). */
  execute: (payload: any) => Promise<string>;
  /* Optional readiness check shown in the Deck before approving. */
  ready?: () => string | null;
};

const g = globalThis as { __apexExecutors?: Map<string, Executor> };
const EXECUTORS: Map<string, Executor> = (g.__apexExecutors ??= new Map());

/* Define an outbound action kind: registers the propose_<kind> tool for agents
 * and the executor that runs after approval. */
export function defineAction<S extends z.ZodRawShape>(opts: {
  kind: string;
  label: string;
  description: string;
  input: S;
  node: AgentKey;
  summarize: (p: z.infer<z.ZodObject<S>>) => string;
  execute: (p: z.infer<z.ZodObject<S>>) => Promise<string>;
  ready?: () => string | null;
  /* Optional propose-time step: validate early (throw a readable Czech error)
   * and enrich the stored payload (e.g. a diff preview the owner approves). */
  prepare?: (p: z.infer<z.ZodObject<S>>) => z.infer<z.ZodObject<S>> | Promise<z.infer<z.ZodObject<S>>>;
}) {
  EXECUTORS.set(opts.kind, { label: opts.label, schema: z.object(opts.input), execute: opts.execute, ready: opts.ready });
  defineTool({
    name: `propose_${opts.kind}`,
    description: `${opts.description} NEPROVEDE SE hned: vytvoří návrh, který musí majitel schválit v panelu Deck.`,
    input: opts.input,
    node: opts.node,
    handler: async (input, { run }) => {
      const args = opts.prepare ? await opts.prepare(input) : input;
      const summary = opts.summarize(args);
      const id = Number(dbRun(
        "INSERT INTO actions (kind, summary, payload, agent, run_id) VALUES (?,?,?,?,?)",
        opts.kind, summary, JSON.stringify(args), run.agent, run.id,
      ).lastInsertRowid);
      run.emit({ t: "action", id, kind: opts.kind, summary });
      const warn = opts.ready?.();
      return { proposed: true, actionId: id, status: "pending", note: `Čeká na schválení v Decku.${warn ? ` Pozor: ${warn}` : ""}` };
    },
  });
}

/* Deferred tool calls: a guarded direct tool call (cleanOnly on a tainted run,
 * or a handler throwing NeedsApproval) is stored by callTool in
 * server/tools/registry.ts as a pending "deferred_tool" action. There is no
 * propose_ tool for it - only callTool creates it, and only the owner approves
 * it (POST /api/actions/{id}); no model-callable tool can decide an action.
 * On approval the original handler runs with the stored, re-validated args in
 * a fresh CLEAN run; its result is the evidence. */
const DEFERRED = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  agent: z.string().min(1),
  reason: z.string(),
  label: z.string().optional(),
});
const DEFERRED_TIMEOUT_MS = 2 * 60_000;
EXECUTORS.set("deferred_tool", {
  label: "Potvrzení akce agenta",
  schema: DEFERRED as unknown as z.ZodObject<z.ZodRawShape>,
  execute: async (payload: z.infer<typeof DEFERRED>) => {
    const def = getTool(payload.tool);
    if (!def) throw new Error(`Nástroj ${payload.tool} neexistuje.`);
    if (!deferrable(def.name)) throw new Error(`Nástroj ${def.name} nejde spustit přes potvrzení.`);
    const parsed = z.object(def.input).safeParse(payload.args);
    if (!parsed.success) {
      throw new Error(`Neplatné argumenty: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("Vypršel časový limit 2 minuty.")), DEFERRED_TIMEOUT_MS);
    const run: Run = {
      id: randomUUID(), agent: payload.agent, depth: 0, provider: "approval", source: "approval",
      tainted: false, emit: () => {}, signal: ac.signal,
    };
    try {
      const result = await Promise.race([
        Promise.resolve(def.handler(parsed.data, { run })),
        new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true })),
      ]);
      const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
      return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    } finally {
      clearTimeout(timer);
    }
  },
});

export function actionKinds() {
  return [...EXECUTORS.entries()].map(([kind, e]) => ({ kind, label: e.label, ready: e.ready?.() ?? null }));
}

export function listActions(limit = 50): ActionRow[] {
  return all<ActionRow>("SELECT * FROM actions ORDER BY (status = 'pending') DESC, id DESC LIMIT ?", limit);
}

export async function decideAction(id: number, decision: "approve" | "reject", edits?: Record<string, unknown>): Promise<ActionRow> {
  const row = get<ActionRow>("SELECT * FROM actions WHERE id = ?", id);
  if (!row) throw new Error("Akce neexistuje.");
  if (row.status !== "pending" && row.status !== "failed") throw new Error(`Akce už je ve stavu ${row.status}.`);
  if (decision === "reject") {
    dbRun("UPDATE actions SET status = 'rejected', decided_at = datetime('now') WHERE id = ?", id);
    return get<ActionRow>("SELECT * FROM actions WHERE id = ?", id)!;
  }
  const ex = EXECUTORS.get(row.kind);
  if (!ex) throw new Error(`Neznámý typ akce ${row.kind}.`);
  const payload = ex.schema.parse({ ...JSON.parse(row.payload), ...(edits ?? {}) });
  // claim atomically: a second concurrent approve must not execute twice
  const claimed = dbRun(
    "UPDATE actions SET status = 'approved', payload = ?, decided_at = datetime('now') WHERE id = ? AND status IN ('pending','failed')",
    JSON.stringify(payload), id,
  );
  if (Number(claimed.changes) !== 1) throw new Error("Akci mezitím zpracoval jiný požadavek.");
  try {
    const evidence = await ex.execute(payload);
    if (!evidence) throw new Error("Poskytovatel nevrátil žádný důkaz o provedení.");
    dbRun("UPDATE actions SET status = 'executed', evidence = ?, error = '' WHERE id = ?", evidence, id);
  } catch (e) {
    dbRun("UPDATE actions SET status = 'failed', error = ? WHERE id = ?", e instanceof Error ? e.message : String(e), id);
  }
  return get<ActionRow>("SELECT * FROM actions WHERE id = ?", id)!;
}
