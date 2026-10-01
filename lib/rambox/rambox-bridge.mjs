#!/usr/bin/env node
/* Rambox bridge. Starts Rambox with DevTools over a pipe (fds 3/4 - Rambox
 * refuses --remote-debugging-port, and a pipe opens no network port at all)
 * and serves a small read-only API that Apex uses to read WhatsApp Web and
 * Messenger inside Rambox:
 *
 *   GET /status
 *   GET /whatsapp/chats?limit=&query=
 *   GET /whatsapp/messages?chat=&limit=&earlier=1
 *   GET /whatsapp/search?q=&limit=
 *   GET /messenger/chats?limit=&query=
 *   GET /messenger/messages?thread=&limit=&background=1
 *
 * background=1 (the periodic archive sync) never switches the Messenger thread
 * while the owner has Messenger in front of him.
 *
 * Only these fixed page scripts ever run - there is no generic eval. The API
 * listens on 127.0.0.1 and requires the token from data/rambox-bridge.json
 * (0600), which Apex reads.
 *
 * The bridge keeps running as Rambox's keeper: when the owner quits Rambox,
 * the bridge waits (data/rambox-bridge.json is removed, so Apex falls back);
 * when Rambox is started any other way (Dock icon, login item), the bridge
 * quits it and starts it again with the pipe - logins are kept. */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAMBOX = process.env.RAMBOX_BIN || "/Applications/Rambox.app/Contents/MacOS/Rambox";
const PORT = Number(process.env.RAMBOX_BRIDGE_PORT || 3917);
const DATA = process.env.APEX_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const CONFIG = join(DATA, "rambox-bridge.json");
const TOKEN = randomBytes(24).toString("hex");
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- Rambox + CDP over the pipe ---------- */

const running = () => spawnSync("pgrep", ["-x", "Rambox"]).status === 0;
const WATCH_MS = 3_000;

let child = null;     // Rambox started by us, with the pipe
let toRambox = null;
let buf = "";
let seq = 0;
const waiting = new Map();

/* Rambox runs without the pipe (started from the Dock / at login): take it over. */
function takeOver() {
  log("Rambox běží bez bridge – restartuji ho");
  spawnSync("osascript", ["-e", 'quit app "Rambox"']);
  for (let i = 0; i < 40 && running(); i++) spawnSync("sleep", ["0.5"]);
  if (running()) { log("Rambox se nepodařilo ukončit – zkusím později"); return false; }
  return true;
}

function launch() {
  buf = "";
  child = spawn(RAMBOX, ["--remote-debugging-pipe"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const [, , , w, r] = child.stdio;
  toRambox = w;
  r.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      if (msg.method === "Target.detachedFromTarget") for (const [k, v] of sessions) if (v === msg.params.sessionId) sessions.delete(k);
    }
  });
  child.on("exit", (code) => {
    log("Rambox skončil", code, "– čekám, až ho zase spustíš");
    child = null;
    toRambox = null;
    sessions.clear();
    for (const [, done] of waiting) done({ error: { message: "Rambox skončil." } });
    waiting.clear();
    cleanup();
  });
  publish();
  log("Rambox spuštěn přes bridge");
}

/* Every few seconds: Rambox started by someone else → take it over. */
function watch() {
  if (child || !running()) return;
  if (takeOver()) launch();
}

