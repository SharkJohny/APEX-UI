import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../db";

/* Read-only access to the owner's chats. WhatsApp and Messenger come from
 * Rambox through the local Rambox bridge (lib/rambox/rambox-bridge.mjs) when
 * it runs; otherwise WhatsApp falls back to the WhatsApp for Mac database and
 * Messenger to the business page's Graph API. iMessage/SMS is read from the
 * local database, Instagram DMs over the Graph API. Nothing here sends a
 * message. Reading ~/Library/Messages and the WhatsApp group container needs
 * Full Disk Access for the process running the server. */

export const SOURCES = ["whatsapp", "imessage", "messenger", "instagram"] as const;
export type Source = (typeof SOURCES)[number];

/* when: a display time when no exact date is known (Messenger in Rambox). */
export type Chat = { source: Source; chat: string; name: string; last: string | null; when?: string; snippet: string; unread?: number };
/* time: a display time when no exact date is known (Messenger in Rambox shows "16:22", "3 h"). */
export type Msg = { id?: string; source: Source; chat: string; chatName?: string; at: string | null; time?: string; from: string; me: boolean; text: string };

const MSG_MAX = 1000;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/* Apple Core Data / iMessage dates count from 2001-01-01 (iMessage in ns). */
const APPLE_EPOCH = 978_307_200;
function appleDate(v: unknown): string | null {
  const n = Number(v);
  if (!n) return null;
  const secs = n > 1e12 ? n / 1e9 : n;
  return new Date((secs + APPLE_EPOCH) * 1000).toISOString();
}
const toApple = (iso: string) => Date.parse(iso) / 1000 - APPLE_EPOCH;

const enabled = (key: string) => process.env[key] !== "0";

/* ---------- local databases ---------- */

const home = () => homedir();
export const whatsappPath = () =>
  process.env.APEX_WHATSAPP_DB?.replace(/^~/, home()) ||
  join(home(), "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite");
export const imessagePath = () => join(home(), "Library/Messages/chat.db");

const FDA_HINT = "macOS nepovolil přístup – dej aplikaci, ve které běží Apex server (Terminál / iTerm / node), Plný přístup k disku v Nastavení systému › Soukromí a zabezpečení a restartuj server.";

function openLocal(path: string, label: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`${label}: databáze nenalezena (${path}).`);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");
    return db;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/authoriz|permission|not permitted|unable to open/i.test(msg) ? `${label}: ${FDA_HINT}` : `${label}: ${msg}`);
  }
}

function withDb<T>(path: string, label: string, fn: (db: DatabaseSync) => T): T {
  const db = openLocal(path, label);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const hasColumn = (db: DatabaseSync, table: string, col: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

/* ---------- WhatsApp (ChatStorage.sqlite of WhatsApp for Mac) ---------- */

const jidName = (jid: unknown) => String(jid ?? "").replace(/@.*$/, "");

function waChats(limit: number, query?: string): Chat[] {
  return withDb(whatsappPath(), "WhatsApp", (db) => {
    const rows = db.prepare(
      `SELECT Z_PK AS id, ZPARTNERNAME AS name, ZCONTACTJID AS jid, ZLASTMESSAGEDATE AS last,
              ZLASTMESSAGETEXT AS snippet, ZUNREADCOUNT AS unread
       FROM ZWACHATSESSION
       WHERE ZCONTACTJID NOT LIKE '%status%' AND (? IS NULL OR ZPARTNERNAME LIKE ? OR ZCONTACTJID LIKE ?)
       ORDER BY ZLASTMESSAGEDATE DESC LIMIT ?`,
    ).all(query ?? null, `%${query ?? ""}%`, `%${query ?? ""}%`, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      source: "whatsapp" as const, chat: String(r.id), name: String(r.name || jidName(r.jid)),
      last: appleDate(r.last), snippet: clip(String(r.snippet ?? ""), 120), unread: Number(r.unread) || 0,
    }));
  });
}

