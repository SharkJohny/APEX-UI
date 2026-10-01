import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import { aiccEvents, lastEventId } from "@/server/aiccWatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* GET ?after=<id> → new window events for the UI notifications.
 * Without after: only the current last id (start point, no backlog). */
export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const after = new URL(request.url).searchParams.get("after");
  if (after === null) return NextResponse.json({ last: lastEventId(), events: [], toast: process.env.APEX_AICC_TOAST !== "0" });
  const events = aiccEvents({ after: Number(after) || 0, limit: 10 }).filter((e) => e.kind === "done" || e.kind === "attention" || e.kind === "message");
  return NextResponse.json({ last: lastEventId(), events, toast: process.env.APEX_AICC_TOAST !== "0" });
}
