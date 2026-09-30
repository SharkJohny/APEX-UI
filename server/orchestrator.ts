import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { all, DATA_DIR, get, run as dbRun } from "./db";
import { endRun, getRun, startRun, type ApexEvent, type Run } from "./events";
import { AGENTS, systemPrompt } from "./agents";
import { isSessionLost, llmTimeoutMs, providerSupportsTools, runLlm, type LlmResult } from "./llm";
import { semanticSearch, semanticStatus } from "./semantic";
import { untrusted } from "./tools/registry";
import { vaultDir, vaultPersona } from "./vault";
import { ROSTER_BY_KEY, type AgentKey } from "@/lib/roster";

/* The turn loop. The user always talks to the Chief of staff; it can delegate
 * to specialists (delegate_to_<agent> tool → runSpecialist). Memory and the
 * owner's guide are injected into every turn so context is never forgotten. */

export type ChatMessage = { role: "user" | "assistant"; content: string };

const HISTORY_TURNS = 12;


/* Each run owns an AbortController that follows its parent's signal. When a
 * run ends - normally, by error or timeout - it aborts, so every specialist it
 * delegated to (and their CLI processes) stops with it. */
function linkedController(parent: AbortSignal): AbortController {
  const ctl = new AbortController();
  if (parent.aborted) ctl.abort();
  else parent.addEventListener("abort", () => ctl.abort(), { once: true });
  return ctl;
}

/* Parallel delegations: show "reasoning" while any specialist of a run works. */
const gBusy = globalThis as { __apexBusy?: Map<string, number> };
const busy = (gBusy.__apexBusy ??= new Map());

export function latestGuide(): string {
  return get<{ body: string }>("SELECT body FROM guide_versions ORDER BY id DESC LIMIT 1")?.body ?? "";
}

/* FTS query from free text: words ≥ 3 chars, OR-ed, prefix-matched. */
export function ftsQuery(text: string): string {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 12);
  return [...new Set(words)].map((w) => `"${w}"*`).join(" OR ");
}

export function relevantMemory(text: string, limit = 8): string[] {
  const q = ftsQuery(text);
  if (!q) return [];
  try {
    return all<{ subject: string; fact: string; source: string }>(
      `SELECT m.subject, m.fact, m.source FROM memory_fts f JOIN memory_facts m ON m.id = f.rowid
       WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`, q, limit,
    ).map((r) => {
      const line = r.subject ? `${r.subject}: ${r.fact}` : r.fact;
      return r.source.startsWith("untrusted:") ? untrusted("memory", line) : line;
    });
  } catch {
    return [];
  }
}

const VAULT_RULES = `Znalostní báze majitele "AI Mozek" (Obsidian, metoda LLM Wiki) je tvoje dlouhodobá paměť:
- Hledej v ní nástrojem vault_search (hledá podle významu), čti vault_read; katalog je vault_index, deník vault_log. Fakta cituj jako [[název-stránky]].
- Klienti, projekty, úkoly, hodiny a faktury: zdrojem pravdy je Raqeto CRM (nástroje raqeto_*); vault drží kontext, shrnutí hovorů, know-how a poptávky.
- Do vaultu zapisuješ jen návrhem propose_vault_write podle pravidel SCHEMA.md (shrnutí → aktualizace entit → index → záznam do logu); 00-raw a "ústavu" (SCHEMA, 80-me/profil, 80-me/preference) nikdy neměníš. Nic nepřidávej "z hlavy" – vše musí mít zdroj.`;

function contextBlocks(query: string): string[] {
  const guide = latestGuide();
  const memory = relevantMemory(query);
  const persona = vaultDir() ? vaultPersona() : "";
  return [
    persona && `Kdo je majitel a jak s ním pracovat (vrstva 80-me z jeho vaultu – ber jako závazné):\n${persona}`,
    persona && VAULT_RULES,
    guide && `Pokyny majitele (průvodce Apexem – řiď se jimi):\n${guide}`,
    memory.length ? `Z paměti (může souviset s dotazem):\n- ${memory.join("\n- ")}` : "",
  ].filter(Boolean) as string[];
}

