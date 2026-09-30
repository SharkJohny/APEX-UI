import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalToken, type Run } from "./events";
import { run as dbRun } from "./db";

/* One way to call a model, for every agent. The CLI providers run on the
 * user's own subscription login (no API key); claude and codex also get the
 * Apex MCP bridge so the agent can use its tools. Gemini and the paid API
 * providers are chat-only (no tools). Every call lands in llm_calls. */

export type ProviderInfo = { id: string; label: string; kind: "subscription" | "api"; tools: boolean };

/* Read per call: the owner can change it in Settings without a restart. */
export const llmTimeoutMs = () => Number(process.env.APEX_LLM_TIMEOUT_MS || 600_000);
const MCP_SCRIPT = join(process.cwd(), "lib", "mcp", "apex-mcp.mjs");

const gBase = globalThis as { __apexOrigin?: string };

/* Where this server is reachable - for the MCP bridge and the OAuth redirect.
 * APEX_BASE_URL wins; otherwise the origin the Apex page was actually opened
 * on (remembered from requests), so a non-default port just works. */
export function baseUrl(): string {
  return process.env.APEX_BASE_URL || gBase.__apexOrigin || `http://127.0.0.1:${process.env.PORT || 3000}`;
}
export function rememberOrigin(request: Request) {
  const host = request.headers.get("host");
  if (host) gBase.__apexOrigin = `http://${host.replace(/^localhost/, "127.0.0.1")}`;
}

/* Children get only what they need to run and find their own login - never
 * the server's secrets (OAuth client secret, social tokens, API keys). */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|LANG|LC_[A-Z]+|TZ|XDG_[A-Z_]+|CLAUDE_CONFIG_DIR|CODEX_HOME|__CF_USER_TEXT_ENCODING|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/;
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ENV_ALLOW.test(k)) env[k] = v;
  return { ...env, ...extra };
}

const CLI: Record<string, { bin: string; label: string; tools: boolean }> = {
  claude: { bin: "claude", label: "Claude (předplatné)", tools: true },
  codex: { bin: "codex", label: "ChatGPT / Codex (předplatné)", tools: true },
  gemini: { bin: "gemini", label: "Gemini (předplatné, bez nástrojů)", tools: false },
};

const g = globalThis as { __apexProviders?: ProviderInfo[] };

export function detectProviders(): ProviderInfo[] {
  if (g.__apexProviders) return g.__apexProviders;
  const list: ProviderInfo[] = [];
  for (const [id, c] of Object.entries(CLI)) {
    if (spawnSync("which", [c.bin]).status === 0) list.push({ id, label: c.label, kind: "subscription", tools: c.tools });
  }
  if (process.env.OPENAI_API_KEY) list.push({ id: "openai-api", label: "OpenAI API (bez nástrojů)", kind: "api", tools: false });
  if (process.env.ANTHROPIC_API_KEY) list.push({ id: "anthropic-api", label: "Anthropic API (bez nástrojů)", kind: "api", tools: false });
  g.__apexProviders = list;
  return list;
}

export function providerSupportsTools(id: string): boolean {
  return !!CLI[id]?.tools;
}

export type LlmRequest = {
  provider: string;
  agent: string;
  system: string;
  prompt: string;
  /* Attach the Apex MCP bridge for this run (tool-capable providers only). */
  run?: Run;
  /* Built-in web tools for this agent (claude: WebSearch/WebFetch; codex: web search). */
  native?: string[];
  onToken?: (t: string) => void;
  signal: AbortSignal;
  /* Wall-clock budget for this call (defaults to APEX_LLM_TIMEOUT_MS). */
  timeoutMs?: number;
  /* Native CLI session (claude/codex only): the CLI keeps the conversation,
   * so a resumed turn sends only the new message. Runs in the fixed cwd. */
  session?: { id: string; resume: boolean; cwd: string };
};

/* sessionId: the CLI session this call ran in (codex assigns its own).
 * contextTokens: how big the session's context was at the end of the call. */
