import { randomBytes, randomUUID } from "node:crypto";

/* Live runs and the events they stream to the browser. A "run" is one agent
 * turn: the Chief of staff answering the user, or a specialist it delegated
 * to. Tool calls arriving through the MCP bridge look their run up here to
 * know which agent is calling and where to send trace / job / action events.
 * Kept on globalThis: Next bundles every route separately, and the chat route
 * and the internal tools route must see the same registry. */

export type ApexEvent =
  | { t: "state"; v: "thinking" | "reasoning" | "speaking" | "idle" }
  | { t: "token"; v: string }
  | { t: "trace"; helper: string; tool: string }
  | { t: "job"; id: number; agent: string; status: "running" | "done" | "failed"; summary?: string }
  | { t: "action"; id: number; kind: string; summary: string }
  | { t: "info"; v: string }
  | { t: "error"; v: string }
  | { t: "done"; conversationId: string };

export type Run = {
  id: string;
  agent: string;
  depth: number;
  provider: string;
  parentId?: string;
  /* "chat" (owner-initiated) or "loop:<id>" (autonomous). */
  source?: string;
  /* Set once the run has read external content (mail, calendar, Drive, web
   * research). A tainted run may no longer hand work to web-capable agents or
   * change loops - that is how injected content could exfiltrate data or
   * persist itself. Propagates to the parent run. */
  tainted?: boolean;
  emit: (ev: ApexEvent) => void;
  signal: AbortSignal;
};

type Registry = { runs: Map<string, Run>; token: string };
const g = globalThis as { __apexRuns?: Registry };
function reg(): Registry {
  if (!g.__apexRuns) g.__apexRuns = { runs: new Map(), token: randomBytes(24).toString("hex") };
  return g.__apexRuns;
}

/* Secret shared with the MCP bridge processes this server spawns. */
export function internalToken(): string {
  return reg().token;
}

export function startRun(r: Omit<Run, "id">): Run {
  const run: Run = { ...r, id: randomUUID() };
  reg().runs.set(run.id, run);
  return run;
}
export function getRun(id: string): Run | undefined {
  return reg().runs.get(id);
}
export function taintRun(run: Run) {
  for (let r: Run | undefined = run; r; r = r.parentId ? getRun(r.parentId) : undefined) r.tainted = true;
}

export function endRun(id: string) {
  reg().runs.delete(id);
}
export function activeRuns(): Run[] {
  return [...reg().runs.values()];
}
