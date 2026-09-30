import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import { openAiError, openAiTtsConfig, resolveTts } from "@/server/voiceConfig";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Server voice for Apex's replies, engine chosen by APEX_TTS (see
 * server/voiceConfig.ts). 404 when no server voice is configured - the
 * browser then speaks itself. */

// gpt-4o-mini-tts takes free-form delivery instructions (not tts-1 / tts-1-hd).
const CZECH_DELIVERY =
  "Mluv přirozenou, plynulou češtinou s českou výslovností a intonací, jako rodilý mluvčí. " +
  "Tón klidný, vřelý a sebejistý, tempo příjemné a spíš svižné, žádné přehnané emoce. " +
  "Jsi Apex, osobní asistent majitele firmy; čísla, data a zkratky čti tak, jak by je řekl Čech.";

const MAX_INPUT = 4096; // OpenAI audio/speech input limit

export async function POST(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const { tts, hint } = resolveTts();
  if (tts === "browser") return NextResponse.json({ error: hint || "Serverový hlas není nastavený – mluví prohlížeč." }, { status: 404 });

  const { text } = (await request.json().catch(() => ({}))) as { text?: string };
  if (!text?.trim()) return NextResponse.json({ error: "Chybí text k přečtení." }, { status: 400 });

  if (tts === "elevenlabs") {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        signal: request.signal,
        headers: { "content-type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY! },
        body: JSON.stringify({
          text: text.slice(0, 4000),
          model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
        }),
      },
    ).catch((e: unknown) => e as Error);
    if (res instanceof Error) return NextResponse.json({ error: `ElevenLabs nedostupný: ${res.message}` }, { status: 502 });
    if (!res.ok) return NextResponse.json({ error: `ElevenLabs selhal (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}` }, { status: 502 });
    return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  }

  const { model, voice } = openAiTtsConfig();
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    signal: request.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      voice,
      input: text.slice(0, MAX_INPUT),
      response_format: "mp3",
      ...(/^tts-1/.test(model) ? {} : { instructions: CZECH_DELIVERY }),
    }),
  }).catch((e: unknown) => e as Error);
  if (res instanceof Error) return NextResponse.json({ error: `OpenAI nedostupné: ${res.message}` }, { status: 502 });
  if (!res.ok) return NextResponse.json({ error: `OpenAI hlas selhal (HTTP ${res.status}): ${await openAiError(res)}` }, { status: 502 });
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
