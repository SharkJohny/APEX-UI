import { createHash } from "node:crypto";
import { all, get, run } from "./db";
import { rbChats, rbMessages, ramboxOn, type Msg } from "./integrations/messages";
import { recordEvent } from "./aiccWatch";
import { brief } from "./integrations/aicc";

/* Apex's memory of the owner's chats: every few minutes (Settings, default 5)
 * the chats that got new messages in Rambox (WhatsApp Web, Messenger) are
 * copied into chat_archive, so "what did I write with X" works even when
 * Rambox is closed, and the semantic indexer can find it. New messages from
 * other people become a short notification (and the chief hears about them).
 * Read-only towards the chats. */

const intervalMs = () => Math.min(60, Math.max(1, Number(process.env.APEX_MSG_SYNC_MIN) || 5)) * 60_000;
const notifyOn = () => process.env.APEX_MSG_NOTIFY !== "0";
const LABEL = { whatsapp: "WhatsApp", messenger: "Messenger" } as const;
const WA_CHATS = 40;
const WA_MSGS = 100;
const MS_CHATS = 25;
/* Reading a Messenger thread switches Rambox's view for a moment - keep it rare. */
const MS_THREADS_PER_RUN = 5;
const MS_MSGS = 40;

type SyncState = { started?: boolean; busy?: boolean; timer?: ReturnType<typeof setTimeout>; lastRunAt?: string; lastError?: string; lastAdded?: number };
const g = globalThis as { __apexChatSync?: SyncState };
const S: SyncState = (g.__apexChatSync ??= {});

const enabled = () => process.env.APEX_MSG_ARCHIVE !== "0";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/* Saves new messages; returns how many were new and the new ones from other people. */
function store(msgs: Msg[], chatName: string): { added: number; incoming: Msg[] } {
  let added = 0;
  const incoming: Msg[] = [];
  for (const m of msgs) {
    if (!m.text.trim()) continue;
    // WhatsApp has stable ids; Messenger only what the bubble shows
    const key = m.id ? `${m.source}:${m.id}` : `${m.source}:${m.chat}:${sha1(`${m.from}\u0000${m.time ?? ""}\u0000${m.text}`)}`;
    const r = run(
      `INSERT OR IGNORE INTO chat_archive (source, chat_id, chat_name, at, time_label, sender, me, text, key) VALUES (?,?,?,?,?,?,?,?,?)`,
      m.source, m.chat, m.chatName || chatName, m.at, m.time ?? "", m.from, m.me ? 1 : 0, m.text, key,
    );
    if (Number(r.changes)) {
      added++;
      if (!m.me) incoming.push(m);
    }
  }
  return { added, incoming };
}

/* One short notification per chat and sync - never for a chat's first backfill. */
function announce(source: "whatsapp" | "messenger", name: string, known: boolean, incoming: Msg[]) {
  if (!known || !incoming.length || !notifyOn()) return;
  const last = incoming[incoming.length - 1];
  const text = incoming.length === 1 ? brief(last.text, 110) : `${incoming.length} nové zprávy, poslední: ${brief(last.text, 80)}`;
  recordEvent("message", LABEL[source], "", `${LABEL[source]} · ${name}`, text);
}

function fingerprint(source: string, chat: string): string | undefined {
  return get<{ fingerprint: string }>("SELECT fingerprint FROM chat_sync WHERE source = ? AND chat_id = ?", source, chat)?.fingerprint;
}

function markSynced(source: string, chat: string, name: string, fp: string) {
  run(`INSERT INTO chat_sync (source, chat_id, chat_name, fingerprint) VALUES (?,?,?,?)
       ON CONFLICT(source, chat_id) DO UPDATE SET chat_name = excluded.chat_name, fingerprint = excluded.fingerprint, synced_at = datetime('now')`,
    source, chat, name, fp);
}

