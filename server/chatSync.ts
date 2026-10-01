import { createHash } from "node:crypto";
import { all, get, run } from "./db";
import { rbChats, rbMessages, ramboxOn, type Msg } from "./integrations/messages";

/* Apex's memory of the owner's chats: every few minutes the chats that got
 * new messages in Rambox (WhatsApp Web, Messenger) are copied into
 * chat_archive, so "what did I write with X" works even when Rambox is
 * closed, and the semantic indexer can find it. Read-only towards the chats. */

const INTERVAL_MS = 10 * 60_000;
const WA_CHATS = 40;
const WA_MSGS = 100;
const MS_CHATS = 25;
/* Reading a Messenger thread switches Rambox's view for a moment - keep it rare. */
const MS_THREADS_PER_RUN = 5;
const MS_MSGS = 40;

type SyncState = { started?: boolean; busy?: boolean; timer?: ReturnType<typeof setInterval>; lastRunAt?: string; lastError?: string; lastAdded?: number };
const g = globalThis as { __apexChatSync?: SyncState };
const S: SyncState = (g.__apexChatSync ??= {});

const enabled = () => process.env.APEX_MSG_ARCHIVE !== "0";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

function store(msgs: Msg[], chatName: string): number {
  let added = 0;
  for (const m of msgs) {
    if (!m.text.trim()) continue;
    // WhatsApp has stable ids; Messenger only what the bubble shows
    const key = m.id ? `${m.source}:${m.id}` : `${m.source}:${m.chat}:${sha1(`${m.from}\u0000${m.time ?? ""}\u0000${m.text}`)}`;
    const r = run(
      `INSERT OR IGNORE INTO chat_archive (source, chat_id, chat_name, at, time_label, sender, me, text, key) VALUES (?,?,?,?,?,?,?,?,?)`,
      m.source, m.chat, m.chatName || chatName, m.at, m.time ?? "", m.from, m.me ? 1 : 0, m.text, key,
    );
    added += Number(r.changes);
  }
  return added;
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
          if (fingerprint("whatsapp", c.chat) === fp) continue;
          try {
            added += store(await rbMessages("whatsapp", c.chat, WA_MSGS, true), c.name);
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
          if (fingerprint("messenger", c.chat) === fp) continue;
          if (threads++ >= MS_THREADS_PER_RUN) break;
          try {
            added += store(await rbMessages("messenger", c.chat, MS_MSGS, true), c.name);
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

/* One pass shortly after start, then every 10 minutes. Idempotent. */
export function startChatSync(): void {
  if (S.started) return;
  S.started = true;
  const tick = () => { syncChats().catch((e) => { S.lastError = String(e); }); };
  setTimeout(tick, 30_000).unref?.();
  S.timer = setInterval(tick, INTERVAL_MS);
  S.timer.unref?.();
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
