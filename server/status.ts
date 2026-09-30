import { spawnSync } from "node:child_process";
import { all, get } from "./db";
import { AGENTS } from "./agents";
import { detectProviders } from "./llm";
import { googleStatus } from "./integrations/google";
import { socialStatus } from "./integrations/social";
import { raqetoStatus } from "./integrations/raqeto";
import { semanticStatus } from "./semantic";
import { vaultStatus } from "./vault";
import { ROSTER, type AgentKey, type AgentStatus } from "@/lib/roster";

/* Real per-agent status for the UI. No fake green lights: an agent is
 * 'online' only when what it needs (a tool-capable model, a connected
 * account, a git repo) is actually there right now. */

export type AgentState = { status: AgentStatus; note: string; jobs7d: number; lastJobAt: string | null };

const g = globalThis as { __apexGitRepo?: boolean };
function gitRepo(): boolean {
  if (g.__apexGitRepo === undefined) {
    const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: process.cwd(), encoding: "utf8" });
    g.__apexGitRepo = r.status === 0 && r.stdout.trim() === "true";
  }
  return g.__apexGitRepo;
}

export function apexStatus() {
  const providers = detectProviders();
  const google = googleStatus();
  const social = socialStatus();
  const model = providers.some((p) => p.tools);
  const anySocial = social.facebook.configured || social.instagram.configured || social.linkedin.configured;
  const vault = vaultStatus();
  const raqeto = raqetoStatus();
  let semantic: Partial<ReturnType<typeof semanticStatus>> & { ready: boolean };
  try { semantic = semanticStatus(); } catch (e) { semantic = { ready: false, error: e instanceof Error ? e.message : String(e) }; }
  const semNote = semantic.ready ? "připraveno"
    : semantic.error && !semantic.indexing ? "chyba"
    : `indexuji ${semantic.indexed?.vault ?? 0}/${vault.notes ?? 0}`;
  const memoryNote = vault.configured
    ? `Paměť + vault AI Mozek (${vault.notes ?? 0} poznámek), sémantické hledání: ${semNote}`
    : "Lokální databáze (vault AI Mozek nenalezen – APEX_VAULT_DIR)";

  const counts = new Map(
    all<{ agent: string; jobs7d: number; last: string | null }>(
      `SELECT agent, SUM(created_at >= datetime('now', '-7 days')) AS jobs7d, MAX(created_at) AS last FROM jobs GROUP BY agent`,
    ).map((r) => [r.agent, r]),
  );

  const NO_MODEL = "Chybí Claude/Codex CLI";
  const decide = (key: AgentKey): { status: AgentStatus; note: string } => {
    switch (key) {
      case "email":
      case "calendar":
      case "drive":
        return google.connected
          ? { status: "online", note: `Google připojen${google.account ? ` (${google.account})` : ""}` }
          : { status: "integration", note: "Nepřipojeno – Deck › Integrace" };
      case "memory":
        return { status: "online", note: memoryNote };
      case "crm":
        if (!raqeto.configured) return { status: "integration", note: "Nastav RAQETO_API_TOKEN v .env.local" };
        return raqeto.ok === false
          ? { status: "online", note: `Raqeto CRM – poslední dotaz selhal${raqeto.error ? `: ${raqeto.error}` : ""}` }
          : { status: "online", note: "Raqeto CRM" };
      case "analytics":
        return { status: "online", note: "Lokální databáze" };
      case "social_media":
        if (!model) return { status: "offline", note: NO_MODEL };
        return anySocial
          ? { status: "online", note: "Texty i publikace (po schválení)" }
          : { status: "standby", note: "Texty ano, publikace po nastavení účtů" };
      case "developer":
        if (!model) return { status: "offline", note: NO_MODEL };
        return gitRepo() ? { status: "online", note: "Git repozitář nalezen" } : { status: "offline", note: "Nenalezen git repozitář" };
      default:
        if (!AGENTS[key]) return { status: "offline", note: "Agent není definován" };
        return model ? { status: "online", note: "Připraven" } : { status: "offline", note: NO_MODEL };
    }
  };

  const agents = Object.fromEntries(
    ROSTER.map((r) => {
      const c = counts.get(r.key);
      const s: AgentState = { ...decide(r.key), jobs7d: Number(c?.jobs7d ?? 0), lastJobAt: c?.last ?? null };
      return [r.key, s];
    }),
  ) as Record<AgentKey, AgentState>;

  return {
    agents,
    providers,
    google,
    social,
    vault,
    semantic,
    raqeto,
    tts: process.env.OPENAI_API_KEY ? "openai" : "browser",
    pendingActions: get<{ n: number }>("SELECT COUNT(*) AS n FROM actions WHERE status = 'pending'")?.n ?? 0,
  };
}
