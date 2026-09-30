import { z } from "zod";
import { defineTool, untrusted } from "./registry";
import { all } from "../db";
import { AGENTS, SPECIALISTS } from "../agents";
import { runSpecialist } from "../orchestrator";
import { ROSTER_BY_KEY } from "@/lib/roster";

/* delegate_to_<specialist> for the Chief of staff, plus the job log. */

for (const agent of SPECIALISTS) {
  const r = ROSTER_BY_KEY[agent];
  // An agent with web access could carry data out through a URL. Once the run
  // has read external content (mail, Drive, web), don't hand it such an agent.
  const web = !!AGENTS[agent]?.native?.length;
  defineTool({
    taints: web,
    cleanOnly: web,
    name: `delegate_to_${agent}`,
    description: `Předá úkol specialistovi ${r.name} (${r.role}: ${r.caps.join("; ")}). Specialista nevidí konverzaci – zadání musí obsahovat veškerý kontext. Vrátí jeho výstup.`,
    input: {
      task: z.string().min(3).describe("Kompletní zadání včetně kontextu a očekávaného výstupu."),
    },
    node: agent,
    handler: async ({ task }, { run }) => {
      const { jobId, text } = await runSpecialist({ agent, task, provider: run.provider, parent: run, signal: run.signal });
      return `[job #${jobId} – ${r.name}]\n${web ? untrusted("web-research", text) : text}`;
    },
  });
}

defineTool({
  name: "jobs_recent",
  description: "Poslední úlohy agentů (delegace, naplánované smyčky) s výsledky. Volitelně filtr podle agenta.",
  input: {
    agent: z.string().optional().describe("Klíč agenta, např. researcher."),
    limit: z.number().int().min(1).max(30).default(10),
  },
  node: "chief_of_staff",
  handler: ({ agent, limit }) =>
    all(
      `SELECT id, agent, status, source, substr(input,1,300) AS input, substr(output,1,1500) AS output, created_at
       FROM jobs ${agent ? "WHERE agent = ?" : ""} ORDER BY id DESC LIMIT ?`,
      ...(agent ? [agent, limit] : [limit]),
    ).map((j) => ({ ...j, output: untrusted("job-output", String(j.output ?? "")) })),
});
