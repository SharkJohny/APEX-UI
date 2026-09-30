import { NextResponse } from "next/server";
import { runTurn, type ChatMessage } from "@/server/orchestrator";
import type { ApexEvent } from "@/server/events";
import { isLoopback } from "@/lib/localOnly";
import { rememberOrigin } from "@/server/llm";
import "@/server/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* POST { provider, messages, conversationId? } → NDJSON stream of ApexEvent:
 * state / token / trace / job / action / info / error / done. */
export async function POST(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  rememberOrigin(request);

  let body: { provider?: string; messages?: ChatMessage[]; conversationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const messages = (body.messages || []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim(),
  );
  if (!body.provider || !messages.length || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "provider and a final user message are required" }, { status: 400 });
  }

  const enc = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (ev: ApexEvent) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(JSON.stringify(ev) + "\n")); } catch { open = false; }
      };
      try {
        await runTurn({ provider: body.provider!, messages, conversationId: body.conversationId, emit, signal: abort.signal });
      } catch (e) {
        if (!abort.signal.aborted) emit({ t: "error", v: e instanceof Error ? e.message : String(e) });
      }
      open = false;
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
