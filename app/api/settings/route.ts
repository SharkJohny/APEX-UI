import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import { clearSetting, getSettings, setSetting, SettingsError } from "@/server/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* GET → { groups } (secrets only as set/masked).
 * POST { key, value } | { key, clear: true } → { ok, field, warning? }. */
export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  return NextResponse.json(await getSettings());
}

export async function POST(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  let body: { key?: unknown; value?: unknown; clear?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Neplatný JSON." }, { status: 400 });
  }
  if (!body || typeof body.key !== "string") return NextResponse.json({ error: "Chybí klíč nastavení." }, { status: 400 });
  try {
    if (body.clear === true) return NextResponse.json({ ok: true, ...(await clearSetting(body.key)) });
    if (body.value === undefined) return NextResponse.json({ error: "Chybí hodnota (nebo clear: true)." }, { status: 400 });
    return NextResponse.json({ ok: true, ...(await setSetting(body.key, body.value)) });
  } catch (e) {
    if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[apex] settings save failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Uložení nastavení selhalo." }, { status: 500 });
  }
}