export type LlmResult = { text: string; costUsd?: number; sessionId?: string; contextTokens?: number };

/* The stored CLI session can't be resumed (deleted, expired, corrupt) - the
 * caller should start over with a fresh session and the transcript. */
const SESSION_LOST = /No conversation found|no rollout found|thread\/resume|already in use|session.*(not found|invalid|corrupt)/i;
export function isSessionLost(e: unknown): boolean {
  return e instanceof Error && SESSION_LOST.test(e.message);
}

/* Model per role (Settings): the chief and the specialists can run different
 * models on the subscription CLIs; the legacy single key is the fallback for
 * both. Empty = the CLI's own default. Read at call time so changes apply live. */
function cliModel(cli: "CLAUDE" | "CODEX", agent: string): string | undefined {
  const role = agent === "chief_of_staff" ? "CHIEF" : "SPECIALIST";
  return process.env[`APEX_${cli}_MODEL_${role}`]?.trim() || process.env[`APEX_${cli}_MODEL`]?.trim() || undefined;
}

function modelFor(req: LlmRequest): string | undefined {
  switch (req.provider) {
    case "claude": return cliModel("CLAUDE", req.agent);
    case "codex": return cliModel("CODEX", req.agent);
    case "gemini": return process.env.APEX_GEMINI_MODEL || undefined;
    case "openai-api": return process.env.OPENAI_MODEL || "gpt-4o-mini";
    case "anthropic-api": return process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  }
  return undefined;
}

export async function runLlm(req: LlmRequest): Promise<LlmResult> {
  const started = Date.now();
  const model = modelFor(req) || "(výchozí)";
  try {
    const out = await dispatch(req);
    dbRun("INSERT INTO llm_calls (run_id, provider, agent, ms, ok, cost_usd, model) VALUES (?,?,?,?,1,?,?)",
      req.run?.id ?? null, req.provider, req.agent, Date.now() - started, out.costUsd ?? null, model);
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dbRun("INSERT INTO llm_calls (run_id, provider, agent, ms, ok, error, model) VALUES (?,?,?,?,0,?,?)",
      req.run?.id ?? null, req.provider, req.agent, Date.now() - started, msg.slice(0, 500), model);
    throw e;
  }
}

function dispatch(req: LlmRequest): Promise<LlmResult> {
  if (!detectProviders().some((p) => p.id === req.provider)) {
    return Promise.reject(new Error(`Neznámý nebo nedostupný poskytovatel: ${req.provider}`));
  }
  switch (req.provider) {
    case "claude": return runClaude(req);
    case "codex": return runCodex(req);
    case "gemini": return runGemini(req);
    case "openai-api": return runOpenAiApi(req);
    case "anthropic-api": return runAnthropicApi(req);
  }
  return Promise.reject(new Error(`Neznámý poskytovatel: ${req.provider}`));
}

function bridgeEnv(run: Run): Record<string, string> {
  return { APEX_BASE_URL: baseUrl(), APEX_TOKEN: internalToken(), APEX_RUN: run.id };
}

class CliError extends Error {}

/* Spawn a CLI in an empty temp dir (or the session's fixed cwd, which is
 * kept), feed the prompt on stdin and hand each stdout JSON line to onEvent.
 * Rejects with the most useful error it saw. */
