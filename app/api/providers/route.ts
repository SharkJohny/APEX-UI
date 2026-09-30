import { NextResponse } from "next/server";
import { detectProviders } from "@/server/llm";
import { isLoopback } from "@/lib/localOnly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  return NextResponse.json({
    providers: detectProviders(),
    tts: process.env.ELEVENLABS_API_KEY ? "elevenlabs" : process.env.OPENAI_API_KEY ? "openai" : "browser",
  });
}
