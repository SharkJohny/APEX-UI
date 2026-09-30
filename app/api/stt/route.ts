import { NextResponse } from "next/server";
import { isLocalHostRequest } from "@/lib/localOnly";
import { NO_OPENAI_KEY_HINT, hasOpenAiKey, openAiError, openAiSttModel } from "@/server/voiceConfig";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* POST multipart/form-data { file: audio } → { text } via OpenAI
 * /v1/audio/transcriptions (Czech). Audio can't travel as JSON, so instead of
 * isLoopback's JSON rule this route demands proof the request comes from the
 * Apex page itself: a loopback Host, an Origin equal to that host and (when
 * the browser sends it) Sec-Fetch-Site: same-origin. A foreign site's form
 * post always carries its own Origin and is refused. */

const MAX_BYTES = 25 * 1024 * 1024; // OpenAI upload limit
// Formats the OpenAI docs list: mp3, mp4, mpeg, mpga, m4a, wav, webm.
const EXT: Record<string, string> = {
  "audio/webm": "webm", "video/webm": "webm",
  "audio/mp4": "mp4", "video/mp4": "mp4", "audio/m4a": "m4a", "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mpga": "mpga",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
};
// Recognition context: names and jargon the owner uses a lot.
const PROMPT = "Hlasový pokyn majitele firmy pro osobního asistenta Apex, česky. Raqeto, CRM, klient, faktura, úkol, schůzka.";

function sameOriginLocal(request: Request): boolean {
  if (!isLocalHostRequest(request)) return false;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd && !fwd.split(",").every((h) => ["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"].includes(h.trim().toLowerCase()))) return false;
  const origin = request.headers.get("origin");
  if (!origin || origin !== `http://${request.headers.get("host")}`) return false;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin";
}

export async function POST(request: Request) {
  if (!sameOriginLocal(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  if (!hasOpenAiKey()) return NextResponse.json({ error: `Přepis řeči přes OpenAI nejde spustit. ${NO_OPENAI_KEY_HINT}` }, { status: 400 });
  if (!(request.headers.get("content-type") || "").startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "Nahrávka musí přijít jako multipart/form-data (pole file)." }, { status: 400 });
  }
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "Nahrávka je moc dlouhá (limit 25 MB)." }, { status: 413 });
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    return NextResponse.json({ error: "Nahrávku se nepodařilo přečíst." }, { status: 400 });
  }
  if (!file || file.size === 0) return NextResponse.json({ error: "Chybí nahrávka (pole file)." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Nahrávka je moc dlouhá (limit 25 MB)." }, { status: 413 });
  const ext = EXT[file.type.split(";")[0].trim().toLowerCase()];
  if (!ext) return NextResponse.json({ error: `Formát nahrávky ${file.type || "(neznámý)"} OpenAI nepřijímá – použij Chrome/Edge/Safari, nebo přepis prohlížečem.` }, { status: 415 });

  const model = openAiSttModel();
  const out = new FormData();
  out.append("file", new Blob([await file.arrayBuffer()], { type: file.type }), `apex.${ext}`);
  out.append("model", model);
  out.append("prompt", PROMPT);
  // gpt-transcribe / gpt-live-transcribe take `languages[]` instead of `language` (never both).
  if (/^gpt-(live-)?transcribe$/.test(model)) out.append("languages[]", "cs");
  else out.append("language", "cs");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    signal: request.signal,
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: out,
  }).catch((e: unknown) => e as Error);
  if (res instanceof Error) return NextResponse.json({ error: `OpenAI nedostupné: ${res.message}` }, { status: 502 });
  if (!res.ok) return NextResponse.json({ error: `Přepis řeči selhal (HTTP ${res.status}): ${await openAiError(res)}` }, { status: 502 });
  const data = (await res.json().catch(() => ({}))) as { text?: string };
  return NextResponse.json({ text: (data.text || "").trim() });
}
