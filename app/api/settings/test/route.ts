import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import { raqetoConfigured, raqetoPing } from "@/server/integrations/raqeto";
import { googleStatus } from "@/server/integrations/google";
import { resetSocialVerify, socialStatus, verifySocial } from "@/server/integrations/social";
import { vaultStatus } from "@/server/vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* POST { target } → { ok, message } - checks a key/integration from Settings.
 * Provider error bodies are never passed through (some echo part of the key). */
type Result = { ok: boolean; message: string };
const TIMEOUT_MS = 10_000;
const HINT = "Doplň ho v Nastavení.";

async function call(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function failure(provider: string, status: number): Result {
  if (status === 401 || status === 403) return { ok: false, message: `${provider}: klíč je neplatný nebo nemá oprávnění (HTTP ${status}).` };
  if (status === 429) return { ok: false, message: `${provider}: překročený limit nebo chybí kredit (HTTP 429).` };
  return { ok: false, message: `${provider}: služba odpověděla chybou HTTP ${status}.` };
}

function netError(provider: string, e: unknown): Result {
  const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  return { ok: false, message: timeout ? `${provider}: neodpověděl do 10 s.` : `${provider}: spojení selhalo.` };
}

/* Configured model ids that the account does not list. */
function missing(ids: Set<string>, keys: string[]): string[] {
  return keys.map((k) => process.env[k]?.trim()).filter((m): m is string => !!m && !ids.has(m));
}

async function testOpenAi(): Promise<Result> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return { ok: false, message: `OpenAI API klíč není nastavený. ${HINT}` };
  try {
    const res = await call("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` });
    if (!res.ok) return failure("OpenAI", res.status);
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = new Set((data.data ?? []).map((m) => m.id));
    const miss = missing(ids, ["OPENAI_MODEL", "OPENAI_TTS_MODEL", "OPENAI_STT_MODEL", "OPENAI_REALTIME_MODEL"]);
    return {
      ok: true,
      message: `OpenAI klíč funguje (${ids.size} dostupných modelů).` + (miss.length ? ` Pozor, účet nevidí nastavené modely: ${miss.join(", ")}.` : ""),
    };
  } catch (e) {
    return netError("OpenAI", e);
  }
}

async function testAnthropic(): Promise<Result> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return { ok: false, message: `Anthropic API klíč není nastavený. ${HINT}` };
  try {
    const res = await call("https://api.anthropic.com/v1/models?limit=1000", { "x-api-key": key, "anthropic-version": "2023-06-01" });
    if (!res.ok) return failure("Anthropic", res.status);
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = new Set((data.data ?? []).map((m) => m.id));
    const miss = missing(ids, ["ANTHROPIC_MODEL"]);
    return { ok: true, message: `Anthropic klíč funguje (${ids.size} modelů).` + (miss.length ? ` Model ${miss[0]} v seznamu není – zkontroluj ID.` : "") };
  } catch (e) {
    return netError("Anthropic", e);
  }
}

async function testElevenLabs(): Promise<Result> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) return { ok: false, message: `ElevenLabs klíč není nastavený. ${HINT}` };
  try {
    const res = await call("https://api.elevenlabs.io/v1/user", { "xi-api-key": key });
    if (res.status === 401) {
      // A restricted key without "User: read" is still valid for speech.
      const body = (await res.json().catch(() => null)) as { detail?: { status?: string } } | null;
      if (body?.detail?.status === "missing_permissions") return { ok: true, message: "ElevenLabs klíč platí (bez oprávnění ke čtení účtu, pro hlas to stačí)." };
    }
    if (!res.ok) return failure("ElevenLabs", res.status);
    const u = (await res.json()) as { subscription?: { tier?: string; character_count?: number; character_limit?: number } };
    const s = u.subscription;
    const usage = s && typeof s.character_count === "number" && typeof s.character_limit === "number" ? `, využito ${s.character_count} z ${s.character_limit} znaků` : "";
    return { ok: true, message: `ElevenLabs klíč funguje${s?.tier ? ` (tarif ${s.tier}${usage})` : ""}.` };
  } catch (e) {
    return netError("ElevenLabs", e);
  }
}

async function testRaqeto(): Promise<Result> {
  if (!raqetoConfigured()) return { ok: false, message: `Raqeto AI klíč není nastavený. ${HINT}` };
  const s = await Promise.race([
    raqetoPing(true),
    new Promise<null>((r) => setTimeout(() => r(null), TIMEOUT_MS)),
  ]);
  if (!s) return { ok: false, message: "Raqeto neodpovědělo do 10 s." };
  if (!s.ok) return { ok: false, message: `Raqeto: ${s.error || "připojení selhalo."}` };
  const scopes = s.scopes?.length ? `, oprávnění: ${s.scopes.join(", ")}` : "";
  return { ok: true, message: `Raqeto připojeno – ${s.workspace?.name || "workspace"}${scopes}.` };
}

function testGoogle(): Result {
  const s = googleStatus();
  if (!s.configured) return { ok: false, message: `Google není nakonfigurovaný – doplň v Nastavení Client ID a Client secret.` };
  if (!s.connected) return { ok: false, message: s.error ? `Google účet je odpojený: ${s.error} Připoj ho znovu.` : "Klíče jsou nastavené, ale účet ještě není připojený – klikni na „Připojit Google účet“." };
  return { ok: true, message: `Google připojen${s.account ? ` jako ${s.account}` : ""} (${s.scopes?.length ?? 0} oprávnění).` };
}

async function testSocial(): Promise<Result> {
  const configured = Object.entries(socialStatus()).filter(([, v]) => v.configured).map(([k]) => k);
  if (!configured.length) return { ok: false, message: `Žádná sociální síť není nastavená – doplň tokeny v Nastavení.` };
  resetSocialVerify();
  const r = (await verifySocial()) as Record<string, { ok: boolean; name?: string; error?: string }>;
  const NAMES: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };
  const parts = configured.map((k) => (r[k].ok ? `${NAMES[k]}: OK${r[k].name ? ` (${r[k].name})` : ""}` : `${NAMES[k]}: ${r[k].error || "chyba"}`));
  return { ok: configured.every((k) => r[k].ok), message: parts.join(" · ") };
}

function testVault(): Result {
  const s = vaultStatus();
  if (!s.configured) return { ok: false, message: "Trezor nenalezen – zadej složku se SCHEMA.md nebo .obsidian." };
  return { ok: true, message: `Trezor ${s.path}: ${s.notes ?? 0} poznámek.` };
}

const TESTS: Record<string, () => Result | Promise<Result>> = {
  openai: testOpenAi, anthropic: testAnthropic, elevenlabs: testElevenLabs, raqeto: testRaqeto,
  google: testGoogle, social: testSocial, vault: testVault,
};

export async function POST(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  let body: { target?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Neplatný JSON." }, { status: 400 });
  }
  const test = typeof body?.target === "string" && Object.hasOwn(TESTS, body.target) ? TESTS[body.target] : null;
  if (!test) return NextResponse.json({ error: "Neznámý cíl testu." }, { status: 400 });
  try {
    return NextResponse.json(await test());
  } catch {
    return NextResponse.json({ ok: false, message: "Test selhal nečekanou chybou." });
  }
}
