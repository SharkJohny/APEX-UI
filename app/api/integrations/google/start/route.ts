import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import { authUrl } from "@/server/integrations/google";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* GET → 302 to Google's consent screen (JSON error when not configured). */
export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  try {
    return NextResponse.redirect(authUrl(), 302);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
