import { NextResponse } from "next/server";
import { join } from "node:path";
import { isLoopback } from "@/lib/localOnly";
import { vaultDir, vaultStatus } from "@/server/vault";
import { readNote, searchVault } from "@/server/tools/vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Read-only view of the AI Mozek vault for the Deck:
 *   ?q=…     → top 8 notes (semantic when indexed, keyword otherwise)
 *   ?path=…  → one note (frontmatter + body) for preview
 *   (none)   → vault status
 * `abs` is the absolute file path for obsidian://open deep links. */
export async function GET(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  const path = url.searchParams.get("path")?.trim();
  const root = vaultDir();
  try {
    if (!root) return NextResponse.json({ ...vaultStatus(), error: "Vault AI Mozek není nastavený (APEX_VAULT_DIR)." }, { status: 404 });
    if (path) {
      const note = readNote(path, 60_000);
      return NextResponse.json({ ...note, abs: join(root, note.path) });
    }
    if (q) {
      if (q.length < 2) return NextResponse.json({ mode: "keyword", results: [] });
      const { mode, results } = await searchVault(q.slice(0, 300), 8);
      return NextResponse.json({ mode, results: results.map((r) => ({ ...r, abs: join(root, r.path) })) });
    }
    return NextResponse.json(vaultStatus());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