function waMessages(db: DatabaseSync, where: string, params: (string | number | null)[], limit: number): Msg[] {
  const member = hasColumn(db, "ZWAMESSAGE", "ZGROUPMEMBER");
  const rows = db.prepare(
    `SELECT m.ZCHATSESSION AS chat, s.ZPARTNERNAME AS chatName, m.ZMESSAGEDATE AS at, m.ZISFROMME AS me,
            m.ZTEXT AS text, m.ZFROMJID AS fromJid${member ? ", g.ZCONTACTNAME AS member, g.ZMEMBERJID AS memberJid" : ""}
     FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
     ${member ? "LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK = m.ZGROUPMEMBER" : ""}
     WHERE m.ZTEXT IS NOT NULL AND m.ZTEXT != '' AND ${where}
     ORDER BY m.ZMESSAGEDATE DESC LIMIT ?`,
  ).all(...params, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    source: "whatsapp" as const, chat: String(r.chat), chatName: String(r.chatName ?? ""), at: appleDate(r.at),
    me: !!r.me, from: r.me ? "já" : String(r.member || jidName(r.memberJid) || r.chatName || jidName(r.fromJid)),
    text: clip(String(r.text), MSG_MAX),
  }));
}

/* ---------- iMessage / SMS (~/Library/Messages/chat.db) ---------- */

/* Newer macOS leaves message.text empty and keeps the text in the
 * attributedBody typedstream: the NSString payload follows its class name. */
export function decodeAttributedBody(blob: unknown): string {
  if (!(blob instanceof Uint8Array)) return "";
  const buf = Buffer.from(blob);
  const i = buf.indexOf("NSString");
  if (i < 0) return "";
  let p = i + "NSString".length + 5;
  let len = buf[p];
  if (len === 0x81) { len = buf.readUInt16LE(p + 1); p += 3; }
  else if (len === 0x82) { len = buf.readUInt32LE(p + 1); p += 5; }
  else p += 1;
  return buf.subarray(p, p + len).toString("utf8");
}

/* message.date is nanoseconds on current macOS - past 2^53, so convert in SQL. */
const IM_SECS = "(CASE WHEN m.date > 1000000000000 THEN m.date / 1000000000.0 ELSE m.date END)";

const imText = (r: Record<string, unknown>) => String(r.text || decodeAttributedBody(r.body) || "").replace(/￼/g, "").trim();

function imChats(limit: number, query?: string): Chat[] {
  return withDb(imessagePath(), "iMessage", (db) => {
    const rows = db.prepare(
      `SELECT c.ROWID AS id, c.display_name AS name, c.chat_identifier AS ident, c.service_name AS service,
              MAX(${IM_SECS}) AS last
       FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID JOIN message m ON m.ROWID = j.message_id
       WHERE (? IS NULL OR c.display_name LIKE ? OR c.chat_identifier LIKE ?)
       GROUP BY c.ROWID ORDER BY last DESC LIMIT ?`,
    ).all(query ?? null, `%${query ?? ""}%`, `%${query ?? ""}%`, limit) as Record<string, unknown>[];
    const lastMsg = db.prepare(
      `SELECT m.text, m.attributedBody AS body FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID
       WHERE j.chat_id = ? ORDER BY m.date DESC LIMIT 1`,
    );
    return rows.map((r) => ({
      source: "imessage" as const, chat: String(r.id), name: String(r.name || r.ident),
      last: appleDate(r.last), snippet: clip(imText((lastMsg.get(Number(r.id)) ?? {}) as Record<string, unknown>), 120),
    }));
  });
}

function imMessages(db: DatabaseSync, where: string, params: (string | number | null)[], limit: number): Msg[] {
  const rows = db.prepare(
    `SELECT j.chat_id AS chat, c.display_name AS chatName, c.chat_identifier AS ident, ${IM_SECS} AS at,
            m.is_from_me AS me, m.text, m.attributedBody AS body, h.id AS handle
     FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id
     LEFT JOIN handle h ON h.ROWID = m.handle_id
     WHERE ${where} ORDER BY m.date DESC LIMIT ?`,
  ).all(...params, limit) as Record<string, unknown>[];
  return rows
    .map((r) => ({
      source: "imessage" as const, chat: String(r.chat), chatName: String(r.chatName || r.ident || ""), at: appleDate(r.at),
      me: !!r.me, from: r.me ? "já" : String(r.handle || r.ident || "?"), text: clip(imText(r), MSG_MAX),
    }))
    .filter((m) => m.text);
}

