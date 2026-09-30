import { randomUUID } from "node:crypto";
import { all, get, run as dbRun } from "./db";
import { endRun, getRun, startRun, type ApexEvent, type Run } from "./events";
import { AGENTS, systemPrompt } from "./agents";
import { providerSupportsTools, runLlm } from "./llm";
import { untrusted } from "./tools/registry";
import { vaultDir, vaultPersona } from "./vault";
import { ROSTER_BY_KEY, type AgentKey } from "@/lib/roster";

/* The turn loop. The user always talks to the Chief of staff; it can delegate
 * to specialists (delegate_to_<agent> tool → runSpecialist). Memory and the
 * owner's guide are injected into every turn so context is never forgotten. */

export type ChatMessage = { role: "user" | "assistant"; content: string };

const HISTORY_TURNS = 12;
const TIMEOUT_MS = Number(process.env.APEX_LLM_TIMEOUT_MS || 600_000);

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

function transcript(messages: ChatMessage[]): string {
  const recent = messages.slice(-HISTORY_TURNS);
  if (recent.length === 1) return recent[0].content;
  const lines = recent.slice(0, -1).map((m) => `${m.role === "user" ? "Uživatel" : "Apex"}: ${m.content}`);
  return `Dosavadní konverzace:\n${lines.join("\n")}\n\nNová zpráva uživatele: ${recent[recent.length - 1].content}`;
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
  dbRun("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)", conversationId, "user", last.content);

  const tools = providerSupportsTools(opts.provider);
  if (!tools) opts.emit({ t: "info", v: "Tento poskytovatel neumí nástroje – agenti, CRM a integrace jsou dostupné jen s Claude nebo ChatGPT/Codex." });

  const ctl = linkedController(opts.signal);
  const run = startRun({ agent: "chief_of_staff", depth: 0, provider: opts.provider, source: "chat", emit: opts.emit, signal: ctl.signal });
  opts.emit({ t: "state", v: "thinking" });
  try {
    const system = systemPrompt("chief_of_staff", contextBlocks(last.content));
    const out = await runLlm({
      provider: opts.provider,
      agent: "chief_of_staff",
      system,
      prompt: transcript(opts.messages),
      run: tools ? run : undefined,
      onToken: (v) => opts.emit({ t: "token", v }),
      signal: ctl.signal,
      timeoutMs: TIMEOUT_MS,
    });
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
    // a loop reads mail / web on its own - treat it as tainted from the start
    tainted: opts.parent?.tainted || (opts.source ?? "").startsWith("loop:"),
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
      timeoutMs: depth > 0 ? Math.round(TIMEOUT_MS * 0.75) : TIMEOUT_MS,
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
