import { NextResponse } from "next/server";
import { apexStatus } from "@/server/status";
import { isLoopback } from "@/lib/localOnly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* GET → real per-agent statuses + providers, integrations, pending approvals. */
export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  try {
    return NextResponse.json(apexStatus());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
