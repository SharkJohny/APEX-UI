import { createConnection } from "node:net";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* AI Command Center (the owner's terminal/agent dashboard). It exposes a
 * JSON-RPC socket (path in ~/.aicc/socket-path, one newline-terminated call
 * per connection - same as its `aicc` CLI). What an agent window is doing is
 * read from Claude Code's own session transcripts for the window's cwd, which
 * are clean text, unlike the terminal screen. */

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
  lastUser?: string; lastAssistant?: string; lastAssistantId?: string;
  /* the agent finished its turn (last entry is a plain text answer) */
  finished: boolean;
};

const projectDir = (cwd: string) => join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

/* The newest transcripts for a working directory (one per agent session). */
export function recentSessions(cwd: string, n: number): SessionInfo[] {
  const dir = projectDir(cwd);
  let files: { file: string; mtime: number }[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, n);
  } catch {
    return [];
  }
  return files.map((f) => ({ ...f, ...summarize(tail(f.file, 400_000)) }));
}

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

/* First sentence, short - what a notification shows. */
export function brief(text: string | undefined, max = 140): string {
  if (!text) return "";
  const t = text.replace(/[`*#>_]/g, "").replace(/\s+/g, " ").trim();
  const first = /^(.+?[.!?])(\s|$)/.exec(t)?.[1] ?? t;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
