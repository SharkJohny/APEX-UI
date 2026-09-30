import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Optional natural voice. Prefers ElevenLabs (the original author's TTS) when
 * ELEVENLABS_API_KEY is set, falls back to OpenAI when OPENAI_API_KEY is set;
 * otherwise 404 and the browser speaks. */
export async function POST(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!elevenKey && !openaiKey) return NextResponse.json({ error: "no TTS key" }, { status: 404 });

  const { text } = (await request.json().catch(() => ({}))) as { text?: string };
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });

  if (elevenKey) {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        signal: request.signal,
        headers: { "content-type": "application/json", "xi-api-key": elevenKey },
        body: JSON.stringify({
          text: text.slice(0, 4000),
          model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
        }),
      },
    );
    if (!res.ok) return NextResponse.json({ error: (await res.text()).slice(0, 300) }, { status: 502 });
    return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  }

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    signal: request.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE || "alloy",
      input: text.slice(0, 4000),
      response_format: "mp3",
    }),
  });
  if (!res.ok) return NextResponse.json({ error: (await res.text()).slice(0, 300) }, { status: 502 });
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
