import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* AI Command Center (the owner's terminal/agent dashboard). It exposes a
 * JSON-RPC socket (path in ~/.aicc/socket-path, one newline-terminated call
 * per connection - same as its `aicc` CLI). What an agent window is doing is
 * read from the Claude Code session transcript of exactly that window (see
 * terminalSessions), which is clean text, unlike the terminal screen. */

const SOCKET_FILE = join(homedir(), ".aicc", "socket-path");

export type AiccTerminal = {
  id: string; title: string; projectId: string; projectName: string;
  status: string; attention: boolean; cwd: string;
};

export function aiccAvailable(): boolean {
  return existsSync(SOCKET_FILE);
}

export function rpc<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let socketPath: string;
    try {
      socketPath = readFileSync(SOCKET_FILE, "utf8").trim();
    } catch {
      return reject(new Error("AI Command Center neběží."));
    }
    const sock = createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("AI Command Center neodpovídá.")); }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        const resp = JSON.parse(buf.slice(0, nl));
        if (resp.error) reject(new Error(`AI Command Center: ${resp.error.message ?? "chyba"}`));
        else resolve(resp.result as T);
      } catch {
        reject(new Error("AI Command Center: neplatná odpověď."));
      }
    });
    sock.on("error", () => { clearTimeout(timer); reject(new Error("AI Command Center neběží.")); });
  });
}

export async function listTerminals(): Promise<AiccTerminal[]> {
  const r = await rpc<{ terminals: AiccTerminal[] }>("terminal.list");
  return r.terminals ?? [];
}

/* Types the text into the window and presses Enter. One line: a newline
 * would submit early in an agent TUI. */
export async function sendToTerminal(id: string, text: string): Promise<void> {
  await rpc("terminal.write", { id, input: text.replace(/\s*\n\s*/g, " ").trim() });
  await new Promise((r) => setTimeout(r, 150));
  await rpc("terminal.write", { id, input: "\r" });
}

/* ---------- roadmap (.dashboard/roadmap.md, kept by every project's agent) ---------- */

export type RoadmapItem = { text: string; done: boolean };

export function readRoadmap(dir: string): RoadmapItem[] {
  try {
    return readFileSync(join(dir, ".dashboard", "roadmap.md"), "utf8").split("\n")
      .map((l) => /^\s*- \[([ xX])\]\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ done: m[1] !== " ", text: m[2].trim() }));
  } catch {
    return [];
  }
}

/* ---------- Claude Code transcripts ---------- */

export type SessionInfo = {
  file: string; mtime: number;
  /* Claude Code's own state of the window's agent, when known exactly */
  status?: string;
  lastUser?: string; lastAssistant?: string; lastAssistantId?: string;
  /* the agent finished its turn (last entry is a plain text answer) */
  finished: boolean;
};

const projectDir = (cwd: string) => join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

/* Exact window → agent session: every agent process started by AI Command
 * Center carries AICC_TERMINAL_ID in its environment, and Claude Code keeps
 * ~/.claude/sessions/<pid>.json (sessionId, cwd, busy/idle). */
export type WindowAgent = { agent: "claude" | "codex"; sessionId?: string; cwd?: string; status?: string };

export function terminalSessions(): Map<string, WindowAgent> {
  const out = new Map<string, WindowAgent>();
  const ps = spawnSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" }).stdout ?? "";
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(?:.*\/)?(claude|codex)$/.exec(line);
    if (!m) continue;
    const pid = m[1];
    const env = spawnSync("ps", ["eww", "-o", "command=", "-p", pid], { encoding: "utf8" }).stdout ?? "";
    const term = /\bAICC_TERMINAL_ID=([0-9a-f-]{36})\b/.exec(env)?.[1];
    if (!term) continue;
    if (m[2] === "codex") { if (!out.has(term)) out.set(term, { agent: "codex" }); continue; }
    try {
      const j = JSON.parse(readFileSync(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf8"));
      if (j.sessionId && j.cwd) out.set(term, { agent: "claude", sessionId: j.sessionId, cwd: j.cwd, status: j.status });
    } catch { /* not a Claude Code session file (yet) */ }
  }
  return out;
}

/* The Claude Code session of each window, matched exactly (see
 * terminalSessions). Windows running Codex or no agent get none - a guess by
 * folder would show another window's or an old session. agent tells which. */
export function sessionsFor(terminals: AiccTerminal[]): Map<string, (SessionInfo & { agent: string }) | { agent: string } | undefined> {
  const exact = terminalSessions();
  const out = new Map<string, (SessionInfo & { agent: string }) | { agent: string } | undefined>();
  for (const t of terminals) {
    const x = exact.get(t.id);
    if (!x) { out.set(t.id, undefined); continue; }
    if (x.agent !== "claude" || !x.sessionId || !x.cwd) { out.set(t.id, { agent: x.agent }); continue; }
    const file = join(projectDir(x.cwd), `${x.sessionId}.jsonl`);
    try {
      out.set(t.id, { agent: "claude", file, mtime: statSync(file).mtimeMs, status: x.status, ...summarize(tail(file, 400_000)) });
    } catch {
      out.set(t.id, { agent: "claude", status: x.status }); // no transcript yet
    }
  }
  return out;
}

export const sessionOf = (v: ReturnType<typeof sessionsFor> extends Map<string, infer V> ? V : never): SessionInfo | undefined =>
  v && "file" in v ? v : undefined;

function tail(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const s = buf.toString("utf8");
    return len < size ? s.slice(s.indexOf("\n") + 1) : s;
  } finally {
    closeSync(fd);
  }
}