/* Chief-only context: the live approval queue on every turn (so a stale
 * memory of a proposal gets corrected) and, when a conversation starts,
 * where the previous conversations left off plus past messages relevant to
 * the new one. Resumed sessions already hold their own conversation. */
const PAST_BLOCK_MAX = 3500;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function pendingBlock(): string {
  const rows = all<{ id: number; kind: string; summary: string }>(
    "SELECT id, kind, summary FROM actions WHERE status = 'pending' ORDER BY id DESC LIMIT 10",
  );
  const list = rows.length ? rows.map((a) => `- #${a.id} ${a.kind} – ${clip(a.summary, 160)}`).join("\n") : "- nic nečeká";
  return `Čeká na schválení majitele (stav k tomuto tahu – platí víc než cokoli z dřívějška):\n${list}
Schvaluje jen majitel tlačítkem v chatu nebo v panelu Deck; ty návrhy nikdy neschvaluješ. Podrobnosti a vyřízené návrhy: actions_list.
Starší historii rozhovorů zjistíš nástroji conversations_recent, conversation_read a memory_search_conversations – použij je dřív, než řekneš, že něco nevíš nebo si to nepamatuješ.`;
}

export async function pastBlock(query: string, conversationId: string): Promise<string> {
  const lines: string[] = [];
  const prev = all<{ conversation_id: string; last: string }>(
    `SELECT conversation_id, MAX(created_at) AS last FROM messages WHERE conversation_id != ?
     GROUP BY conversation_id ORDER BY MAX(id) DESC LIMIT 2`, conversationId,
  );
  for (const c of prev) {
    const tail = all<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 4", c.conversation_id,
    ).reverse();
    lines.push(`Rozhovor ${c.conversation_id} (naposledy ${c.last} UTC):\n${tail.map((m) => `${m.role === "user" ? "Majitel" : "Apex"}: ${clip(m.content, 350)}`).join("\n")}`);
  }
  if (semanticStatus().ready) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hits = await Promise.race([
        semanticSearch(query, { sources: ["messages"], limit: 6 }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 4000); }),
      ]);
      const own = `${conversationId}:`;
      const relevant = hits.filter((h) => !h.ref.startsWith(own)).slice(0, 3);
      if (relevant.length) lines.push(`Související místa z dřívějška:\n${relevant.map((h) => `[${h.ref.slice(0, h.ref.lastIndexOf(":"))}] ${clip(h.text, 400)}`).join("\n")}`);
    } catch { /* semantic index unavailable - the recent conversations still help */ } finally {
      clearTimeout(timer);
    }
  }
  if (!lines.length) return "";
  const head = "Z minulých rozhovorů (nová konverzace – takhle skončily ty předchozí; více přes conversation_read):\n";
  let body = lines.join("\n\n");
  const budget = PAST_BLOCK_MAX - head.length - 60;
  if (body.length > budget) body = `${body.slice(0, budget)}…`;
  return head + untrusted("minule-rozhovory", body);
}

/* Per-turn refresh for a resumed codex thread: time and memory relevant to the
 * new message (persona, rules and guide are already in the thread). */
function turnUpdate(query: string): string {
  const memory = relevantMemory(query);
  return [
    `Aktuální datum a čas: ${new Date().toLocaleString("cs-CZ", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}.`,
    memory.length ? `Z paměti (může souviset s dotazem):\n- ${memory.join("\n- ")}` : "",
    "Pravidla a persona z začátku konverzace stále platí.",
  ].filter(Boolean).join("\n\n");
}

