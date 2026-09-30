import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isProtectedPath, resolveVaultPath, vaultDir } from "./vault";

/* Writes into the owner's vault ("AI Mozek"). Apex never writes directly: an
 * agent proposes a vault_write action (see server/tools/vault.ts), the owner
 * sees the exact unified diff in the Deck and approves it, and only then this
 * module writes. Rules come from the vault's SCHEMA.md: 00-raw and the persona
 * constitution are immutable, log.md is append-only in the §7 format, no
 * secrets (§9), new pages are kebab-case without diacritics (§3.2).
 * Pure helpers first (diff, validation, log format), IO at the bottom. */

export type VaultWriteMode = "create" | "replace" | "append" | "patch";
export type VaultFileOp = { path: string; mode: VaultWriteMode; content?: string; find?: string; replace?: string; base_hash?: string };
export type VaultLogEntry = { type: "ingest" | "query" | "edit" | "task" | "lint"; title: string; body?: string };
export type VaultPreview = { path: string; mode: string; diff: string };
export type VaultWriteInput = { reason: string; files: VaultFileOp[]; log_entry?: VaultLogEntry; preview?: VaultPreview[] };

export const LOG_PATH = "log.md";
export const DIFF_CAP = 6000;
const MAX_FILES = 12;
const MAX_CONTENT = 200_000;
const CONTEXT = 3;
/* Top-level wiki folders a new page may live in: 10-… to 90-… (not 00-raw, not 99-assets). */
const WIKI_TOP = /^(?:[1-8]\d|90)-[a-z0-9-]+$/;
const NEW_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
/* Persona notes whose old entries must never change (SCHEMA §14.2): append only. */
const APPEND_ONLY_PREFIX = "80-me/";

export function hashText(text: string | null): string {
  return text === null ? "absent" : createHash("sha256").update(text).digest("hex");
}

export function normVaultPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

/* Local calendar date in Prague, YYYY-MM-DD (SCHEMA §7 log dates). */
export function pragueDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/* ───────────── secrets (SCHEMA §9) ───────────── */

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "privátní klíč"], // detector pattern, not a secret: claude-leverage-allow-secret
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/, "API klíč sk-…"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS klíč"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "Google API klíč"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, "JWT token"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, "Bearer token"],
  [/[?&](?:token|key|api_key|apikey|access_token|secret|password)=[^&\s]{8,}/i, "token v URL"],
  [/\b(?:password|passwd|pwd|heslo|secret|api[_-]?key|access[_-]?token|token)\s*[:=]\s*(?!viz\b|v\s|see\b|\[\[|<|\()["'`]?[^\s"'`]{4,}/i, "heslo nebo klíč"],
];

/* Returns what kind of secret the text seems to contain, or null. */
export function findSecret(text: string): string | null {
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) return label;
  // long opaque strings - ignore URLs and wiki links (Drive/Figma ids are long too)
  const bare = text.replace(/https?:\/\/\S+/g, " ").replace(/\[\[[^\]]*\]\]/g, " ");
  if (/\b[a-f0-9]{32,}\b/i.test(bare)) return "dlouhý hex klíč";
  for (const m of bare.match(/[A-Za-z0-9+/_-]{40,}={0,2}/g) ?? []) {
    if (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m)) return "dlouhý base64 klíč";
  }
  return null;
}

/* ───────────── validation ───────────── */

const plural = (n: number) => (n === 1 ? "soubor" : n < 5 ? "soubory" : "souborů");

/* Checks that need no disk access. Throws a readable Czech error. */
export function validateStatic(input: VaultWriteInput): void {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) throw new Error("Chybí důvod zápisu (reason) – jedna česká věta.");
  if (/[\r\n]/.test(reason)) throw new Error("Důvod zápisu (reason) musí být na jeden řádek.");
  if (!input.files?.length) throw new Error("Návrh neobsahuje žádný soubor.");
  if (input.files.length > MAX_FILES) throw new Error(`Najednou jde zapsat nejvýš ${MAX_FILES} souborů.`);
  const seen = new Set<string>();
  for (const f of input.files) {
    const path = normVaultPath(f.path);
    if (seen.has(path)) throw new Error(`Soubor ${path} je v návrhu dvakrát – slouč změny do jedné položky.`);
    seen.add(path);
    if (!path.toLowerCase().endsWith(".md")) throw new Error(`${path}: do vaultu Apex zapisuje jen .md soubory.`);
    if (path.split("/").some((s) => s === ".." || s === "." || s.startsWith("."))) throw new Error(`${path}: neplatná cesta.`);
    if (isProtectedPath(path)) {
      throw new Error(`${path} je chráněný soubor (00-raw/ je neměnný, SCHEMA.md a 80-me/profil|preference jsou ústava vaultu) – Apex ho nesmí měnit.`);
    }
    if (path === LOG_PATH) throw new Error("Do log.md se zapisuje jen přes log_entry (append-only, SCHEMA §7), ne přes files.");
    if (path.startsWith(APPEND_ONLY_PREFIX) && f.mode !== "append" && f.mode !== "create") {
      throw new Error(`${path}: v 80-me/ se staré záznamy nemění (SCHEMA §14.2) – použij mode "append".`);
    }
    if ((f.mode === "create" || f.mode === "replace" || f.mode === "append") && !f.content?.trim()) {
      throw new Error(`${path}: mode "${f.mode}" potřebuje neprázdný content.`);
    }
    if (f.mode === "patch" && !f.find) throw new Error(`${path}: patch potřebuje přesný text ve "find".`);
    for (const t of [f.content, f.replace]) {
      if (t && t.length > MAX_CONTENT) throw new Error(`${path}: obsah je příliš dlouhý (max ${MAX_CONTENT} znaků).`);
      const secret = t ? findSecret(t) : null;
      if (secret) {
        throw new Error(`${path}: obsah vypadá, že obsahuje tajemství (${secret}). Podle SCHEMA §9 do vaultu nepatří hesla ani tokeny – zapiš jen odkaz, kde je najít (např. „token v .env u projektu X“).`);
      }
    }
  }
  if (input.log_entry) {
    if (/[\r\n]/.test(input.log_entry.title)) throw new Error("Nadpis záznamu do log.md musí být na jeden řádek.");
    const secret = findSecret(`${input.log_entry.title}\n${input.log_entry.body ?? ""}`);
    if (secret) throw new Error(`Záznam do log.md vypadá, že obsahuje tajemství (${secret}) – SCHEMA §9.`);
  }
  const reasonSecret = findSecret(reason);
  if (reasonSecret) throw new Error(`Důvod zápisu vypadá, že obsahuje tajemství (${reasonSecret}).`);
}

