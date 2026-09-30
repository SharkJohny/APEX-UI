import { z } from "zod";
import { defineTool } from "./registry";
import { all, get, run } from "../db";
import { ftsQuery } from "../orchestrator";
import { semanticSearch, semanticStatus } from "../semantic";

/* Long-term memory: facts about clients, projects, decisions, preferences. */

type FactRow = { id: number; subject: string; fact: string; created_at: string; score?: number };

defineTool({
  name: "memory_search",
  description: "Hledá v dlouhodobé paměti (fakta o klientech, projektech, rozhodnutích, preferencích majitele) – podle významu i klíčových slov. Bez dotazu vrátí nejnovější fakta.",
  input: {
    query: z.string().default("").describe("Na co se ptáš – klidně celou větou, např. 'kdo mi dluží peníze' nebo jméno klienta."),
    limit: z.number().int().min(1).max(50).default(15),
  },
  node: "memory",
  handler: async ({ query, limit }) => {
    const q = ftsQuery(query);
    if (!q) return all("SELECT id, subject, fact, created_at FROM memory_facts ORDER BY id DESC LIMIT ?", limit);
    const keyword = all<FactRow>(
      `SELECT m.id, m.subject, m.fact, m.created_at FROM memory_fts f JOIN memory_facts m ON m.id = f.rowid
       WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`, q, limit,
    );
    if (!semanticStatus().ready) return keyword;
    try {
      const hits = await semanticSearch(query, { sources: ["memory"], limit });
      const out: FactRow[] = [];
      const seen = new Set<number>();
      for (const h of hits) {
        const row = get<FactRow>("SELECT id, subject, fact, created_at FROM memory_facts WHERE id = ?", Number(h.ref));
        if (row && !seen.has(row.id)) { seen.add(row.id); out.push({ ...row, score: h.score }); }
      }
      for (const row of keyword) if (!seen.has(row.id)) { seen.add(row.id); out.push(row); }
      return out.slice(0, limit);
    } catch {
      return keyword;
    }
  },
});

defineTool({
  name: "memory_search_conversations",
  description: "Hledá v historii dřívějších konverzací s majitelem (podle významu). Použij, když se majitel odvolává na něco, co už spolu dřív řešili.",
  input: {
    query: z.string().min(2).describe("Co hledáš, klidně celou větou."),
    limit: z.number().int().min(1).max(20).default(6),
  },
  node: "memory",
  // assistant turns may quote mails/web pages
  taints: true,
  handler: async ({ query, limit }) => {
    if (semanticStatus().ready) {
      try {
        const hits = await semanticSearch(query, { sources: ["messages"], limit });
        return hits.map((h) => {
          const i = h.ref.lastIndexOf(":");
          return { conversation_id: h.ref.slice(0, i), message_id: Number(h.ref.slice(i + 1)), score: h.score, text: h.text };
        });
      } catch { /* fall through to keyword search */ }
    }
    const words = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 6);
    if (!words.length) return [];
    return all(
      `SELECT conversation_id, id AS message_id, role, substr(content, 1, 700) AS text, created_at FROM messages
       WHERE ${words.map(() => "lower(content) LIKE ?").join(" OR ")} ORDER BY id DESC LIMIT ?`,
      ...words.map((w) => `%${w}%`), limit,
    );
  },
});

defineTool({
  name: "memory_save",
  description: "Uloží trvalý fakt do paměti (preference majitele, fakt o klientovi, rozhodnutí). Jeden fakt = jedna krátká věta. Nejdřív ověř přes memory_search, že tam už není.",
  input: {
    subject: z.string().default("").describe("O kom/čem fakt je (jméno klienta, projekt, 'majitel')."),
    fact: z.string().min(3).describe("Samotný fakt."),
  },
  node: "memory",
  handler: ({ subject, fact }, { run: r }) => {
    const dup = get("SELECT id FROM memory_facts WHERE subject = ? AND fact = ?", subject, fact);
    if (dup) return { saved: false, reason: "Už je v paměti.", id: (dup as { id: number }).id };
    // a fact saved after reading mail/web may have been planted by that content
    const source = r.tainted ? `untrusted:${r.agent}` : r.agent;
    const id = Number(run("INSERT INTO memory_facts (subject, fact, source) VALUES (?,?,?)", subject, fact, source).lastInsertRowid);
    return { saved: true, id };
  },
});

defineTool({
  name: "memory_forget",
  description: "Smaže fakt z paměti podle id (když je zastaralý nebo chybný).",
  input: { id: z.number().int() },
  node: "memory",
  handler: ({ id }) => ({ deleted: Number(run("DELETE FROM memory_facts WHERE id = ?", id).changes) > 0 }),
});
