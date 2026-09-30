import { z } from "zod";
import { defineTool, untrusted } from "./registry";
import { all } from "../db";

/* Looking back: the approval queue and past conversations with the owner
 * (read-only). Semantic search over conversations lives in memory.ts. */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

type ActionRow = { id: number; kind: string; status: string; summary: string; agent: string; created_at: string; decided_at: string | null; evidence: string; error: string };

function listActions(status: "pending" | "all", limit: number): ActionRow[] {
  return all<ActionRow>(
    `SELECT id, kind, status, summary, agent, created_at, decided_at, evidence, error FROM actions
     ${status === "pending" ? "WHERE status = 'pending'" : ""} ORDER BY id DESC LIMIT ?`, limit,
  );
}

defineTool({
  name: "actions_list",
  description: "Fronta návrhů ke schválení (Deck → Schválení): co čeká na rozhodnutí majitele a jak dopadly dřívější návrhy (schváleno, zamítnuto, provedeno, selhalo). Schvaluje a zamítá VÝHRADNĚ majitel – tlačítkem v chatu nebo v panelu Deck; ty návrh nikdy schválit nemůžeš. Seznam je vždy aktuální, věř mu víc než své paměti.",
  input: {
    status: z.enum(["pending", "all"]).default("pending").describe("pending = jen čekající, all = i vyřízené."),
    limit: z.number().int().min(1).max(50).default(20),
  },
  node: "chief_of_staff",
  // rows are Apex's own proposals; tool output in evidence is wrapped below
  taints: false,
  handler: ({ status, limit }) =>
    listActions(status, limit).map((a) => ({
      id: a.id, kind: a.kind, status: a.status, summary: a.summary, agent: a.agent,
      created_at: a.created_at, decided_at: a.decided_at,
      ...(a.evidence ? { evidence: untrusted("action-evidence", clip(a.evidence, 300)) } : {}),
      ...(a.error ? { error: clip(a.error, 300) } : {}),
    })),
});

type MsgRow = { id: number; role: string; content: string; created_at: string };

defineTool({
  name: "conversations_recent",
  description: "Seznam posledních konverzací s majitelem (i z dřívějších dnů): kdy začaly, poslední aktivita, počet zpráv, první dotaz a poslední výměna. Pro celý průběh použij conversation_read, pro hledání podle tématu memory_search_conversations.",
  input: {
    limit: z.number().int().min(1).max(30).default(10),
  },
  node: "memory",
  // assistant turns may quote mails/web pages
  taints: true,
  handler: ({ limit }) => {
    const convs = all<{ conversation_id: string; started: string; last_activity: string; messages: number; first_id: number }>(
      `SELECT conversation_id, MIN(created_at) AS started, MAX(created_at) AS last_activity, COUNT(*) AS messages, MIN(id) AS first_id
       FROM messages GROUP BY conversation_id ORDER BY MAX(id) DESC LIMIT ?`, limit,
    );
    return convs.map((c) => {
      const first = all<MsgRow>("SELECT id, role, content, created_at FROM messages WHERE id = ?", c.first_id)[0];
      const tail = all<MsgRow>("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 2", c.conversation_id).reverse();
      return {
        conversation_id: c.conversation_id,
        started: c.started,
        last_activity: c.last_activity,
        messages: c.messages,
        first_user_message: first ? clip(first.content, 300) : "",
        last_exchange: untrusted("minule-rozhovory", tail.map((m) => `${m.role === "user" ? "Majitel" : "Apex"}: ${clip(m.content, 400)}`).join("\n")),
      };
    });
  },
});

defineTool({
  name: "conversation_read",
  description: "Přečte průběh jedné dřívější konverzace s majitelem (posledních N zpráv). conversation_id získáš z conversations_recent nebo memory_search_conversations.",
  input: {
    conversation_id: z.string().min(1).max(100),
    last_n: z.number().int().min(1).max(100).default(30),
  },
  node: "memory",
  taints: true,
  handler: ({ conversation_id, last_n }) => {
    const rows = all<MsgRow>(
      "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?", conversation_id, last_n,
    ).reverse();
    if (!rows.length) return { error: "Konverzace s tímto id neexistuje." };
    return {
      conversation_id,
      messages: rows.map((m) => ({
        role: m.role, created_at: m.created_at,
        content: m.role === "user" ? clip(m.content, 1500) : untrusted("minule-rozhovory", clip(m.content, 1500)),
      })),
    };
  },
});