/* Shape rules for a page that does not exist yet (SCHEMA §2, §3.2). */
export function checkNewPath(path: string, topFolderExists: (top: string) => boolean): void {
  const parts = path.split("/");
  if (parts.length < 2 || !WIKI_TOP.test(parts[0])) {
    throw new Error(`${path}: nová stránka musí být ve složce wiki 10-… až 90-… (např. 40-komunikace/…).`);
  }
  if (!topFolderExists(parts[0])) throw new Error(`${path}: složka ${parts[0]}/ ve vaultu neexistuje.`);
  for (const s of parts) {
    if (!NEW_SEGMENT.test(s)) {
      throw new Error(`${path}: název „${s}“ musí být kebab-case bez diakritiky a mezer (SCHEMA §3.2), např. meet-2026-04-20-klient-tema.md.`);
    }
  }
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

const withNl = (s: string) => (s.endsWith("\n") ? s : s + "\n");

/* New content of one file. `current` is null when the file does not exist. */
export function applyFileOp(current: string | null, op: VaultFileOp): string {
  const path = normVaultPath(op.path);
  switch (op.mode) {
    case "create":
      if (current !== null) throw new Error(`${path} už existuje – použij replace, append nebo patch.`);
      return withNl(op.content ?? "");
    case "replace":
      if (current === null) throw new Error(`${path} neexistuje – pro novou stránku použij create.`);
      return withNl(op.content ?? "");
    case "append":
      if (current === null) throw new Error(`${path} neexistuje – pro novou stránku použij create.`);
      return (current === "" ? "" : withNl(current)) + withNl(op.content ?? "");
    case "patch": {
      if (current === null) throw new Error(`${path} neexistuje – patch jde jen na existující stránku.`);
      const find = op.find ?? "";
      const n = countOccurrences(current, find);
      if (n !== 1) {
        throw new Error(n === 0
          ? `${path}: text z "find" se v souboru nenašel – přečti stránku znovu (vault_read) a zkopíruj ho přesně.`
          : `${path}: text z "find" je v souboru ${n}× – vyber delší, jednoznačný úsek.`);
      }
      const i = current.indexOf(find);
      return current.slice(0, i) + (op.replace ?? "") + current.slice(i + find.length);
    }
  }
}

/* ───────────── log.md (SCHEMA §7) ───────────── */

export function formatLogEntry(entry: VaultLogEntry, date: string): string {
  const title = entry.title.replace(/\s+/g, " ").trim().slice(0, 160);
  const body = (entry.body ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1200);
  return `## [${date}] ${entry.type} | ${title}${body ? `\n${body}` : ""}`;
}

/* Append one entry, separated from the previous one by a blank line. */
export function appendLogEntry(current: string, entry: string): string {
  if (!current.trim()) return entry + "\n";
  return current.replace(/\n*$/, "\n") + "\n" + entry + "\n";
}

/* ───────────── unified diff ───────────── */

type Op = { t: " " | "-" | "+"; line: string };
const LCS_LIMIT = 4_000_000;

function lineOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const mid: Op[] = [];
  const n = am.length, m = bm.length;
  if (n * m > LCS_LIMIT) {
    for (const l of am) mid.push({ t: "-", line: l });
    for (const l of bm) mid.push({ t: "+", line: l });
  } else {
    // suffix LCS table, then a greedy walk
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { mid.push({ t: " ", line: am[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) mid.push({ t: "-", line: am[i++] });
      else mid.push({ t: "+", line: bm[j++] });
    }
    while (i < n) mid.push({ t: "-", line: am[i++] });
    while (j < m) mid.push({ t: "+", line: bm[j++] });
  }
  return [
    ...a.slice(0, pre).map((line): Op => ({ t: " ", line })),
    ...mid,
    ...a.slice(a.length - suf).map((line): Op => ({ t: " ", line })),
  ];
}

const splitLines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/* Unified diff (3 lines of context) of one file, capped at `cap` characters. */
export function unifiedDiff(path: string, before: string | null, after: string, cap = DIFF_CAP): string {
  const ops = lineOps(splitLines(before ?? ""), splitLines(after));
  const changed = ops.map((o, k) => (o.t !== " " ? k : -1)).filter((k) => k >= 0);
  const head = `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n`;
  if (!changed.length) return head + "(beze změny)\n";

  // group changes whose context windows touch into hunks
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - CONTEXT), hi = Math.min(ops.length - 1, k + CONTEXT);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = hi;
    else hunks.push([lo, hi]);
  }
  // line numbers before each op
  const aNo: number[] = [], bNo: number[] = [];
  let x = 1, y = 1;
  for (const o of ops) {
    aNo.push(x); bNo.push(y);
    if (o.t !== "+") x++;
    if (o.t !== "-") y++;
  }
  let out = head;
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi + 1);
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    const aStart = aLen ? aNo[lo] : aNo[lo] - 1;
    const bStart = bLen ? bNo[lo] : bNo[lo] - 1;
    out += `@@ -${aStart},${aLen} +${bStart},${bLen} @@\n`;
    for (const o of slice) out += `${o.t}${o.line}\n`;
  }
  if (out.length > cap) {
    const added = ops.filter((o) => o.t === "+").length, removed = ops.filter((o) => o.t === "-").length;
    out = out.slice(0, cap).replace(/\n[^\n]*$/, "\n") + `… (náhled zkrácen: celkem +${added} / −${removed} řádků)\n`;
  }
  return out;
}

