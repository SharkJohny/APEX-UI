import { z } from "zod";
import { defineTool, untrusted } from "./registry";
import { defineAction } from "../actions";
import { aiccAvailable, brief, listTerminals, readRoadmap, sendToTerminal, sessionOf, sessionsFor } from "../integrations/aicc";
import { aiccEvents } from "../aiccWatch";
import { all } from "../db";
import { semanticSearch, semanticStatus } from "../semantic";

/* The owner's AI Command Center windows (agent terminals per project).
 * Reading is direct; typing into a window is an action the owner approves -
 * the agents there run without confirmations, so the text is executed as if
 * he typed it. Window output is AI/external text: untrusted, taints. */

const localTime = (iso: string) =>
  new Date(iso).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

const clip = (s: string | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

defineTool({
  name: "aicc_windows",
  description: "Otevřená okna v AI Command Center (agenti v terminálech podle projektů): projekt, název, jestli čeká na majitele, co naposledy dělá, postup roadmapy. Stručně.",
  input: {},
  node: "developer",
  taints: true,
  handler: async () => {
    if (!aiccAvailable()) return "AI Command Center neběží.";
    const terms = await listTerminals();
    const sessions = sessionsFor(terms);
    const rows = terms.map((t) => {
      const w = sessions.get(t.id);
      const s = sessionOf(w);
      const agent = w ? (w.agent === "codex" ? " · Codex" : "") : " · bez agenta";
      const road = readRoadmap(t.cwd);
      const open = road.filter((r) => !r.done).length;
      return `${t.id} · ${t.projectName} · ${t.title}${agent}${t.attention ? " · ČEKÁ NA TEBE" : s?.status === "busy" ? " · pracuje" : ""}${road.length ? ` · roadmapa ${road.length - open}/${road.length}` : ""}${s?.lastAssistant ? ` · naposledy: ${brief(s.lastAssistant, 120)}` : ""}`;
    });
    return rows.length ? untrusted("aicc", rows.join("\n")) : "Žádná otevřená okna.";
  },
});

defineTool({
  name: "aicc_window",
  description: "Detail jednoho okna v AI Command Center (id z aicc_windows): poslední zadání majitele, poslední odpověď agenta a otevřené kroky roadmapy.",
  input: { id: z.string().min(8).max(64) },
  node: "developer",
  taints: true,
  handler: async ({ id }) => {
    const terms = await listTerminals();
    const t = terms.find((x) => x.id === id);
    if (!t) return "Okno nenalezeno – zkus aicc_windows.";
    const w = sessionsFor(terms).get(t.id);
    const s = sessionOf(w);
    const open = readRoadmap(t.cwd).filter((r) => !r.done).slice(0, 8);
    return untrusted("aicc", [
      `Okno: ${t.projectName} · ${t.title} (${t.cwd})${t.attention ? " – čeká na majitele" : ""}`,
      !w ? "V okně teď neběží žádný agent." : w.agent === "codex" ? "Běží Codex – jeho odpovědi Apex nečte, jen stav okna." : "",
      s?.lastUser ? `Poslední zadání: ${clip(s.lastUser, 400)}` : "",
      s?.lastAssistant ? `Poslední odpověď agenta${s.finished && s.status !== "busy" ? "" : " (ještě pracuje)"}: ${clip(s.lastAssistant, 1200)}` : "",
      open.length ? `Otevřené kroky roadmapy:\n${open.map((r) => `- ${clip(r.text, 160)}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"));
  },
});

defineTool({
  name: "aicc_events",
  description: "Poslední změny v oknech AI Command Center (dokončeno, čeká na majitele, hotový krok roadmapy, otevřeno/zavřeno).",
  input: { limit: z.number().int().min(1).max(30).default(10) },
  node: "developer",
  taints: true,
  handler: ({ limit }) => {
    const rows = aiccEvents({ limit });
    return rows.length
      ? untrusted("aicc", rows.map((r) => `${r.created_at.slice(5, 16)} ${r.win}: ${r.text}`).join("\n"))
      : "Zatím žádné změny.";
  },
});

defineTool({
  name: "aicc_history",
  description: "Paměť práce v oknech AI Command Center: co majitel zadával a co agenti v projektech udělali (ukládá se průběžně). project = název projektu (část), query = téma; bez query vrátí poslední dění v projektu.",
  input: {
    project: z.string().max(100).optional(),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(40).default(15),
  },
  node: "developer",
  taints: true,
  handler: async (a) => {
    type R = { project: string; win: string; role: string; text: string; at: string | null; created_at: string };
    const line = (r: R) => `[${localTime(r.at ?? `${r.created_at.replace(" ", "T")}Z`)}] ${r.win} · ${r.role === "user" ? "majitel" : "agent"}: ${clip(r.text, 500)}`;
    const parts: string[] = [];
    if (a.query) {
      const exact = all<R>(
        `SELECT project, win, role, text, at, created_at FROM agent_archive WHERE text LIKE ? AND (? IS NULL OR project LIKE ?)
         ORDER BY id DESC LIMIT ?`, `%${a.query}%`, a.project ?? null, `%${a.project ?? ""}%`, a.limit,
      );
      if (exact.length) parts.push(`Přesné shody:\n${exact.reverse().map(line).join("\n")}`);
      if (semanticStatus().ready) {
        try {
          const sem = (await semanticSearch(`${a.project ?? ""} ${a.query}`, { sources: ["windows"], limit: 5 }))
            .filter((h) => !a.project || h.title.toLowerCase().includes(a.project.toLowerCase()));
          if (sem.length) parts.push(`Podle významu:\n${sem.map((h) => `${h.title}:\n${h.text}`).join("\n---\n")}`);
        } catch { /* index not ready */ }
      }
    } else {
      const recent = all<R>(
        `SELECT project, win, role, text, at, created_at FROM agent_archive WHERE (? IS NULL OR project LIKE ?) ORDER BY id DESC LIMIT ?`,
        a.project ?? null, `%${a.project ?? ""}%`, a.limit,
      );
      if (recent.length) parts.push(recent.reverse().map(line).join("\n"));
    }
    return parts.length ? untrusted("aicc-archiv", parts.join("\n\n")) : "V paměti oken nic takového není.";
  },
});

defineAction({
  kind: "aicc_send",
  label: "Poslat zprávu do okna",
  description: "Napíše zprávu do okna v AI Command Center (agent ji provede jako zadání majitele). Jen po schválení majitelem.",
  input: {
    terminal_id: z.string().min(8).max(64),
    window: z.string().max(120).describe("projekt · název okna (pro majitele)"),
    text: z.string().min(1).max(2000),
  },
  node: "developer",
  summarize: (p) => `${p.window}: ${p.text.slice(0, 80)}${p.text.length > 80 ? "…" : ""}`,
  ready: () => (aiccAvailable() ? null : "AI Command Center neběží."),
  prepare: async (p) => {
    const t = (await listTerminals()).find((x) => x.id === p.terminal_id);
    if (!t) throw new Error("Okno nenalezeno – zkus aicc_windows.");
    return { ...p, window: `${t.projectName} · ${t.title}` };
  },
  execute: async (p) => {
    await sendToTerminal(p.terminal_id, p.text);
    return `Odesláno do okna ${p.window}.`;
  },
});
