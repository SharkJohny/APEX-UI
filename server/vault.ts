import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

/* The owner's Obsidian vault ("AI Mozek", LLM-Wiki method) is Apex's long-term
 * brain. Layout and rules live in the vault's own SCHEMA.md:
 *   00-raw/  immutable sources (Apex never writes here)
 *   10-…99-  wiki pages maintained by AI
 *   80-me/   persona layer - read before any work
 *   index.md catalogue, log.md append-only journal
 * Configure with APEX_VAULT_DIR (defaults to ~/ai-mozek when it exists). */

const SKIP_DIRS = new Set([".git", ".obsidian", ".claude", ".trash", ".omc", "node_modules", "venv", ".venv", "99-assets"]);
const TEXT_EXT = /\.(md|markdown|txt)$/i;

export function vaultDir(): string | null {
  const dir = process.env.APEX_VAULT_DIR || join(homedir(), "ai-mozek");
  try {
    return existsSync(join(dir, "SCHEMA.md")) || existsSync(join(dir, ".obsidian")) ? realpathSync(dir) : null;
  } catch {
    return null;
  }
}

export type VaultFile = { path: string; mtimeMs: number; size: number };

/* Every text note in the vault (relative POSIX paths), skipping tool/config dirs. */
export function walkVault(): VaultFile[] {
  const root = vaultDir();
  if (!root) return [];
  const out: VaultFile[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (e.isFile() && TEXT_EXT.test(e.name)) {
        const full = join(dir, e.name);
        const st = statSync(full);
        out.push({ path: relative(root, full).split(sep).join("/"), mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(root);
  return out;
}

/* Resolve a vault-relative path safely: no absolute paths, no "..", no
 * symlink escape, no tool/config dirs. Returns the absolute path. */
export function resolveVaultPath(rel: string): string {
  const root = vaultDir();
  if (!root) throw new Error("Vault není nastavený (APEX_VAULT_DIR).");
  const clean = normalize(rel.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!clean || isAbsolute(rel) || clean.split("/").some((p) => p === ".." || SKIP_DIRS.has(p) || p.startsWith("."))) {
    throw new Error(`Neplatná cesta ve vaultu: ${rel}`);
  }
  const full = join(root, clean);
  if (existsSync(full)) {
    const real = realpathSync(full);
    if (real !== root && !real.startsWith(root + sep)) throw new Error(`Cesta míří mimo vault: ${rel}`);
  }
  return full;
}

export function readVaultText(rel: string, maxChars = 200_000): string {
  const full = resolveVaultPath(rel);
  return readFileSync(full, "utf8").slice(0, maxChars);
}

/* Paths Apex may never modify. */
export function isProtectedPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  return p.startsWith("00-raw/") || p === "SCHEMA.md" || p === "CLAUDE.md" || p === "AGENTS.md" || p === "README.md"
    || p === "80-me/profil.md" || p === "80-me/preference.md";
}

const PERSONA_FILES = ["80-me/profil.md", "80-me/preference.md", "80-me/feedback.md", "80-me/vzorce.md"];
const PERSONA_BUDGET = 12_000;

/* The persona layer every agent reads first (SCHEMA §14.1), trimmed to a budget. */
export function vaultPersona(budget = PERSONA_BUDGET): string {
  if (!vaultDir()) return "";
  const parts: string[] = [];
  let used = 0;
  for (const f of PERSONA_FILES) {
    try {
      const body = readVaultText(f).replace(/^---[\s\S]*?---\n/, "").trim();
      const room = budget - used;
      if (room <= 200) break;
      const text = body.length > room ? body.slice(0, room) + "\n…" : body;
      parts.push(`### ${f}\n${text}`);
      used += text.length;
    } catch { /* missing file - skip */ }
  }
  return parts.join("\n\n");
}

export function vaultStatus(): { configured: boolean; path?: string; notes?: number } {
  const root = vaultDir();
  if (!root) return { configured: false };
  return { configured: true, path: root, notes: walkVault().length };
}