/* ---------- Messenger / Instagram DMs (Graph API, business page) ---------- */

const FB_API = "https://graph.facebook.com/v21.0";
const pageId = () => process.env.FB_PAGE_ID || "";
const pageToken = () => process.env.FB_PAGE_TOKEN || "";

async function graph(path: string, params: Record<string, string>): Promise<any> {
  if (!pageId() || !pageToken()) throw new Error("Messenger/Instagram: nastav FB_PAGE_ID a FB_PAGE_TOKEN (Nastavení › Sociální sítě); token potřebuje oprávnění pages_messaging, pro Instagram instagram_manage_messages.");
  const url = new URL(`${FB_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", pageToken());
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Graph API: ${data.error?.message || res.status}`);
  return data;
}

const platform = (s: Source) => (s === "instagram" ? "instagram" : "messenger");

async function metaChats(source: Source, limit: number, query?: string): Promise<Chat[]> {
  const d = await graph(`${pageId()}/conversations`, {
    platform: platform(source), limit: String(query ? 50 : limit),
    fields: "id,updated_time,unread_count,participants,messages.limit(1){message}",
  });
  const chats: Chat[] = (d.data ?? []).map((c: any) => {
    const other = (c.participants?.data ?? []).find((p: any) => p.id !== pageId()) ?? {};
    return {
      source, chat: String(c.id), name: String(other.name || other.username || other.id || "?"),
      last: c.updated_time ?? null, snippet: clip(String(c.messages?.data?.[0]?.message ?? ""), 120), unread: Number(c.unread_count) || 0,
    };
  });
  const q = query?.toLowerCase();
  return (q ? chats.filter((c) => c.name.toLowerCase().includes(q)) : chats).slice(0, limit);
}

async function metaMessages(source: Source, chat: string, limit: number): Promise<Msg[]> {
  if (!/^[A-Za-z0-9_:.-]{1,200}$/.test(chat)) throw new Error("Neplatné ID konverzace.");
  const d = await graph(chat, { fields: `messages.limit(${limit}){message,from,created_time}` });
  return (d.messages?.data ?? []).map((m: any) => ({
    source, chat, at: m.created_time ?? null, me: m.from?.id === pageId(),
    from: m.from?.id === pageId() ? "já (stránka)" : String(m.from?.name || m.from?.username || m.from?.id || "?"),
    text: clip(String(m.message ?? ""), MSG_MAX),
  })).filter((m: Msg) => m.text);
}

/* ---------- Rambox bridge (WhatsApp Web + Messenger inside Rambox) ---------- */

const BRIDGE_FILE = join(DATA_DIR, "rambox-bridge.json");
export const ramboxOn = () => enabled("APEX_MSG_RAMBOX") && existsSync(BRIDGE_FILE);
const unix = (t: unknown) => (Number(t) ? new Date(Number(t) * 1000).toISOString() : null);