function runCli(bin: string, args: string[], stdin: string, onEvent: (ev: any) => void, signal: AbortSignal, env: Record<string, string> = {}, timeoutMs = llmTimeoutMs(), fixedCwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Zrušeno."));
    const cwd = fixedCwd ?? mkdtempSync(join(tmpdir(), "apex-"));
    const child = spawn(bin, args, { cwd, env: childEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    let lastError = "";
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (child.exitCode !== null || hardKill) return;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(() => { lastError = "Časový limit vypršel."; kill(); }, timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    child.stdin.on("error", () => { /* CLI exited before reading stdin - close handler reports why */ });

    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        try {
          onEvent(JSON.parse(line));
        } catch (e) {
          if (e instanceof CliError) lastError = e.message;
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-4000); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`${bin}: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      signal.removeEventListener("abort", kill);
      if (!fixedCwd) rmSync(cwd, { recursive: true, force: true });
      if (signal.aborted) return reject(new Error("Zrušeno."));
      if (code === 0 && !lastError) return resolve();
      reject(new Error(lastError || summarizeStderr(err) || `${bin} skončil s kódem ${code}`));
    });
    child.stdin.end(stdin);
  });
}

function summarizeStderr(s: string): string {
  const line = s.split("\n").map((l) => l.trim()).find((l) => /error|not logged|login|auth|unsupported/i.test(l));
  return (line || s.trim().split("\n").pop() || "").slice(0, 300);
}

async function runClaude(req: LlmRequest): Promise<LlmResult> {
  const native = (req.native ?? []).filter((t) => t === "WebSearch" || t === "WebFetch");
  const args = [
    "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    // claude keys sessions by cwd: session runs always use the conversation's own dir
    ...(req.session ? [req.session.resume ? "--resume" : "--session-id", req.session.id] : ["--no-session-persistence"]),
    "--setting-sources", "", "--strict-mcp-config",
    "--system-prompt", req.system,
    "--tools", native.join(","),
  ];
  const allowed: string[] = [...native];
  let env: Record<string, string> = {};
  if (req.run) {
    const config = { mcpServers: { apex: { command: process.execPath, args: [MCP_SCRIPT], env: bridgeEnv(req.run) } } };
    args.push("--mcp-config", JSON.stringify(config));
    allowed.push("mcp__apex");
    env = { MCP_TOOL_TIMEOUT: String(llmTimeoutMs()), MCP_TIMEOUT: "30000" };
  }
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  const model = cliModel("CLAUDE", req.agent);
  if (model) args.push("--model", model);

  let text = "";
  let final = "";
  let costUsd: number | undefined;
  let contextTokens: number | undefined;
  await runCli("claude", args, req.prompt, (ev) => {
    if (ev.type === "stream_event" && ev.event?.type === "message_start" && ev.event.message?.usage) {
      // each model request re-reads the whole context: the last one is the session's size
      const u = ev.event.message.usage;
      contextTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    } else if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
      text += ev.event.delta.text;
      req.onToken?.(ev.event.delta.text);
    } else if (ev.type === "stream_event" && ev.event?.type === "content_block_start" && text && !text.endsWith("\n")) {
      // separate text blocks around tool calls so sentences don't glue together
      text += "\n";
      req.onToken?.("\n");
    } else if (ev.type === "result") {
      costUsd = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
      if (typeof ev.result === "string") final = ev.result;
      if (ev.is_error) throw new CliError(String(ev.result || (Array.isArray(ev.errors) && ev.errors.join("; ")) || "Claude vrátil chybu."));
    }
  }, req.signal, env, req.timeoutMs, req.session?.cwd);
  return { text: (final || text).trim(), costUsd, sessionId: req.session?.id, contextTokens };
}

const CODEX_DISABLED = [
  "shell_tool", "unified_exec", "browser_use", "browser_use_external", "computer_use",
  "in_app_browser", "apps", "image_generation", "multi_agent",
];

function tomlString(s: string): string {
  return JSON.stringify(s); // JSON string escaping is valid TOML basic-string escaping
}

async function runCodex(req: LlmRequest): Promise<LlmResult> {
  const s = req.session;
  // `exec resume` has no --sandbox flag (0.159): the same setting goes in via -c.
  // A first session turn simply persists (no --ephemeral); codex names the thread.
  const args = s?.resume
    ? ["exec", "resume", s.id, "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"']
    : ["exec", "--json", "--skip-git-repo-check", ...(s ? [] : ["--ephemeral"]), "--sandbox", "read-only", "-c", 'approval_policy="never"'];
  // Even a read-only sandbox lets the shell read the whole disk; Apex agents get Apex tools only.
  for (const f of CODEX_DISABLED) args.push("--disable", f);
  if (req.run) {
    const env = Object.entries(bridgeEnv(req.run)).map(([k, v]) => `${k}=${tomlString(v)}`).join(",");
    args.push(
      "-c", `mcp_servers.apex.command=${tomlString(process.execPath)}`,
      "-c", `mcp_servers.apex.args=[${tomlString(MCP_SCRIPT)}]`,
      "-c", `mcp_servers.apex.env={${env}}`,
      "-c", `mcp_servers.apex.tool_timeout_sec=${Math.round(llmTimeoutMs() / 1000)}`,
      // Apex tools are safe by construction (outbound work only proposes); without this codex exec rejects every call
      "-c", 'mcp_servers.apex.default_tools_approval_mode="approve"',
    );
  }
  if (req.native?.some((t) => t.startsWith("Web"))) args.push("-c", "tools.web_search=true");
  const model = cliModel("CODEX", req.agent);
  if (model) args.push("-m", model);
  const effort = process.env.APEX_CODEX_REASONING?.trim();
  if (effort && /^[a-z]+$/.test(effort)) args.push("-c", `model_reasoning_effort=${tomlString(effort)}`);
  args.push("-");

  const parts: string[] = [];
  let threadId: string | undefined;
  let contextTokens: number | undefined;
  await runCli("codex", args, `<system>\n${req.system}\n</system>\n\n${req.prompt}`, (ev) => {
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
      threadId = ev.thread_id;
    } else if (ev.type === "turn.completed" && typeof ev.usage?.input_tokens === "number") {
      // summed over the turn's requests - an upper bound, so the session rotates a bit early
      contextTokens = ev.usage.input_tokens;
    } else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
      const t = (parts.length ? "\n" : "") + ev.item.text;
      parts.push(ev.item.text);
      req.onToken?.(t);
    } else if (ev.type === "error" || ev.type === "turn.failed") {
      throw new CliError(String(ev.message || ev.error?.message || "Codex vrátil chybu."));
    }
  }, req.signal, {}, req.timeoutMs, s?.cwd);
  return { text: parts.join("\n").trim(), sessionId: s ? threadId ?? (s.resume ? s.id : undefined) : undefined, contextTokens };
}

async function runGemini(req: LlmRequest): Promise<LlmResult> {
  const args = ["-p", "", "-o", "stream-json", "--approval-mode", "plan", "--skip-trust", "-e", "none"];
  if (process.env.APEX_GEMINI_MODEL) args.push("-m", process.env.APEX_GEMINI_MODEL);
  let text = "";
  await runCli("gemini", args, `${req.system}\n\n${req.prompt}`, (ev) => {
    if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
      text += ev.content;
      req.onToken?.(ev.content);
    } else if (ev.type === "error") throw new CliError(String(ev.message || "Gemini vrátil chybu."));
  }, req.signal, {}, req.timeoutMs);
  return { text: text.trim() };
}

async function readSse(res: Response, onData: (data: string) => void) {
  if (!res.ok || !res.body) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  }
}

async function runOpenAiApi(req: LlmRequest): Promise<LlmResult> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: req.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: modelFor(req),
      stream: true,
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }],
    }),
  });
  let text = "";
  await readSse(res, (d) => {
    if (d === "[DONE]") return;
    const t = JSON.parse(d).choices?.[0]?.delta?.content;
    if (t) { text += t; req.onToken?.(t); }
  });
  return { text: text.trim() };
}

async function runAnthropicApi(req: LlmRequest): Promise<LlmResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: req.signal,
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: modelFor(req),
      max_tokens: 2048,
      stream: true,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    }),
  });
  let text = "";
  await readSse(res, (d) => {
    const ev = JSON.parse(d);
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { text += ev.delta.text; req.onToken?.(ev.delta.text); }
    else if (ev.type === "error") throw new Error(ev.error?.message || "Anthropic API chyba");
  });
  return { text: text.trim() };
}
