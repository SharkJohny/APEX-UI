import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import { disconnectGoogle, googleStatus } from "@/server/integrations/google";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* POST → revoke the token at Google (best effort) and forget it locally. */
export async function POST(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const { revoked } = await disconnectGoogle();
  return NextResponse.json({ ok: true, revoked, status: googleStatus() });
}
