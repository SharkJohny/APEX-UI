import { NextResponse } from "next/server";
import { detectProviders } from "@/server/llm";
import { isLoopback } from "@/lib/localOnly";
import { hasOpenAiKey, resolveStt, resolveTts, voiceMode } from "@/server/voiceConfig";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* AI providers plus the effective voice setup: voiceMode (browser | openai |
 * realtime), the resolved TTS / STT engines (with a Czech hint when a chosen
 * engine lacks its key) and whether OpenAI Realtime is possible at all. */
export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const providers = detectProviders();
  const mode = voiceMode();
  const tts = resolveTts(mode);
  const stt = resolveStt(mode);
  const wanted = (process.env.APEX_DEFAULT_PROVIDER || "").trim();
  return NextResponse.json({
    providers,
    defaultProvider: providers.some((p) => p.id === wanted) ? wanted : undefined,
    tts: tts.tts,
    voiceMode: mode,
    stt: stt.stt,
    realtime: hasOpenAiKey(),
    hints: [tts.hint, stt.hint].filter(Boolean),
  });
}
