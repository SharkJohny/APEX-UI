import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { all, run } from "./db";
import type { ProviderInfo } from "./llm";

/* Owner settings edited in the app instead of .env.local. Values live in the
 * settings table and are written INTO process.env at boot and after every
 * change, so the rest of the server keeps reading process.env at call time.
 * The original environment is snapshotted once, so clearing a setting brings
 * back the .env.local value. Secrets never leave this module unmasked; child
 * CLIs still get only the env allowlist in server/llm.ts. Everything else is
 * imported lazily so applySettings() at boot runs before any module that
 * reads process.env at load time. */

export type FieldType = "secret" | "text" | "bool" | "select" | "number";
export type Source = "settings" | "env" | "default" | "unset";
type Option = { value: string; label: string };

type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  /* Select options, or suggestions for a text field. A "custom" option allows free text. */
  options?: Option[] | (() => Option[]);
  placeholder?: string;
  help?: string;
  /* Effective value when nothing is set (mirrors the code's fallback). */
  default?: string;
  min?: number;
  max?: number;
  /* Known token format - an unknown format only warns. */
  format?: { re: RegExp; hint: string };
  /* Free-text value check (hard). */
  pattern?: { re: RegExp; hint: string };
};

type GroupDef = {
  id: string;
  title: string;
  description: string;
  links: { label: string; url: string }[];
  fields: FieldDef[];
  actions?: { id: string; label: string; href?: string; test?: string }[];
};

export type SettingsField = {
  key: string; label: string; type: FieldType;
  options?: Option[]; placeholder?: string; help?: string;
  value?: string; set: boolean; masked?: string; source: Source;
};
export type SettingsGroup = Omit<GroupDef, "fields"> & { fields: SettingsField[] };

const MODEL_ID = { re: /^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,119}$/, hint: "Neplatné ID modelu (jen písmena, čísla a . _ - : / [ ])." };
const CUSTOM: Option = { value: "custom", label: "Vlastní…" };
const DEFAULT_OPT = (label = "Výchozí (CLI)"): Option => ({ value: "", label });

const CLAUDE_MODELS: Option[] = [
  DEFAULT_OPT(), { value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }, { value: "haiku", label: "Haiku" }, CUSTOM,
];

/* Models the installed codex offers (its own cache), falling back to a static list. */
function codexModels(): Option[] {
  try {
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const data = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8"));
    const list = (Array.isArray(data?.models) ? data.models : []) as { slug?: string; display_name?: string; visibility?: string }[];
    const ids = list.filter((m) => m.slug && m.visibility !== "hide").map((m) => ({ value: m.slug!, label: m.display_name || m.slug! }));
    if (ids.length) return ids;
  } catch { /* no cache - static list */ }
  return ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.5"].map((v) => ({ value: v, label: v }));
}

/* Filled by loadProviders() before options are read. */
let providers: ProviderInfo[] = [];
async function loadProviders() {
  providers = (await import("./llm")).detectProviders();
}
function providerOptions(): Option[] {
  return [{ value: "", label: "Automaticky" }, ...providers.map((p) => ({ value: p.id, label: p.label }))];
}

const opts = (...v: string[]): Option[] => v.map((x) => ({ value: x, label: x }));
const TTS_VOICES = opts("marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse");
const REALTIME_VOICES = opts("marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse");