/* ───────────── IO: propose + execute ───────────── */

function readCurrent(path: string): string | null {
  const full = resolveVaultPath(path);
  if (!existsSync(full)) return null;
  if (!statSync(full).isFile()) throw new Error(`${path} není soubor.`);
  return readFileSync(full, "utf8");
}

function topFolderExists(top: string): boolean {
  const root = vaultDir();
  if (!root) return false;
  try { return statSync(join(root, top)).isDirectory(); } catch { return false; }
}

type Planned = { path: string; mode: VaultWriteMode; before: string | null; after: string; hash: string; diff: string };

function planFiles(input: VaultWriteInput): Planned[] {
  return input.files.map((f) => {
    const path = normVaultPath(f.path);
    const before = readCurrent(path);
    if (before === null) checkNewPath(path, topFolderExists);
    const after = applyFileOp(before, { ...f, path });
    if (after === before) throw new Error(`${path}: změna by soubor nijak nezměnila.`);
    const secret = findSecret(after);
    if (secret && (before === null || !findSecret(before))) {
      throw new Error(`${path}: výsledný obsah vypadá, že obsahuje tajemství (${secret}) – SCHEMA §9.`);
    }
    return { path, mode: f.mode, before, after, hash: hashText(before), diff: unifiedDiff(path, before, after) };
  });
}

function logEntryOf(input: VaultWriteInput): VaultLogEntry {
  return input.log_entry ?? { type: "edit", title: input.reason.trim() };
}

/* Propose time: validate everything, capture each target's hash and the
 * exact diff the owner will approve. Throws a readable Czech error. */
