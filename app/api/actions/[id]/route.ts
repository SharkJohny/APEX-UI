import { NextResponse } from "next/server";
import { z } from "zod";
import { decideAction } from "@/server/actions";
import { isLoopback } from "@/lib/localOnly";
import "@/server/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  decision: z.enum(["approve", "reject"]),
  edits: z.record(z.string(), z.unknown()).optional(),
});

/* POST { decision, edits? } → approve (runs the executor) or reject; returns the updated row. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Neplatné id akce." }, { status: 400 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const body = Body.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "Očekávám { decision: 'approve' | 'reject', edits?: {…} }." }, { status: 400 });
  try {
    return NextResponse.json(await decideAction(id, body.data.decision, body.data.edits));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
