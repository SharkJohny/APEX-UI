import { z } from "zod";
import { defineTool } from "./registry";
import { listLoops, loopRuns, runLoopNow, SCHEDULE_HELP, updateLoop } from "../loops";

/* Loops for the Chief of staff: see, change and fire scheduled agent jobs. */

defineTool({
  name: "loops_list",
  description: "Seznam naplánovaných smyček (ranní brífink, týdenní revize, follow-upy…): agent, rozvrh, zapnuto, zadání a poslední běhy.",
  input: {},
  node: "chief_of_staff",
  handler: () =>
    listLoops().map((l) => ({
      id: l.id, name: l.name, agent: l.agent, schedule: l.schedule, enabled: !!l.enabled, prompt: l.prompt,
      lastRuns: loopRuns(l.id, 3).map((r) => ({ period: r.period, status: r.status, jobId: r.job_id, startedAt: r.started_at })),
    })),
});

defineTool({
  name: "loops_set",
  // injected content must not be able to schedule itself
  cleanOnly: true,
  description: `Změní smyčku: zapnout/vypnout, rozvrh nebo zadání. ${SCHEDULE_HELP}`,
  input: {
    id: z.string().describe("id smyčky, např. morning_brief"),
    enabled: z.boolean().optional(),
    schedule: z.string().optional().describe('např. "daily 08:00", "weekly mon 09:00", "every 30m"'),
    prompt: z.string().optional(),
  },
  node: "chief_of_staff",
  handler: ({ id, ...patch }) => {
    const l = updateLoop(id, patch);
    return { id: l.id, schedule: l.schedule, enabled: !!l.enabled };
  },
});

defineTool({
  name: "loops_run_now",
  // injected content must not be able to schedule itself
  cleanOnly: true,
  description: "Spustí smyčku hned teď (i když je vypnutá). Běží na pozadí; výsledek se objeví jako úloha v panelu Deck.",
  input: { id: z.string().describe("id smyčky") },
  node: "chief_of_staff",
  handler: ({ id }) => {
    const r = runLoopNow(id);
    return { started: true, loopRunId: r.runId, note: "Běží na pozadí, výsledek bude v Decku (Úlohy)." };
  },
});