function cdp(method, params = {}, sessionId) {
  if (!toRambox) return Promise.reject(new Error("Rambox neběží."));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP ${method}: timeout`)); }, 30_000);
    waiting.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    toRambox.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}

const SERVICES = { whatsapp: "https://web.whatsapp.com/", messenger: "https://www.messenger.com/" };
const sessions = new Map();

async function session(service) {
  const { targetInfos } = await cdp("Target.getTargets");
  const t = targetInfos.find((x) => x.type === "webview" && x.url.startsWith(SERVICES[service]));
  if (!t) throw new Error(`${service === "whatsapp" ? "WhatsApp" : "Messenger"} v Ramboxu není otevřený (služba chybí, je uspaná nebo odhlášená).`);
  if (!sessions.has(t.targetId)) {
    const { sessionId } = await cdp("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    sessions.set(t.targetId, sessionId);
  }
  return sessions.get(t.targetId);
}

/* Runs one of the fixed page functions below with JSON args. */
async function run(service, fn, args) {
  const sid = await session(service);
  const r = await cdp("Runtime.evaluate", {
    expression: `(${fn.toString()})(${JSON.stringify(args)})`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] || "chyba ve stránce");
  return r.result.value;
}

/* ---------- page scripts: WhatsApp Web ---------- */

function waChats({ limit, query }) {
  const C = require("WAWebCollections");
  const text = (m) => (m ? m.body || m.caption || `[${m.type}]` : "");
  const q = (query || "").toLowerCase();
  return C.Chat.getModelsArray()
    .filter((c) => c.id.server !== "broadcast" && c.id.user !== "status")
    .map((c) => ({
      id: c.id._serialized, name: c.formattedTitle || c.name || c.contact?.name || c.id.user,
      t: c.t || 0, unread: c.unreadCount || 0, group: !!c.isGroup, last: text(c.msgs.getModelsArray().at(-1)),
    }))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q))
    .sort((a, b) => b.t - a.t).slice(0, limit);
}

async function waMessages({ chat, limit, earlier }) {
  const C = require("WAWebCollections");
  const c = C.Chat.get(chat);
  if (!c) throw new Error("Chat nenalezen.");
  // after a fresh start only the last message is in memory: page in history until the limit is covered
  const L = require("WAWebChatLoadMessages");
  for (let i = 0; i < 6 && (earlier || c.msgs.length < limit); i++) {
    const before = c.msgs.length;
    try { await L.loadEarlierMsgs({ chat: c }); } catch { break; }
    if (c.msgs.length === before) break;
    earlier = false;
  }
  const who = (m) => {
    if (m.id.fromMe) return "já";
    const jid = m.author || m.from;
    const ct = jid && C.Contact.get(jid);
    return ct?.name || ct?.pushname || m.notifyName || (c.isGroup ? jid?.user : c.formattedTitle) || "?";
  };
  return {
    chat: c.formattedTitle || c.name || c.id.user,
    messages: c.msgs.getModelsArray().filter((m) => !m.isNotification && m.type !== "e2e_notification" && m.type !== "gp2")
      .slice(-limit).map((m) => ({ id: m.id._serialized, t: m.t, me: !!m.id.fromMe, from: who(m), text: m.body && m.type === "chat" ? m.body : m.caption || `[${m.type}]` })),
  };
}

async function waSearch({ q, limit }) {
  const C = require("WAWebCollections");
  const L = require("WAWebChatLoadMessages");
  const needle = q.toLowerCase();
  const chats = C.Chat.getModelsArray();
  // only loaded messages are searchable: page in recent history of the latest chats first
  for (const c of [...chats].sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 20)) {
    if (c.msgs.length < 40) { try { await L.loadEarlierMsgs({ chat: c }); } catch { /* skip this chat */ } }
  }
  const out = [];
  for (const c of chats) {
    for (const m of c.msgs.getModelsArray()) {
      const body = m.type === "chat" ? m.body : m.caption;
      if (body && body.toLowerCase().includes(needle)) {
        out.push({ chat: c.id._serialized, chatName: c.formattedTitle || c.name || c.id.user, t: m.t, me: !!m.id.fromMe, text: body });
      }
    }
  }
  return out.sort((a, b) => b.t - a.t).slice(0, limit);
}

/* ---------- page scripts: Messenger ---------- */

const THREAD_HREF = /^\/(e2ee\/)?t\/(\d+)\/?$/;

function msChats({ limit, query, re }) {
  const rx = new RegExp(re);
  const q = (query || "").toLowerCase();
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const m = rx.exec(a.getAttribute("href"));
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    const lines = a.innerText.split("\n").map((l) => l.trim()).filter((l) => l && l !== "·");
    if (!lines.length) continue;
    const name = lines[0];
    const tail = lines[lines.length - 1];
    const isTime = lines.length > 2 && /^(\d+\s*(min|h|d|t|týd|w|r|y)\b|\d{1,2}[:.]\d{2}|\d{1,2}\.\s*\d{1,2}\.|(po|út|st|čt|pá|so|ne|mon|tue|wed|thu|fri|sat|sun)\b)/i.test(tail);
    const time = isTime ? tail : "";
    const last = lines.slice(1, isTime ? -1 : undefined).join(" ");
    const unread = !!a.querySelector("[aria-label*='nepřečten' i], [aria-label*='unread' i]") || /nepřečten|unread/i.test(a.getAttribute("aria-label") || "");
    if (!q || name.toLowerCase().includes(q)) out.push({ id: m[2], e2ee: !!m[1], name, last, time, unread });
  }
  return out.slice(0, limit);
}

async function msMessages({ thread, limit, re, background }) {
  const rx = new RegExp(re);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const current = () => rx.exec(location.pathname)?.[2];
  const linkTo = (id) => [...document.querySelectorAll("a[href]")].find((a) => rx.exec(a.getAttribute("href"))?.[2] === id);
  const articles = () => [...(document.querySelector("[role=main] [role=log]")?.querySelectorAll("[role=article]") ?? [])];
  const back = current();
  let moved = false;
  if (current() !== thread) {
    if (background && document.visibilityState === "visible" && document.hasFocus()) throw new Error("busy: Messenger je právě otevřený – vlákno nepřepínám.");
    const a = linkTo(thread);
    if (!a) throw new Error("Vlákno není v seznamu chatů (načti ho přes messenger_chats).");
    a.click();
    moved = true;
    for (let i = 0; i < 40 && (current() !== thread || !articles().length); i++) await sleep(250);
    await sleep(800);
  }
  // accessibility line of each bubble, e.g. "… Zprávu poslal(a) Jana v 15:53: text"
  const META = /(?:posl\S*|sent by)\s+(.+?)\s+(?:v|at)\s+(\d{1,2}:\d{2})(?::|$)/i;
  const title = document.querySelector("[role=main] h1, [role=main] h2")?.innerText?.trim() || "";
  const messages = articles().slice(-limit).map((el) => {
    const lines = el.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    const meta = lines.length ? META.exec(lines[lines.length - 1]) : null;
    const body = (meta ? lines.slice(0, -1) : lines).join("\n");
    return { from: meta ? meta[1] : "", me: meta ? /^(já|you)$/i.test(meta[1]) : false, time: meta ? meta[2] : "", text: body };
  }).filter((m) => m.text);
  if (moved && back && back !== thread) linkTo(back)?.click();
  return { chat: title, messages };
}

/* ---------- HTTP API ---------- */

const int = (v, def, max) => Math.max(1, Math.min(max, Number(v) || def));

const ROUTES = {
  "/status": async () => {
    const { targetInfos } = await cdp("Target.getTargets");
    const has = (s) => targetInfos.some((t) => t.type === "webview" && t.url.startsWith(SERVICES[s]));
    return { ok: true, whatsapp: has("whatsapp"), messenger: has("messenger") };
  },
  "/whatsapp/chats": (p) => run("whatsapp", waChats, { limit: int(p.get("limit"), 15, 50), query: p.get("query") || "" }),
  "/whatsapp/messages": (p) => run("whatsapp", waMessages, { chat: String(p.get("chat") || ""), limit: int(p.get("limit"), 20, 100), earlier: p.get("earlier") === "1" }),
  "/whatsapp/search": (p) => run("whatsapp", waSearch, { q: String(p.get("q") || ""), limit: int(p.get("limit"), 15, 50) }),
  "/messenger/chats": (p) => run("messenger", msChats, { limit: int(p.get("limit"), 15, 50), query: p.get("query") || "", re: THREAD_HREF.source }),
  "/messenger/messages": (p) => run("messenger", msMessages, { thread: String(p.get("thread") || ""), limit: int(p.get("limit"), 20, 100), re: THREAD_HREF.source, background: p.get("background") === "1" }),
};

/* One page script at a time: Messenger reads may switch threads. */
let queue = Promise.resolve();

const server = http.createServer((req, res) => {
  const got = Buffer.from(String(req.headers["x-rambox-token"] || ""));
  const want = Buffer.from(TOKEN);
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const route = ROUTES[url.pathname];
  const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
  if (req.method !== "GET" || got.length !== want.length || !timingSafeEqual(got, want)) return reply(403, { error: "forbidden" });
  if (!route) return reply(404, { error: "not found" });
  if (/chat|thread/.test(url.pathname) && url.pathname.endsWith("messages") && !(url.searchParams.get("chat") || url.searchParams.get("thread"))) {
    return reply(400, { error: "chybí chat/thread" });
  }
  const job = queue.then(() => route(url.searchParams));
  queue = job.catch(() => {});
  job.then((data) => reply(200, { data }), (e) => reply(502, { error: e instanceof Error ? e.message : String(e) }));
});

/* data/rambox-bridge.json exists only while Rambox is attached - Apex uses
 * Rambox then and falls back to its other sources otherwise. */
function publish() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ port: PORT, token: TOKEN, pid: process.pid }), { mode: 0o600 });
  chmodSync(CONFIG, 0o600);
}
function cleanup() {
  try { rmSync(CONFIG, { force: true }); } catch { /* already gone */ }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); child?.kill("SIGTERM"); process.exit(0); });

server.listen(PORT, "127.0.0.1", () => {
  log(`Rambox bridge na 127.0.0.1:${PORT}`);
  if (running()) { if (takeOver()) launch(); } else launch();
  setInterval(watch, WATCH_MS);
});
