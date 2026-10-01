import { z } from "zod";
import { defineTool, untrusted } from "./registry";
import { listChats, messagesStatus, readChat, searchMessages, SOURCES, type Msg } from "../integrations/messages";
import { archiveChats, archiveMessages, archiveSearch, chatSyncStatus, syncChats, type ArchivedMsg } from "../chatSync";
import { semanticSearch, semanticStatus } from "../semantic";

/* Reading the owner's chats (WhatsApp, iMessage/SMS, Messenger, Instagram DM).
 * Read-only; message text is external content, so every result is wrapped
 * in untrusted() and taints the run. Output stays compact - a chat read is
 * paid for on every later turn of the conversation. */

const source = z.enum(SOURCES);

const local = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
const line = (m: Msg) => `[${m.at ? local(m.at) : m.time || "?"}] ${m.from}: ${m.text}`;

defineTool({
  name: "messages_status",
  description: "Které zdroje zpráv (WhatsApp, iMessage/SMS, Messenger, Instagram DM) jsou zapnuté a čitelné.",
  input: {},
  node: "email",
  handler: () => ({ ...messagesStatus(), pamet: chatSyncStatus() }),
});

defineTool({
  name: "messages_chats",
  description: "Seznam posledních konverzací ze zpráv (WhatsApp, iMessage/SMS, Messenger, Instagram DM), nejnovější první. Bez source = všechny zapnuté zdroje. query filtruje podle jména/čísla.",
  input: {
    source: source.optional(),
    query: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(30).default(15),
  },
  node: "email",
  taints: true,
  handler: async (a) => {
    const r = await listChats(a);
    const rows = r.chats.map((c) => `${c.source} #${c.chat} · ${c.name} · ${c.last ? local(c.last) : c.when || "?"}${c.unread ? ` · nepřečteno ${c.unread}` : ""}${c.snippet ? ` · „${c.snippet}“` : ""}`);
    return [
      rows.length ? untrusted("zpravy", rows.join("\n")) : "Žádné konverzace.",
      r.errors.length ? `Nedostupné: ${r.errors.join(" | ")}` : "",
    ].filter(Boolean).join("\n");
  },
});

defineTool({
  name: "messages_read",
  description: "Přečte zprávy jedné konverzace (source + chat z messages_chats), chronologicky. before = ISO datum pro starší zprávy (jen iMessage / WhatsApp pro Mac).",
  input: {
    source,
    chat: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(20),
    before: z.string().datetime({ offset: true }).optional(),
  },
  node: "email",
  taints: true,
  handler: async (a) => {
    const msgs = await readChat(a);
    if (!msgs.length) return "Žádné zprávy.";
    return untrusted(`zpravy:${a.source}`, `${msgs[0].chatName ? `Konverzace: ${msgs[0].chatName}\n` : ""}${msgs.map(line).join("\n")}`);
  },
});

const archived = (m: ArchivedMsg) =>
  `${m.source} #${m.chat_id} (${m.chat_name}) [${m.at ? local(m.at) : m.time_label || `uloženo ${local(`${m.created_at.replace(" ", "T")}Z`)}`}] ${m.sender}: ${m.text.length > 600 ? `${m.text.slice(0, 600)}…` : m.text}`;

defineTool({
  name: "messages_search",
  description: "Hledá v paměti zpráv – archivu WhatsAppu a Messengeru (Apex si ho průběžně ukládá z Ramboxu, i starší konverzace) podle textu, jména nebo významu; k tomu živě iMessage/SMS. Použij, když se majitel ptá, co se s kým psalo nebo kdo co říkal.",
  input: {
    query: z.string().min(2).max(100),
    source: z.enum(["whatsapp", "messenger", "imessage"]).optional(),
    days: z.number().int().min(1).max(3650).default(365),
    limit: z.number().int().min(1).max(30).default(15),
  },
  node: "email",
  taints: true,
  handler: async (a) => {
    const since = new Date(Date.now() - a.days * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
    const parts: string[] = [];
    const errors: string[] = [];
    if (a.source !== "imessage") {
      const hits = archiveSearch(a.query, { source: a.source, since, limit: a.limit });
      if (hits.length) parts.push(`Přesné shody:\n${hits.map(archived).join("\n")}`);
      if (semanticStatus().ready) {
        try {
          const sem = (await semanticSearch(a.query, { sources: ["chats"], limit: 5 }))
            .filter((h) => !a.source || h.ref.startsWith(`${a.source}:`));
          if (sem.length) parts.push(`Podle významu:\n${sem.map((h) => `${h.title}:\n${h.text}`).join("\n---\n")}`);
        } catch { /* semantic index not ready - exact matches still help */ }
      }
    }
    if (!a.source || a.source === "imessage") {
      const r = await searchMessages({ query: a.query, source: "imessage", days: Math.min(a.days, 365), limit: a.limit });
      if (r.messages.length) parts.push(`iMessage/SMS:\n${r.messages.map((m) => `${m.source} #${m.chat}${m.chatName ? ` (${m.chatName})` : ""} ${line(m)}`).join("\n")}`);
      errors.push(...r.errors);
    }
    return [
      parts.length ? untrusted("zpravy", parts.join("\n\n")) : "Nic nenalezeno.",
      errors.length ? `Nedostupné: ${errors.join(" | ")}` : "",
    ].filter(Boolean).join("\n");
  },
});

defineTool({
  name: "messages_history",
  description: "Co se psalo s konkrétním člověkem nebo skupinou na WhatsAppu / Messengeru – z paměti zpráv (funguje i bez běžícího Ramboxu). person = jméno nebo jeho část.",
  input: {
    person: z.string().min(2).max(100),
    source: z.enum(["whatsapp", "messenger"]).optional(),
    limit: z.number().int().min(1).max(60).default(30),
    before: z.string().datetime({ offset: true }).optional(),
  },
  node: "email",
  taints: true,
  handler: (a) => {
    const chats = archiveChats(a.person, a.source);
    if (!chats.length) return `V paměti zpráv není konverzace odpovídající „${a.person}“. Zkus messages_chats (živě z Ramboxu) nebo messages_search.`;
    const best = chats[0];
    const before = a.before ? new Date(a.before).toISOString().replace("T", " ").slice(0, 19) : undefined;
    const msgs = archiveMessages(best.source, best.chat_id, a.limit, before);
    const others = chats.slice(1).map((c) => `${c.source} #${c.chat_id} ${c.chat_name} (${c.n} zpráv)`);
    return [
      untrusted(`zpravy:${best.source}`, `Konverzace: ${best.chat_name} (${best.source}, v paměti ${best.n} zpráv)\n${msgs.map((m) => `[${m.at ? local(m.at) : m.time_label || "?"}] ${m.sender}: ${m.text}`).join("\n")}`),
      others.length ? `Další odpovídající konverzace: ${others.join("; ")}` : "",
    ].filter(Boolean).join("\n");
  },
});

defineTool({
  name: "messages_sync",
  description: "Hned uloží nové zprávy z Ramboxu (WhatsApp, Messenger) do paměti zpráv. Jinak se to děje samo každých 10 minut.",
  input: {},
  node: "email",
  taints: true,
  handler: async () => {
    const r = await syncChats();
    const st = chatSyncStatus();
    return `Uloženo ${r.added} nových zpráv; v paměti celkem ${st.messages} zpráv z ${st.chats} konverzací.${r.errors.length ? ` Problémy: ${r.errors.slice(0, 3).join(" | ")}` : ""}`;
  },
});