export async function syncChats(): Promise<{ added: number; errors: string[] }> {
  if (S.busy) return { added: 0, errors: ["synchronizace už běží"] };
  S.busy = true;
  let added = 0;
  const errors: string[] = [];
  try {
    if (!enabled() || !ramboxOn()) return { added, errors: ["Rambox bridge neběží nebo je archiv vypnutý."] };
    if (process.env.APEX_MSG_WHATSAPP !== "0") {
      try {
        for (const c of await rbChats("whatsapp", WA_CHATS)) {
          const fp = `${c.last}|${c.snippet}`;
          const before = fingerprint("whatsapp", c.chat);
          if (before === fp) continue;
          try {
            const r = store(await rbMessages("whatsapp", c.chat, WA_MSGS, true), c.name);
            added += r.added;
            announce("whatsapp", c.name, before !== undefined, r.incoming);
            markSynced("whatsapp", c.chat, c.name, fp);
          } catch (e) {
            errors.push(`WhatsApp ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        errors.push(`WhatsApp: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (process.env.APEX_MSG_MESSENGER !== "0") {
      try {
        let threads = 0;
        for (const c of await rbChats("messenger", MS_CHATS)) {
          const fp = c.snippet;
          const before = fingerprint("messenger", c.chat);
          if (before === fp) continue;
          if (threads++ >= MS_THREADS_PER_RUN) break;
          try {
            const r = store(await rbMessages("messenger", c.chat, MS_MSGS, true), c.name);
            added += r.added;
            announce("messenger", c.name, before !== undefined, r.incoming);
            markSynced("messenger", c.chat, c.name, fp);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("busy:")) break; // owner is on Messenger - next run
            errors.push(`Messenger ${c.name}: ${msg}`);
          }
        }
      } catch (e) {
        errors.push(`Messenger: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { added, errors };
  } finally {
    S.busy = false;
    S.lastRunAt = new Date().toISOString();
    S.lastAdded = added;
    S.lastError = errors.length ? errors.slice(0, 3).join("; ") : undefined;
  }
}

/* One pass shortly after start, then every APEX_MSG_SYNC_MIN minutes
 * (read each time, so a Settings change applies to the next wait). Idempotent. */
export function startChatSync(): void {
  if (S.started) return;
  S.started = true;
  const loop = (delay: number) => {
    S.timer = setTimeout(async () => {
      await syncChats().catch((e) => { S.lastError = String(e); });
      loop(intervalMs());
    }, delay);
    S.timer.unref?.();
  };
  loop(30_000);
}

export function chatSyncStatus() {
  const n = get<{ n: number; chats: number }>("SELECT COUNT(*) AS n, COUNT(DISTINCT source || chat_id) AS chats FROM chat_archive");
  return { enabled: enabled(), rambox: ramboxOn(), messages: n?.n ?? 0, chats: n?.chats ?? 0, lastRunAt: S.lastRunAt, lastAdded: S.lastAdded, lastError: S.lastError };
}

export type ArchivedMsg = { id: number; source: string; chat_id: string; chat_name: string; at: string | null; time_label: string; sender: string; me: number; text: string; created_at: string };

/* Chats in the archive whose name matches (a person or group). */
export function archiveChats(name: string, source?: string, limit = 10) {
  return all<{ source: string; chat_id: string; chat_name: string; n: number; last: string }>(
    `SELECT source, chat_id, chat_name, COUNT(*) AS n, MAX(COALESCE(at, created_at)) AS last FROM chat_archive
     WHERE chat_name LIKE ? AND (? IS NULL OR source = ?) GROUP BY source, chat_id ORDER BY last DESC LIMIT ?`,
    `%${name}%`, source ?? null, source ?? null, limit,
  );
}

export function archiveMessages(source: string, chatId: string, limit: number, before?: string): ArchivedMsg[] {
  return all<ArchivedMsg>(
    `SELECT * FROM chat_archive WHERE source = ? AND chat_id = ? AND (? IS NULL OR COALESCE(at, created_at) < ?)
     ORDER BY COALESCE(at, created_at) DESC, id DESC LIMIT ?`,
    source, chatId, before ?? null, before ?? null, limit,
  ).reverse();
}

export function archiveSearch(query: string, opts: { source?: string; since?: string; limit: number }): ArchivedMsg[] {
  return all<ArchivedMsg>(
    `SELECT * FROM chat_archive WHERE (text LIKE ? OR chat_name LIKE ? OR sender LIKE ?) AND (? IS NULL OR source = ?)
       AND (? IS NULL OR COALESCE(at, created_at) >= ?)
     ORDER BY COALESCE(at, created_at) DESC LIMIT ?`,
    `%${query}%`, `%${query}%`, `%${query}%`, opts.source ?? null, opts.source ?? null, opts.since ?? null, opts.since ?? null, opts.limit,
  );
}