export function prepareVaultWrite<T extends VaultWriteInput>(input: T): T {
  if (!vaultDir()) throw new Error("Vault AI Mozek není nastavený (APEX_VAULT_DIR).");
  validateStatic(input);
  const planned = planFiles(input);
  const entry = formatLogEntry(logEntryOf(input), pragueDate());
  const logBefore = readCurrent(LOG_PATH) ?? "";
  const preview: VaultPreview[] = [
    ...planned.map((p) => ({ path: p.path, mode: p.mode, diff: p.diff })),
    { path: LOG_PATH, mode: "log", diff: unifiedDiff(LOG_PATH, logBefore, appendLogEntry(logBefore, entry)) },
  ];
  return {
    ...input,
    reason: input.reason.trim(),
    files: input.files.map((f, i) => ({ ...f, path: planned[i].path, base_hash: planned[i].hash })),
    preview,
  };
}

function writeAtomic(full: string, text: string): void {
  mkdirSync(dirname(full), { recursive: true });
  const tmp = join(dirname(full), `.apex-${randomBytes(6).toString("hex")}-${basename(full)}.tmp`);
  try {
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, full);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

const run = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", root, ...args], { env: GIT_ENV, timeout: 30_000, maxBuffer: 1 << 20 });
  return stdout.trim();
}

async function isGitRepo(root: string): Promise<boolean> {
  try { return (await git(root, ["rev-parse", "--is-inside-work-tree"])) === "true"; } catch { return false; }
}

/* After approval: re-check hashes and the approved diff, write atomically,
 * append the log entry, commit only these paths. Returns the evidence. */
export async function executeVaultWrite(input: VaultWriteInput): Promise<string> {
  const root = vaultDir();
  if (!root) throw new Error("Vault AI Mozek není nastavený (APEX_VAULT_DIR).");
  validateStatic(input);
  const stale = "Soubor se mezitím změnil, nech Apex návrh připravit znovu";
  for (const f of input.files) {
    if (!f.base_hash) throw new Error("Návrh nemá otisk souborů – nech Apex návrh připravit znovu.");
    const path = normVaultPath(f.path);
    if (hashText(readCurrent(path)) !== f.base_hash) throw new Error(`${stale} (${path}).`);
  }
  const planned = planFiles(input);
  // what runs must be exactly what the owner saw in the Deck
  for (const p of planned) {
    const shown = input.preview?.find((v) => v.path === p.path);
    if (!shown || shown.diff !== p.diff) throw new Error(`Obsah návrhu pro ${p.path} se liší od schváleného náhledu – nech Apex návrh připravit znovu.`);
  }
  const entry = formatLogEntry(logEntryOf(input), pragueDate());

  // The owner's own uncommitted edits in these files must never end up in an
  // Apex commit: check before writing, commit only when they are all clean.
  const touched = [...planned.map((p) => p.path), LOG_PATH];
  const git_ = await isGitRepo(root);
  let dirty: string[] = [];
  if (git_) {
    const status = await git(root, ["status", "--porcelain", "--", ...touched]).catch(() => "");
    // porcelain v1 "XY path"; git() trims the output, so the first line may have lost its leading space
    dirty = status.split("\n").filter(Boolean).map((l) => l.replace(/^[ MADRCU?!]{1,2} /, "").replace(/^"|"$/g, ""));
  }

  for (const p of planned) writeAtomic(resolveVaultPath(p.path), p.after);
  writeAtomic(resolveVaultPath(LOG_PATH), appendLogEntry(readCurrent(LOG_PATH) ?? "", entry));

  const paths = planned.map((p) => p.path);
  const n = paths.length;
  let evidence = `zapsáno ${n} ${plural(n)} (vault není git)`;
  if (git_ && dirty.length) {
    evidence = `zapsáno ${n} ${plural(n)}, bez commitu – v ${dirty.join(", ")} máš vlastní necommitnuté změny, commitni je sám`;
  } else if (git_) {
    try {
      await git(root, ["add", "--", ...touched]);
      await git(root, [
        "-c", "user.name=Apex", "-c", "user.email=apex@localhost",
        "commit", "-m", `apex: ${input.reason.trim()}`, "--author", "Apex <apex@localhost>", "--", ...touched,
      ]);
      evidence = `git ${await git(root, ["rev-parse", "--short", "HEAD"])}: ${n} ${plural(n)}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      evidence = `zapsáno ${n} ${plural(n)}, ale git commit selhal: ${msg}`;
    }
  }

  // keep the semantic index fresh; the write itself already succeeded
  import("./semantic")
    .then((m) => m.reindexVaultPaths(paths))
    .catch(() => { /* semantic index unavailable */ });
  return evidence;
}