const GROUPS: GroupDef[] = [
  {
    id: "ai",
    title: "Mozek (AI modely)",
    description: "Kdo za Apex přemýšlí. Předplatné (Claude, ChatGPT/Codex) běží přes tvoje přihlášení v CLI a umí nástroje; placené API klíče jsou jen pro chat bez nástrojů a pro hlas OpenAI.",
    links: [
      { label: "OpenAI – API klíče", url: "https://platform.openai.com/api-keys" },
      { label: "OpenAI – fakturace a kredit", url: "https://platform.openai.com/settings/organization/billing" },
      { label: "OpenAI – využití", url: "https://platform.openai.com/usage" },
      { label: "Anthropic – API klíče", url: "https://platform.claude.com/settings/keys" },
      { label: "Claude – předplatné a využití", url: "https://claude.ai/settings" },
      { label: "ChatGPT – nastavení účtu", url: "https://chatgpt.com/#settings" },
    ],
    fields: [
      { key: "APEX_DEFAULT_PROVIDER", label: "Výchozí poskytovatel", type: "select", options: providerOptions, help: "Kterým modelem Apex odpovídá, když v chatu nevybereš jinak." },
      { key: "APEX_CLAUDE_MODEL_CHIEF", label: "Claude – model pro šéfa (Chief of Staff)", type: "select", options: CLAUDE_MODELS, pattern: MODEL_ID, placeholder: "claude-opus-5-5", help: "Prázdné = výchozí model Claude CLI. Vlastní = celé ID modelu. Platí i pro smyčky a frontu Raqeto." },
      { key: "APEX_CLAUDE_MODEL_SPECIALIST", label: "Claude – model pro specialisty", type: "select", options: CLAUDE_MODELS, pattern: MODEL_ID, placeholder: "claude-sonnet-5", help: "Model pro delegované úkoly specialistů." },
      { key: "APEX_CODEX_MODEL_CHIEF", label: "Codex – model pro šéfa", type: "text", options: codexModels, pattern: MODEL_ID, placeholder: "výchozí z ~/.codex/config.toml", help: "Prázdné = model z tvé konfigurace Codexu." },
      { key: "APEX_CODEX_MODEL_SPECIALIST", label: "Codex – model pro specialisty", type: "text", options: codexModels, pattern: MODEL_ID, placeholder: "výchozí z ~/.codex/config.toml" },
      {
        key: "APEX_CODEX_REASONING", label: "Codex – úsilí přemýšlení", type: "select",
        options: [DEFAULT_OPT("Výchozí (z konfigurace)"), { value: "low", label: "Nízké" }, { value: "medium", label: "Střední" }, { value: "high", label: "Vysoké" }, { value: "xhigh", label: "Velmi vysoké" }, { value: "max", label: "Maximální" }],
        help: "Vyšší = pomalejší a důkladnější odpovědi; spotřebuje víc limitu předplatného.",
      },
      { key: "OPENAI_API_KEY", label: "OpenAI API klíč", type: "secret", format: { re: /^sk-[A-Za-z0-9_-]{20,}$/, hint: "OpenAI klíče obvykle začínají „sk-“." }, help: "Potřeba pro hlas OpenAI (čtení odpovědí, přepis řeči, plný rozhovor) a pro chat přes OpenAI API." },
      { key: "OPENAI_MODEL", label: "OpenAI API – model chatu", type: "text", pattern: MODEL_ID, default: "gpt-4o-mini", options: opts("gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.5") },
      { key: "ANTHROPIC_API_KEY", label: "Anthropic API klíč", type: "secret", format: { re: /^sk-ant-[A-Za-z0-9_-]{20,}$/, hint: "Anthropic klíče obvykle začínají „sk-ant-“." }, help: "Placené API – jen chat bez nástrojů. S předplatným Claude ho nepotřebuješ." },
      { key: "ANTHROPIC_MODEL", label: "Anthropic API – model", type: "text", pattern: MODEL_ID, default: "claude-sonnet-5", options: opts("claude-opus-5-5", "claude-sonnet-5") },
      { key: "APEX_LLM_TIMEOUT_MS", label: "Časový limit jednoho volání modelu", type: "number", min: 60_000, max: 7_200_000, default: "600000", help: "V minutách (1–120). Platí od další úlohy." },
    ],
    actions: [
      { id: "test-openai", label: "Otestovat OpenAI klíč", test: "openai" },
      { id: "test-anthropic", label: "Otestovat Anthropic klíč", test: "anthropic" },
    ],
  },
  {
    id: "voice",
    title: "Hlas",
    description: "Jak Apex poslouchá a mluví. „Čtení odpovědí“ = mozek z předplatného, hlas OpenAI/ElevenLabs. „Plný rozhovor“ = OpenAI Realtime, data a akce si bere přes Apex (schvalování zůstává).",
    links: [
      { label: "OpenAI – API klíče", url: "https://platform.openai.com/api-keys" },
      { label: "ElevenLabs – API klíče", url: "https://elevenlabs.io/app/developers/api-keys" },
      { label: "ElevenLabs – knihovna hlasů", url: "https://elevenlabs.io/app/voice-library" },
    ],
    fields: [
      {
        key: "APEX_VOICE_MODE", label: "Režim hlasu", type: "select", default: "browser",
        options: [{ value: "browser", label: "Prohlížeč (zdarma)" }, { value: "openai", label: "Čtení odpovědí hlasem OpenAI" }, { value: "realtime", label: "Plný rozhovor (OpenAI Realtime)" }],
        help: "OpenAI režimy vyžadují OpenAI API klíč (skupina Mozek).",
      },
      { key: "APEX_STT", label: "Rozpoznávání řeči", type: "select", default: "browser", options: [{ value: "browser", label: "Prohlížeč" }, { value: "openai", label: "OpenAI přepis" }] },
      {
        key: "APEX_TTS", label: "Hlas odpovědí", type: "select", default: "auto",
        options: [{ value: "auto", label: "Automaticky (ElevenLabs › OpenAI › prohlížeč)" }, { value: "browser", label: "Prohlížeč" }, { value: "openai", label: "OpenAI" }, { value: "elevenlabs", label: "ElevenLabs" }],
      },
      { key: "OPENAI_TTS_MODEL", label: "OpenAI – model hlasu", type: "select", default: "gpt-4o-mini-tts", options: [...opts("gpt-4o-mini-tts", "tts-1", "tts-1-hd"), CUSTOM], pattern: MODEL_ID },
      { key: "OPENAI_TTS_VOICE", label: "OpenAI – hlas", type: "select", default: "marin", options: TTS_VOICES, help: "Nejlepší kvalita: marin nebo cedar. tts-1 umí jen alloy, ash, coral, echo, fable, onyx, nova, sage, shimmer." },
      { key: "OPENAI_STT_MODEL", label: "OpenAI – model přepisu řeči", type: "select", options: [DEFAULT_OPT("Výchozí"), ...opts("gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"), CUSTOM], pattern: MODEL_ID },
      { key: "OPENAI_REALTIME_MODEL", label: "OpenAI – model plného rozhovoru", type: "select", options: [DEFAULT_OPT("Výchozí"), ...opts("gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-realtime-2", "gpt-realtime-1.5"), CUSTOM], pattern: MODEL_ID },
      { key: "OPENAI_REALTIME_VOICE", label: "OpenAI – hlas plného rozhovoru", type: "select", options: [DEFAULT_OPT("Výchozí"), ...REALTIME_VOICES], help: "Hlas nejde změnit uprostřed rozhovoru – projeví se u dalšího." },
      { key: "ELEVENLABS_API_KEY", label: "ElevenLabs API klíč", type: "secret", format: { re: /^(sk_)?[A-Za-z0-9]{32,}$/, hint: "ElevenLabs klíče obvykle začínají „sk_“." } },
      { key: "ELEVENLABS_VOICE_ID", label: "ElevenLabs – ID hlasu", type: "text", default: "21m00Tcm4TlvDq8ikWAM", pattern: { re: /^[A-Za-z0-9]{10,40}$/, hint: "ID hlasu je řetězec písmen a číslic (najdeš ho v knihovně hlasů)." } },
      { key: "ELEVENLABS_MODEL", label: "ElevenLabs – model", type: "select", default: "eleven_multilingual_v2", options: [...opts("eleven_multilingual_v2", "eleven_v3", "eleven_flash_v2_5", "eleven_turbo_v2_5"), CUSTOM], pattern: MODEL_ID },
    ],
    actions: [
      { id: "test-openai", label: "Otestovat OpenAI klíč", test: "openai" },
      { id: "test-elevenlabs", label: "Otestovat ElevenLabs klíč", test: "elevenlabs" },
    ],
  },
  {
    id: "raqeto",
    title: "Raqeto CRM",
    description: "Hlavní CRM: klienti, projekty, úkoly, faktury. Apex čte a zapisuje přes AI API; zápisy viditelné klientovi nebo s penězi jdou přes schválení.",
    links: [{ label: "Raqeto – nastavení integrací (AI klíč)", url: "https://www.raqeto.com/dashboard/settings/#tab-integrations" }],
    fields: [
      { key: "RAQETO_API_TOKEN", label: "Raqeto AI klíč", type: "secret", format: { re: /^raq_live_[A-Za-z0-9_-]{8,}$/, hint: "Raqeto AI klíče začínají „raq_live_“." } },
      { key: "RAQETO_API_BASE", label: "Adresa API", type: "text", default: "https://www.raqeto.com/api/ai", placeholder: "https://www.raqeto.com/api/ai" },
      { key: "RAQETO_AI_QUEUE", label: "Zpracovávat AI frontu automaticky", type: "bool", default: "1", help: "Úkoly přiřazené AI v Raqetu Apex sám vyzvedne a zpracuje." },
    ],
    actions: [
      { id: "test-raqeto", label: "Otestovat připojení", test: "raqeto" },
      { id: "open-crm", label: "Otevřít CRM v Decku", href: "/?deck=crm" },
    ],
  },
  {
    id: "google",
    title: "Google (Gmail, Kalendář, Disk)",
    description: "OAuth klient z Google Cloud. Po uložení klíčů připoj účet tlačítkem níže. Jako přesměrování zadej …/api/integrations/google/callback.",
    links: [
      { label: "Google Cloud – přihlašovací údaje (OAuth klient)", url: "https://console.cloud.google.com/apis/credentials" },
      { label: "Google Cloud – knihovna API (zapnout Gmail/Calendar/Drive)", url: "https://console.cloud.google.com/apis/library" },
    ],
    fields: [
      { key: "GOOGLE_CLIENT_ID", label: "Client ID", type: "text", format: { re: /\.apps\.googleusercontent\.com$/, hint: "Client ID obvykle končí „.apps.googleusercontent.com“." }, placeholder: "….apps.googleusercontent.com" },
      { key: "GOOGLE_CLIENT_SECRET", label: "Client secret", type: "secret", format: { re: /^GOCSPX-/, hint: "Client secret obvykle začíná „GOCSPX-“." } },
    ],
    actions: [
      { id: "test-google", label: "Zkontrolovat stav", test: "google" },
      { id: "connect-google", label: "Připojit Google účet", href: "/api/integrations/google/start" },
    ],
  },
  {
    id: "social",
    title: "Sociální sítě",
    description: "Publikování příspěvků (vždy až po tvém schválení). Tokeny stránek získáš v Meta for Developers a LinkedIn Developers.",
    links: [
      { label: "Meta for Developers – aplikace", url: "https://developers.facebook.com/apps" },
      { label: "Meta – Graph API Explorer (tokeny)", url: "https://developers.facebook.com/tools/explorer/" },
      { label: "LinkedIn Developers – aplikace", url: "https://www.linkedin.com/developers/apps" },
    ],
    fields: [
      { key: "FB_PAGE_ID", label: "Facebook – ID stránky", type: "text", pattern: { re: /^\d{5,30}$/, hint: "ID stránky je číslo." } },
      { key: "FB_PAGE_TOKEN", label: "Facebook – token stránky", type: "secret", format: { re: /^EAA/, hint: "Meta tokeny obvykle začínají „EAA“." } },
      { key: "IG_USER_ID", label: "Instagram – ID business účtu", type: "text", pattern: { re: /^\d{5,30}$/, hint: "ID účtu je číslo." } },
      { key: "IG_TOKEN", label: "Instagram – token", type: "secret", format: { re: /^(EAA|IG)/, hint: "Tokeny obvykle začínají „EAA“ nebo „IG“." } },
      { key: "LINKEDIN_TOKEN", label: "LinkedIn – token", type: "secret" },
      { key: "LINKEDIN_AUTHOR_URN", label: "LinkedIn – autor (URN)", type: "text", placeholder: "urn:li:person:…", pattern: { re: /^urn:li:(person|organization):[A-Za-z0-9_-]+$/, hint: "Očekávám urn:li:person:… nebo urn:li:organization:…" } },
      { key: "LINKEDIN_VERSION", label: "LinkedIn – verze API", type: "text", default: "202409", pattern: { re: /^\d{6}$/, hint: "Verze ve tvaru RRRRMM, např. 202409." } },
    ],
    actions: [{ id: "test-social", label: "Ověřit tokeny", test: "social" }],
  },
  {
    id: "vault",
    title: "Obsidian trezor (AI Mozek)",
    description: "Dlouhodobá paměť Apexu – složka trezoru se SCHEMA.md.",
    links: [{ label: "Obsidian – nápověda", url: "https://obsidian.md/help" }],
    fields: [
      { key: "APEX_VAULT_DIR", label: "Složka trezoru", type: "text", default: join(homedir(), "ai-mozek"), placeholder: "~/ai-mozek", help: "Absolutní cesta (nebo ~/…) ke složce trezoru." },
    ],
    actions: [{ id: "test-vault", label: "Zkontrolovat trezor", test: "vault" }],
  },
  {
    id: "ui",
    title: "Rozhraní",
    description: "Jak se Apex chová na obrazovce.",
    links: [],
    fields: [
      {
        key: "APEX_APPROVAL_POPUP", label: "Schválení vyskakují jako okno", type: "bool", default: "1",
        help: "Nový návrh ke schválení (e-mail, zápis do AI Mozku, změna v Raqetu…) se hned otevře v okně uprostřed obrazovky. Návrhy čekající z dřívějška se ukážou jednou za návštěvu. Vypnuto = jen odznak a záložka Schválení v Decku.",
      },
    ],
  },
];

