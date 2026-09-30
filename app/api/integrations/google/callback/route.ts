import { NextResponse } from "next/server";
import { isLocalHostRequest } from "@/lib/localOnly";
import { exchangeCode } from "@/server/integrations/google";
import { baseUrl } from "@/server/llm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Google redirects here with ?code&state (or ?error). Exchange, store,
 * then send the owner back to the Deck's integrations tab. */
export async function GET(request: Request) {
  if (!isLocalHostRequest(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const url = new URL(request.url);
  const back = (params: Record<string, string>) =>
    NextResponse.redirect(new URL(`/?${new URLSearchParams({ deck: "integrations", ...params })}`, baseUrl()), 302);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  if (denied || !code || !state) return back({ google: "error", reason: denied || "Chybí kód nebo stav z Googlu." });
  try {
    await exchangeCode(code, state);
    return back({ google: "connected" });
  } catch (e) {
    return back({ google: "error", reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
  }
}