async function bridge<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  let cfg: { port: number; token: string };
  try {
    cfg = JSON.parse(readFileSync(BRIDGE_FILE, "utf8"));
  } catch {
    throw new Error("Rambox bridge neběží – spusť ho (npm run rambox).");
  }
  const url = new URL(`http://127.0.0.1:${cfg.port}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-rambox-token": cfg.token }, signal: AbortSignal.timeout(90_000) });
  } catch {
    throw new Error("Rambox bridge neodpovídá – běží Rambox přes bridge (npm run rambox)?");
  }
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new Error(`Rambox: ${body.error || res.status}`);
  return body.data as T;
}

type RbWaChat = { id: string; name: string; t: number; unread: number; group: boolean; last: string };
type RbMsChat = { id: string; name: string; last: string; time: string; unread: boolean };

export async function rbChats(source: "whatsapp" | "messenger", limit: number, query?: string): Promise<Chat[]> {
  if (source === "whatsapp") {
    const rows = await bridge<RbWaChat[]>("/whatsapp/chats", { limit, query });
    return rows.map((c) => ({ source, chat: c.id, name: c.name, last: unix(c.t), snippet: clip(c.last, 120), unread: c.unread }));
  }
  const rows = await bridge<RbMsChat[]>("/messenger/chats", { limit, query });
  return rows.map((c) => ({ source, chat: c.id, name: c.name, last: null, when: c.time, snippet: clip(c.last, 120), unread: c.unread ? 1 : 0 }));
}

/* background: the archive sync - never switch the Messenger thread the owner is looking at. */
export async function rbMessages(source: "whatsapp" | "messenger", chat: string, limit: number, background = false): Promise<Msg[]> {
  if (source === "whatsapp") {
    const r = await bridge<{ chat: string; messages: { id: string; t: number; me: boolean; from: string; text: string }[] }>("/whatsapp/messages", { chat, limit });
    return r.messages.map((m) => ({ id: m.id, source, chat, chatName: r.chat, at: unix(m.t), me: m.me, from: m.from, text: clip(m.text, MSG_MAX) }));
  }
  const r = await bridge<{ chat: string; messages: { from: string; me: boolean; time: string; text: string }[] }>("/messenger/messages", { thread: chat, limit, background: background ? 1 : undefined });
  return r.messages.map((m) => ({ source, chat, chatName: r.chat, at: null, time: m.time, me: m.me, from: m.from || "?", text: clip(m.text, MSG_MAX) }));
}

async function rbSearch(query: string, limit: number): Promise<Msg[]> {
  const rows = await bridge<{ chat: string; chatName: string; t: number; me: boolean; text: string }[]>("/whatsapp/search", { q: query, limit });
  return rows.map((m) => ({ source: "whatsapp" as const, chat: m.chat, chatName: m.chatName, at: unix(m.t), me: m.me, from: m.me ? "já" : m.chatName, text: clip(m.text, MSG_MAX) }));
}

/* ---------- public API ---------- */

export type SourceStatus = { enabled: boolean; ok: boolean; note: string };

export function messagesStatus(): Record<Source, SourceStatus> {
  const local = (key: string, path: string, label: string, table: string): SourceStatus => {
    if (!enabled(key)) return { enabled: false, ok: false, note: "vypnuto v Nastavení" };
    try {
      const n = withDb(path, label, (db) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
      return { enabled: true, ok: true, note: `${n} konverzací` };
    } catch (e) {
      return { enabled: true, ok: false, note: e instanceof Error ? e.message : String(e) };
    }
  };
  const meta = (key: string): SourceStatus => {
    if (!enabled(key)) return { enabled: false, ok: false, note: "vypnuto v Nastavení" };
    return pageId() && pageToken()
      ? { enabled: true, ok: true, note: "token stránky nastaven (ověř testem)" }
      : { enabled: true, ok: false, note: "chybí FB_PAGE_ID / FB_PAGE_TOKEN" };
  };
  const rambox = (key: string): SourceStatus | undefined =>
    enabled(key) && ramboxOn() ? { enabled: true, ok: true, note: "přes Rambox (bridge)" } : undefined;
  return {
    whatsapp: rambox("APEX_MSG_WHATSAPP") ?? local("APEX_MSG_WHATSAPP", whatsappPath(), "WhatsApp", "ZWACHATSESSION"),
    imessage: local("APEX_MSG_IMESSAGE", imessagePath(), "iMessage", "chat"),
    messenger: rambox("APEX_MSG_MESSENGER") ?? meta("APEX_MSG_MESSENGER"),
    instagram: meta("APEX_MSG_INSTAGRAM"),
  };
}

const ENABLE_KEY: Record<Source, string> = {
  whatsapp: "APEX_MSG_WHATSAPP", imessage: "APEX_MSG_IMESSAGE", messenger: "APEX_MSG_MESSENGER", instagram: "APEX_MSG_INSTAGRAM",
};

function requireEnabled(s: Source) {
  if (!enabled(ENABLE_KEY[s])) throw new Error(`Zdroj ${s} je vypnutý v Nastavení › Zprávy.`);
}

/* Several sources at once: each failure becomes a note instead of failing the whole call. */
async function each<T>(sources: Source[], fn: (s: Source) => T[] | Promise<T[]>): Promise<{ items: T[]; errors: string[] }> {
  const items: T[] = [];
  const errors: string[] = [];
  for (const s of sources) {
    try {
      requireEnabled(s);
      items.push(...(await fn(s)));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { items, errors };
}

const pick = (source?: Source) => (source ? [source] : SOURCES.filter((s) => enabled(ENABLE_KEY[s]) &&
  (s === "whatsapp" || s === "imessage" || (s === "messenger" && ramboxOn()) || (pageId() && pageToken()))));
/* WhatsApp and Messenger go through Rambox whenever its bridge runs. */
type RbSource = "whatsapp" | "messenger";
const viaRambox = (s: Source) => (s === "whatsapp" || s === "messenger") && ramboxOn();
const byDateDesc = (a: { last?: string | null; at?: string | null }, b: { last?: string | null; at?: string | null }) =>
  String(b.last ?? b.at ?? "").localeCompare(String(a.last ?? a.at ?? ""));

export async function listChats(o: { source?: Source; limit: number; query?: string }) {
  const r = await each(pick(o.source), (s) =>
    viaRambox(s) ? rbChats(s as RbSource, o.limit, o.query) : s === "whatsapp" ? waChats(o.limit, o.query) : s === "imessage" ? imChats(o.limit, o.query) : metaChats(s, o.limit, o.query));
  return { chats: r.items.sort(byDateDesc).slice(0, o.limit), errors: r.errors };
}

export async function readChat(o: { source: Source; chat: string; limit: number; before?: string }): Promise<Msg[]> {
  requireEnabled(o.source);
  const id = Number(o.chat);
  let rows: Msg[];
  if (viaRambox(o.source)) {
    return rbMessages(o.source as RbSource, o.chat, o.limit); // already chronological (Messenger has no exact dates)
  } else if (o.source === "whatsapp") {
    if (!Number.isInteger(id)) throw new Error("WhatsApp: chat je číselné ID z messages_chats.");
    rows = withDb(whatsappPath(), "WhatsApp", (db) => waMessages(db, "m.ZCHATSESSION = ? AND (? IS NULL OR m.ZMESSAGEDATE < ?)",
      [id, o.before ?? null, o.before ? toApple(o.before) : null], o.limit));
  } else if (o.source === "imessage") {
    if (!Number.isInteger(id)) throw new Error("iMessage: chat je číselné ID z messages_chats.");
    rows = withDb(imessagePath(), "iMessage", (db) => imMessages(db, `j.chat_id = ? AND (? IS NULL OR ${IM_SECS} < ?)`,
      [id, o.before ?? null, o.before ? toApple(o.before) : null], o.limit));
  } else {
    rows = await metaMessages(o.source, o.chat, o.limit);
  }
  return rows.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
}

/* Full-text-ish search over the local sources (Graph API has no message search). */
export async function searchMessages(o: { query: string; source?: Source; days: number; limit: number }) {
  const sources = pick(o.source).filter((s) => s === "whatsapp" || s === "imessage");
  const since = new Date(Date.now() - o.days * 86_400_000).toISOString();
  const q = o.query.toLowerCase();
  const r = await each(sources, async (s) => {
    if (viaRambox(s)) {
      const sinceMs = Date.parse(since);
      return (await rbSearch(o.query, o.limit)).filter((m) => !m.at || Date.parse(m.at) >= sinceMs);
    }
    if (s === "whatsapp") {
      return withDb(whatsappPath(), "WhatsApp", (db) =>
        waMessages(db, "m.ZMESSAGEDATE >= ? AND m.ZTEXT LIKE ?", [toApple(since), `%${o.query}%`], o.limit));
    }
    // attributedBody is not searchable in SQL: scan the window's recent messages
    return withDb(imessagePath(), "iMessage", (db) =>
      imMessages(db, `${IM_SECS} >= ?`, [toApple(since)], 20_000)).filter((m) => m.text.toLowerCase().includes(q)).slice(0, o.limit);
  });
  return { messages: r.items.sort(byDateDesc).slice(0, o.limit), errors: r.errors };
}