const FIELDS = new Map<string, FieldDef>(GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f] as const)));

/* ── process.env application ── */

const gs = globalThis as { __apexEnvOrig?: Record<string, string | undefined> };

function envSnapshot(): Record<string, string | undefined> {
  if (!gs.__apexEnvOrig) {
    const snap: Record<string, string | undefined> = {};
    for (const key of FIELDS.keys()) snap[key] = process.env[key];
    gs.__apexEnvOrig = snap;
  }
  return gs.__apexEnvOrig;
}

function stored(): Map<string, string> {
  return new Map(all<{ key: string; value: string }>("SELECT key, value FROM settings").map((r) => [r.key, r.value]));
}

/* Write stored settings over process.env; keys without a setting get their
 * original value back (or are removed). Called at boot and after each change. */
export function applySettings() {
  const orig = envSnapshot();
  const rows = stored();
  for (const key of FIELDS.keys()) {
    const v = rows.has(key) ? rows.get(key) : orig[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

async function invalidate(key: string) {
  delete (globalThis as { __apexProviders?: unknown }).__apexProviders;
  (await import("./integrations/raqeto")).resetRaqetoCache();
  (await import("./integrations/social")).resetSocialVerify();
  // A token set after boot should start the queue without a restart (idempotent).
  if (key.startsWith("RAQETO_")) {
    const { startRaqetoQueue } = await import("./raqetoQueue");
    startRaqetoQueue();
  }
}

/* ── read ── */

function mask(v: string): string {
  return v.length >= 12 ? `••••${v.slice(-4)}` : "••••";
}

function describe(f: FieldDef, rows: Map<string, string>): SettingsField {
  const orig = envSnapshot();
  const inSettings = rows.has(f.key);
  const current = process.env[f.key];
  const source: Source = inSettings ? "settings" : orig[f.key] ? "env" : f.default !== undefined ? "default" : "unset";
  const set = !!current;
  const out: SettingsField = {
    key: f.key, label: f.label, type: f.type,
    ...(f.options ? { options: typeof f.options === "function" ? f.options() : f.options } : {}),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.help ? { help: f.help } : {}),
    set, source,
  };
  if (f.type === "secret") {
    if (current) out.masked = mask(current);
  } else {
    const value = current !== undefined && (current !== "" || inSettings) ? current : f.default;
    if (value !== undefined) out.value = value;
  }
  return out;
}

export async function getSettings(): Promise<{ groups: SettingsGroup[] }> {
  await loadProviders();
  const rows = stored();
  return { groups: GROUPS.map((g) => ({ ...g, fields: g.fields.map((f) => describe(f, rows)) })) };
}

export function settingsField(key: string): SettingsField | undefined {
  const f = FIELDS.get(key);
  return f && describe(f, stored());
}

/* ── write ── */

export class SettingsError extends Error {}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/* Returns the normalized value and an optional (non-blocking) warning. */
function validate(f: FieldDef, raw: unknown): { value: string; warning?: string } {
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") throw new SettingsError("Hodnota musí být text.");
  let v = String(raw).trim();
  if (/[\r\n\0]/.test(v)) throw new SettingsError("Hodnota nesmí obsahovat nové řádky ani nulové znaky.");
  if (v.length > 4096) throw new SettingsError("Hodnota je příliš dlouhá (max 4096 znaků).");

  switch (f.type) {
    case "bool": {
      const t = v.toLowerCase();
      if (["1", "true", "ano", "on", "yes"].includes(t)) return { value: "1" };
      if (["0", "false", "ne", "off", "no"].includes(t)) return { value: "0" };
      throw new SettingsError("Očekávám zapnuto (1) nebo vypnuto (0).");
    }
    case "number": {
      if (!/^\d+$/.test(v)) throw new SettingsError("Očekávám celé kladné číslo.");
      const n = Number(v);
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
        throw new SettingsError(`Hodnota musí být v rozsahu ${f.min ?? 0}–${f.max ?? "∞"}.`);
      }
      return { value: String(n) };
    }
    case "secret":
      if (!v) throw new SettingsError("Prázdný klíč neukládám – pro odstranění použij Smazat.");
      if (/\s/.test(v)) throw new SettingsError("Klíč nesmí obsahovat mezery.");
      break;
    case "select": {
      const options = typeof f.options === "function" ? f.options() : f.options ?? [];
      const custom = options.some((o) => o.value === "custom");
      if (v === "custom") throw new SettingsError("Zadej vlastní hodnotu.");
      if (!options.some((o) => o.value === v) && !(custom && v)) {
        throw new SettingsError(`Neplatná volba. Povolené: ${options.map((o) => o.value || "(výchozí)").join(", ")}.`);
      }
      break;
    }
  }

  if (v && f.pattern && !f.pattern.re.test(v)) throw new SettingsError(f.pattern.hint);

  if (f.key === "APEX_VAULT_DIR" && v) {
    v = expandHome(v);
    if (!v.startsWith("/")) throw new SettingsError("Zadej absolutní cestu ke složce trezoru.");
    let dir = false;
    try { dir = statSync(v).isDirectory(); } catch { /* missing */ }
    if (!dir) throw new SettingsError("Složka neexistuje.");
    if (!existsSync(join(v, "SCHEMA.md")) && !existsSync(join(v, ".obsidian"))) {
      return { value: v, warning: "Složka nevypadá jako Obsidian trezor (chybí SCHEMA.md i .obsidian) – Apex ji nepoužije." };
    }
  }
  if (f.key === "RAQETO_API_BASE" && v) {
    let u: URL;
    try { u = new URL(v); } catch { throw new SettingsError("Neplatná adresa URL."); }
    if (u.protocol !== "https:") throw new SettingsError("Adresa API musí být https.");
    v = v.replace(/\/+$/, "");
  }
  if (v && f.format && !f.format.re.test(v)) return { value: v, warning: `Neobvyklý formát: ${f.format.hint} Uložil jsem ho, ověř ho testem.` };
  return { value: v };
}

export async function setSetting(key: string, raw: unknown): Promise<{ field: SettingsField; warning?: string }> {
  const f = FIELDS.get(key);
  if (!f) throw new SettingsError(`Neznámé nastavení: ${String(key).slice(0, 60)}`);
  if (key === "APEX_DEFAULT_PROVIDER") await loadProviders();
  const { value, warning } = validate(f, raw);
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, value,
  );
  applySettings();
  await invalidate(key);
  return { field: settingsField(key)!, ...(warning ? { warning } : {}) };
}

export async function clearSetting(key: string): Promise<{ field: SettingsField }> {
  const f = FIELDS.get(key);
  if (!f) throw new SettingsError(`Neznámé nastavení: ${String(key).slice(0, 60)}`);
  run("DELETE FROM settings WHERE key = ?", key);
  applySettings();
  await invalidate(key);
  return { field: settingsField(key)! };
}