type Block = { type?: string; text?: string };

function summarize(raw: string): Omit<SessionInfo, "file" | "mtime"> {
  let lastUser: string | undefined;
  let lastAssistant: string | undefined;
  let lastAssistantId: string | undefined;
  let finished = false;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: { type?: string; isMeta?: boolean; uuid?: string; message?: { content?: string | Block[] } };
    try { e = JSON.parse(line); } catch { continue; }
    const c = e.message?.content;
    if (e.type === "user" && !e.isMeta) {
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
      const isToolResult = Array.isArray(c) && c.some((b) => b.type === "tool_result");
      if (text && !isToolResult && !/^<(command-|local-command|system-reminder)/.test(text.trim())) lastUser = text;
      if (text || isToolResult) finished = false;
    } else if (e.type === "assistant" && Array.isArray(c)) {
      const text = c.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      const usesTool = c.some((b) => b.type === "tool_use");
      if (text) { lastAssistant = text; lastAssistantId = e.uuid; }
      finished = !!text && !usesTool;
    }
  }
  return { lastUser, lastAssistant, lastAssistantId, finished };
}

/* New conversation turns of a transcript since byte `from` (complete lines
 * only). The first read of a file starts at most FIRST_READ from its end, so
 * a huge old session doesn't flood the archive. */
export type Turn = { uuid: string; role: "user" | "assistant"; text: string; at?: string };
const FIRST_READ = 1_000_000;
const MAX_READ = 5_000_000;

export function readTurns(file: string, from: number | undefined): { turns: Turn[]; offset: number } {
  const size = statSync(file).size;
  let start = from ?? Math.max(0, size - FIRST_READ);
  if (start > size) start = 0; // file was replaced
  const len = Math.min(size - start, MAX_READ);
  if (len <= 0) return { turns: [], offset: start };
  const fd = openSync(file, "r");
  let raw: string;
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    raw = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  // skip a partial first line on a mid-file start; keep a partial last line for next time
  const head = from === undefined && start > 0 ? raw.indexOf("\n") + 1 : 0;
  const end = raw.lastIndexOf("\n") + 1;
  const turns: Turn[] = [];
  for (const line of raw.slice(head, end).split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: { type?: string; isMeta?: boolean; uuid?: string; timestamp?: string; message?: { content?: string | Block[] } };
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.uuid) continue;
    const c = e.message?.content;
    if (e.type === "user" && !e.isMeta) {
      if (Array.isArray(c) && c.some((b) => b.type === "tool_result")) continue;
      const text = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "").trim();
      if (text && !/^<(command-|local-command|system-reminder|task-notification)/.test(text)) turns.push({ uuid: e.uuid, role: "user", text, at: e.timestamp });
    } else if (e.type === "assistant" && Array.isArray(c)) {
      const text = c.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) turns.push({ uuid: e.uuid, role: "assistant", text, at: e.timestamp });
    }
  }
  return { turns, offset: start + Buffer.byteLength(raw.slice(0, end), "utf8") };
}

/* First sentence, short - what a notification shows. */
export function brief(text: string | undefined, max = 140): string {
  if (!text) return "";
  const t = text.replace(/[`*#>_]/g, "").replace(/\s+/g, " ").trim();
  const first = /^(.+?[.!?])(\s|$)/.exec(t)?.[1] ?? t;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
