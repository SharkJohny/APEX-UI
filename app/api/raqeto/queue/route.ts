import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import { raqetoQueueStatus, runQueueNow } from "@/server/raqetoQueue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Raqeto AI queue worker: GET = status, POST {op:"run"} = check the queue now
 * (fire-and-forget; progress shows in the status and Deck › Úlohy). */

export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  return NextResponse.json(raqetoQueueStatus());
}

export async function POST(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { op?: unknown } | null;
  if (body?.op !== "run") return NextResponse.json({ error: 'Neplatný požadavek – podporováno jen {"op":"run"}.' }, { status: 400 });
  const r = runQueueNow();
  if (!r.started) return NextResponse.json({ error: r.reason, status: raqetoQueueStatus() }, { status: 409 });
  return NextResponse.json({ ok: true, status: raqetoQueueStatus() });
}
