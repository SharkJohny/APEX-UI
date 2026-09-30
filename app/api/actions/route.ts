import { NextResponse } from "next/server";
import { actionKinds, listActions } from "@/server/actions";
import { isLoopback } from "@/lib/localOnly";
import "@/server/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* GET → proposed outbound actions (pending first) + known action kinds. */
export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  return NextResponse.json({ actions: listActions(), kinds: actionKinds() });
}