function transcript(messages: ChatMessage[]): string {
  const recent = messages.slice(-HISTORY_TURNS);
  if (recent.length === 1) return recent[0].content;
  const lines = recent.slice(0, -1).map((m) => `${m.role === "user" ? "Uživatel" : "Apex"}: ${m.content}`);
  return `Dosavadní konverzace:\n${lines.join("\n")}\n\nNová zpráva uživatele: ${recent[recent.length - 1].content}`;
}

/* Short-term memory: chief-of-staff chat turns on claude/codex continue the
 * CLI's own session for the conversation (resumed turns send only the new
 * message). Each conversation gets a private cwd - claude keys sessions by
 * cwd. Specialists, loops and queue runs stay ephemeral. */
const SESSION_PROVIDERS = new Set(["claude", "codex"]);
export const SESSIONS_DIR = join(DATA_DIR, "sessions");

type ConversationRow = { id: string; provider: string; session_id: string; cwd: string };

function sessionCwd(conversationId: string): string | undefined {
  // the id comes from the browser - it becomes a directory name
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(conversationId)) return undefined;
  const dir = join(SESSIONS_DIR, conversationId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(SESSIONS_DIR, 0o700);
  chmodSync(dir, 0o700);
  return dir;
}

/* ── the user's turn ── */
export async function runTurn(opts: {
  provider: string;
  messages: ChatMessage[];
  conversationId?: string;
  emit: (ev: ApexEvent) => void;
  signal: AbortSignal;
}): Promise<void> {
  const conversationId = opts.conversationId || randomUUID();
  const last = opts.messages[opts.messages.length - 1];
  const fresh = !get("SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1", conversationId);
  dbRun("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)", conversationId, "user", last.content);

  const tools = providerSupportsTools(opts.provider);
  if (!tools) opts.emit({ t: "info", v: "Tento poskytovatel neumí nástroje – agenti, CRM a integrace jsou dostupné jen s Claude nebo ChatGPT/Codex." });

  const ctl = linkedController(opts.signal);
  const run = startRun({ agent: "chief_of_staff", depth: 0, provider: opts.provider, source: "chat", emit: opts.emit, signal: ctl.signal });
  opts.emit({ t: "state", v: "thinking" });
  try {
    const cwd = SESSION_PROVIDERS.has(opts.provider) ? sessionCwd(conversationId) : undefined;
    const stored = cwd ? get<ConversationRow>("SELECT * FROM conversations WHERE id = ?", conversationId) : undefined;
    const resumable = stored?.provider === opts.provider && stored.session_id ? stored : undefined;
    const pending = pendingBlock();
    const past = fresh && !resumable ? await pastBlock(last.content, conversationId) : "";
    const system = systemPrompt("chief_of_staff", [...contextBlocks(last.content), pending, past]);
    const call = (resume: ConversationRow | undefined) => runLlm({
      provider: opts.provider,
      agent: "chief_of_staff",
      // codex has no system-prompt flag, so its prompt carries the system text inline;
      // a resumed thread already holds persona + rules - send only what changes per turn
      system: resume && opts.provider === "codex" ? `${turnUpdate(last.content)}\n\n${pending}` : system,
      prompt: resume ? last.content : transcript(opts.messages),
      run: tools ? run : undefined,
      onToken: (v) => opts.emit({ t: "token", v }),
      signal: ctl.signal,
      timeoutMs: llmTimeoutMs(),
      // claude takes our id for a new session; codex names its own thread
      session: cwd ? { id: resume?.session_id ?? randomUUID(), resume: !!resume, cwd } : undefined,
    });
    let out: LlmResult;
    try {
      out = await call(resumable);
    } catch (e) {
      // a vanished/corrupt session: start over once with the transcript (never after abort/timeout)
      if (!resumable || ctl.signal.aborted || !isSessionLost(e)) throw e;
      out = await call(undefined);
    }
    if (cwd && out.sessionId) {
      dbRun(`INSERT INTO conversations (id, provider, session_id, cwd) VALUES (?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, session_id = excluded.session_id,
               cwd = excluded.cwd, updated_at = datetime('now')`,
        conversationId, opts.provider, out.sessionId, cwd);
    }
    if (out.text) dbRun("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)", conversationId, "assistant", out.text);
    opts.emit({ t: "done", conversationId });
  } finally {
    ctl.abort();
    endRun(run.id);
    busy.delete(run.id);
  }
}

/* ── a specialist's job (from delegation or a loop) ── */
export async function runSpecialist(opts: {
  agent: AgentKey;
  task: string;
  provider: string;
  parent?: Run;
  source?: string;
  signal: AbortSignal;
  emit?: (ev: ApexEvent) => void;
}): Promise<{ jobId: number; text: string }> {
  opts.signal.throwIfAborted();
  const emit = opts.emit ?? opts.parent?.emit ?? (() => {});
  const def = AGENTS[opts.agent];
  if (!def) throw new Error(`Agent ${opts.agent} neexistuje.`);
  const ctl = linkedController(opts.signal);
  const depth = (opts.parent?.depth ?? -1) + 1;
  const run = startRun({
    agent: opts.agent,
    depth,
    provider: opts.provider,
    parentId: opts.parent?.id,
    source: opts.parent?.source ?? opts.source ?? "chat",
    // loops read mail / web on their own and Raqeto queue tasks carry client
    // text - no human typed the request, so treat them as tainted from the start
    tainted: opts.parent?.tainted || /^(loop|raqeto):/.test(opts.source ?? ""),
    emit,
    signal: ctl.signal,
  });
  const jobId = Number(dbRun(
    "INSERT INTO jobs (run_id, parent_run_id, agent, input, source) VALUES (?,?,?,?,?)",
    run.id, opts.parent?.id ?? null, opts.agent, opts.task, opts.source ?? "chat",
  ).lastInsertRowid);
  emit({ t: "job", id: jobId, agent: opts.agent, status: "running", summary: opts.task.slice(0, 140) });
  if (opts.parent) {
    busy.set(opts.parent.id, (busy.get(opts.parent.id) ?? 0) + 1);
    emit({ t: "state", v: "reasoning" });
  }
  try {
    const tools = providerSupportsTools(opts.provider);
    const out = await runLlm({
      provider: opts.provider,
      agent: opts.agent,
      system: systemPrompt(opts.agent, [
        ...contextBlocks(opts.task),
        run.depth > 0
          ? "Pracuješ na zadání od Chief of staffa. Tvůj výstup čte on, ne uživatel – může být podrobnější a strukturovaný (prostý text)."
          : "Pracuješ samostatně (naplánovaná úloha). Výstup si uživatel přečte v přehledu úloh.",
      ]),
      prompt: opts.task,
      run: tools ? run : undefined,
      native: def.native,
      signal: ctl.signal,
      // a delegated job must finish well inside its parent's budget
      timeoutMs: depth > 0 ? Math.round(llmTimeoutMs() * 0.75) : llmTimeoutMs(),
    });
    dbRun("UPDATE jobs SET output = ?, status = 'done', finished_at = datetime('now') WHERE id = ?", out.text, jobId);
    emit({ t: "job", id: jobId, agent: opts.agent, status: "done", summary: out.text.slice(0, 140) });
    return { jobId, text: out.text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dbRun("UPDATE jobs SET output = ?, status = 'failed', finished_at = datetime('now') WHERE id = ?", msg, jobId);
    emit({ t: "job", id: jobId, agent: opts.agent, status: "failed", summary: msg.slice(0, 140) });
    throw e;
  } finally {
    ctl.abort();
    endRun(run.id);
    if (opts.parent) {
      const left = (busy.get(opts.parent.id) ?? 1) - 1;
      if (left > 0) busy.set(opts.parent.id, left);
      else {
        busy.delete(opts.parent.id);
        if (getRun(opts.parent.id)) emit({ t: "state", v: "thinking" });
      }
    }
  }
}

export function agentName(key: string): string {
  return ROSTER_BY_KEY[key]?.name ?? key;
}
