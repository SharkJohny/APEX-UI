import { createHash } from "node:crypto";
import { join } from "node:path";
import { all, db, get, run } from "./db";
import { readVaultText, walkVault } from "./vault";

/* Local semantic search - no API key, offline after the first model download.
 * Vault notes, memory facts and chat history are chunked, embedded with
 * multilingual-e5-small (transformers.js / onnxruntime-node) and stored in
 * sem_chunks (+ sem_fts for keyword scoring). Search is brute-force cosine over
 * a cached per-source matrix blended with normalized BM25.
 * Models are cached under data/models (APEX_MODELS_DIR overrides). */

export type SemSource = "vault" | "memory" | "messages";
export type SemHit = { source: SemSource; ref: string; title: string; text: string; score: number };

const MODEL = "Xenova/multilingual-e5-small";
const DIM = 384;
const BATCH = 16;
const CHUNK = 900;
const OVERLAP = 150;
const RAW_MAX_CHUNKS = 40;
const FILE_MAX_CHUNKS = 200;
const RAW_WEIGHT = 0.97;
const INTERVAL_MS = 5 * 60_000;
const SOURCES: SemSource[] = ["vault", "memory", "messages"];
/* Bump when chunking changes so every vault note is re-embedded once. */
const CHUNKER_VERSION = "2";

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;
type Matrix = { ids: number[]; refs: string[]; mat: Float32Array };
type State = {
  started: boolean;
  timer?: ReturnType<typeof setInterval>;
  extractor?: Promise<Extractor>;
  embedLock: Promise<unknown>;
  indexing: boolean;
  firstPassDone: boolean;
  lastIndexedAt?: string;
  lastPassMs?: number;
  error?: string;
  matrices: Partial<Record<SemSource, Matrix>>;
};

const g = globalThis as { __apexSemantic?: State };
const S: State = (g.__apexSemantic ??= { started: false, embedLock: Promise.resolve(), indexing: false, firstPassDone: false, matrices: {} });

/* ---------- model ---------- */

function loadExtractor(): Promise<Extractor> {
  if (!S.extractor) {
    S.extractor = (async () => {
      const tf = await import("@huggingface/transformers");
      tf.env.cacheDir = process.env.APEX_MODELS_DIR || join(process.cwd(), "data", "models");
      const pipe = await tf.pipeline("feature-extraction", MODEL, { dtype: "q8" });
      return pipe as unknown as Extractor;
    })();
    S.extractor.catch((e) => {
      S.extractor = undefined;
      S.error = `Model se nepodařilo načíst: ${e instanceof Error ? e.message : String(e)}`;
    });
  }
  return S.extractor;
}

/* Embeds texts one batch at a time (serialized so the indexer and live queries
 * don't fight over the ONNX session). Returns one normalized vector per text. */
async function embed(texts: string[]): Promise<Float32Array[]> {
  const extractor = await loadExtractor();
  const job = S.embedLock.then(async () => {
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    return texts.map((_, i) => out.data.slice(i * DIM, (i + 1) * DIM));
  });
  S.embedLock = job.catch(() => undefined);
  return job;
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/* ---------- chunking ---------- */

type Chunk = { title: string; text: string };

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/* Splits text into ~CHUNK windows with OVERLAP, preferring paragraph/line/sentence breaks. */
function windows(text: string): string[] {
  const t = text.trim();
  if (t.length <= CHUNK) return t ? [t] : [];
  const out: string[] = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + CHUNK, t.length);
    if (end < t.length) {
      const slice = t.slice(start, end);
      const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
      if (cut > CHUNK * 0.5) end = start + cut + 1;
    }
    out.push(t.slice(start, end).trim());
    if (end >= t.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return out.filter(Boolean);
}

/* Short "type | tags | related" line from YAML frontmatter; the rest is dropped. */
function frontmatterHeader(fm: string): string {
  const parts: string[] = [];
  for (const key of ["type", "tags", "related"]) {
    const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
    if (!m) continue;
    let val = m[1].trim();
    if (!val) {
      const after = fm.slice((m.index ?? 0) + m[0].length);
      const items = after.match(/^(?:\n[ \t]*-[ \t]*.*)+/);
      val = items ? items[0].split("\n").map((l) => l.replace(/^[ \t]*-[ \t]*/, "").trim()).filter(Boolean).join(", ") : "";
    }
    val = val.replace(/^\[|\]$/g, "").replace(/["']/g, "").trim();
    if (val) parts.push(`${key}: ${val}`);
  }
  return parts.join(" | ");
}

export function chunkMarkdown(path: string, raw: string, maxChunks: number): Chunk[] {
  // mail exports: drop quote markers (">> >") and collapse the blank runs they leave
  let body = raw.replace(/\r\n/g, "\n").replace(/^[ \t]*(?:>[ \t]*)+/gm, "").replace(/\n{3,}/g, "\n\n");
  let header = "";
  const fm = body.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (fm) {
    header = frontmatterHeader(fm[1]);
    body = body.slice(fm[0].length);
  }
  // sections split at #, ## and ### headings
  const sections: { heading: string; text: string }[] = [];
  let cur = { heading: "", text: "" };
  for (const line of body.split("\n")) {
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      if (cur.text.trim() || cur.heading) sections.push(cur);
      cur = { heading: h[2].trim(), text: "" };
    } else {
      cur.text += line + "\n";
    }
  }
  if (cur.text.trim() || cur.heading) sections.push(cur);
  // merge small neighbouring sections so chunks stay near CHUNK size
  const merged: { heading: string; text: string }[] = [];
  for (const s of sections) {
    const text = (s.heading ? `${s.heading}\n` : "") + s.text.trim();
    const last = merged[merged.length - 1];
    if (last && last.text.length + text.length + 2 <= CHUNK) last.text += `\n\n${text}`;
    else merged.push({ heading: s.heading, text });
  }
  const out: Chunk[] = [];
  for (const s of merged) {
    for (const w of windows(s.text)) {
      if (out.length >= maxChunks) return out;
      // skip signature/separator debris with almost no words
      if ((w.match(/\p{L}/gu)?.length ?? 0) < 40) continue;
      out.push({ title: s.heading ? `${path} › ${s.heading}` : path, text: w });
    }
  }
  if (header) {
    if (out.length) out[0].text = `[${header}]\n${out[0].text}`;
    else out.push({ title: path, text: `[${header}]` });
  }
  return out;
}

/* ---------- storage ---------- */

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function meta(key: string): string | undefined {
  return get<{ value: string }>("SELECT value FROM sem_meta WHERE key = ?", key)?.value;
}
function setMeta(key: string, value: string) {
  run("INSERT INTO sem_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

type Row = { source: SemSource; ref: string; title: string; chunk_no: number; text: string; hash: string; mtime: number };

/* Embeds rows and swaps them in atomically: delete `where` rows, insert the new
 * ones in one transaction (so a concurrent re-run of the same ref can't duplicate). */
async function replaceChunks(source: SemSource, rows: Row[], deleteSql: string, deleteArgs: unknown[]) {
  const vecs: Float32Array[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    vecs.push(...(await embed(batch.map((r) => `passage: ${r.title}\n${r.text}`))));
    await yieldLoop();
  }
  const conn = db();
  conn.exec("BEGIN");
  try {
    conn.prepare(deleteSql).run(...(deleteArgs as never[]));
    const ins = conn.prepare("INSERT INTO sem_chunks (source, ref, title, chunk_no, text, hash, mtime, vec) VALUES (?,?,?,?,?,?,?,?)");
    rows.forEach((r, i) => ins.run(r.source, r.ref, r.title, r.chunk_no, r.text, r.hash, r.mtime, toBlob(vecs[i])));
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
  delete S.matrices[source];
}

/* ---------- indexers ---------- */

async function indexVaultFile(path: string, mtime: number, force = false): Promise<void> {
  const isRaw = path.startsWith("00-raw/");
  const maxChunks = isRaw ? RAW_MAX_CHUNKS : FILE_MAX_CHUNKS;
  // big raw sources: only the head is indexed, no need to read megabytes
  const raw = readVaultText(path, maxChunks * CHUNK * 1.5);
  const hash = sha1(raw);
  const prev = get<{ hash: string }>("SELECT hash FROM sem_chunks WHERE source = 'vault' AND ref = ? LIMIT 1", path);
  if (prev && prev.hash === hash && !force) {
    run("UPDATE sem_chunks SET mtime = ? WHERE source = 'vault' AND ref = ?", mtime, path);
    return;
  }
  const rows = chunkMarkdown(path, raw, maxChunks).map((c, i): Row => ({ source: "vault", ref: path, title: c.title, chunk_no: i, text: c.text, hash, mtime }));
  await replaceChunks("vault", rows, "DELETE FROM sem_chunks WHERE source = 'vault' AND ref = ?", [path]);
}

async function indexVault(): Promise<string[]> {
  const errors: string[] = [];
  const files = walkVault();
  const stored = new Map(all<{ ref: string; mtime: number }>("SELECT ref, MAX(mtime) AS mtime FROM sem_chunks WHERE source = 'vault' GROUP BY ref").map((r) => [r.ref, r.mtime]));
  const rechunk = meta("chunker_version") !== CHUNKER_VERSION;
  const present = new Set(files.map((f) => f.path));
  for (const ref of stored.keys()) {
    if (!present.has(ref)) run("DELETE FROM sem_chunks WHERE source = 'vault' AND ref = ?", ref);
  }
  if ([...stored.keys()].some((r) => !present.has(r))) delete S.matrices.vault;
  // wiki pages first so they're searchable early; raw sources last
  const todo = files.filter((f) => rechunk || stored.get(f.path) !== f.mtimeMs)
    .sort((a, b) => Number(a.path.startsWith("00-raw/")) - Number(b.path.startsWith("00-raw/")));
  for (const f of todo) {
    try {
      await indexVaultFile(f.path, f.mtimeMs, rechunk);
    } catch (e) {
      errors.push(`${f.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (rechunk) setMeta("chunker_version", CHUNKER_VERSION);
  return errors;
}

async function indexMemory(): Promise<void> {
  const facts = all<{ id: number; subject: string; fact: string }>("SELECT id, subject, fact FROM memory_facts");
  const stored = new Map(all<{ ref: string; hash: string }>("SELECT ref, hash FROM sem_chunks WHERE source = 'memory'").map((r) => [r.ref, r.hash]));
  const live = new Set(facts.map((f) => String(f.id)));
  const gone = [...stored.keys()].filter((r) => !live.has(r));
  for (const ref of gone) run("DELETE FROM sem_chunks WHERE source = 'memory' AND ref = ?", ref);
  if (gone.length) delete S.matrices.memory;
  const changed = facts.map((f) => {
    const text = f.subject ? `${f.subject}: ${f.fact}` : f.fact;
    return { ref: String(f.id), title: f.subject || "paměť", text, hash: sha1(text) };
  }).filter((f) => stored.get(f.ref) !== f.hash);
  for (let i = 0; i < changed.length; i += BATCH) {
    const batch = changed.slice(i, i + BATCH);
    await replaceChunks("memory", batch.map((f): Row => ({ source: "memory", ref: f.ref, title: f.title, chunk_no: 0, text: f.text, hash: f.hash, mtime: 0 })),
      `DELETE FROM sem_chunks WHERE source = 'memory' AND ref IN (${batch.map(() => "?").join(",")})`, batch.map((f) => f.ref));
  }
}

/* Chat history: consecutive turns of one conversation packed into ~CHUNK
 * chunks, ref = "<conversation_id>:<first message id>". Only the tail of a
 * conversation that got new messages is re-chunked. */
async function indexMessages(): Promise<void> {
  const lastId = Number(meta("messages_last_id") ?? 0);
  const maxId = get<{ m: number | null }>("SELECT MAX(id) AS m FROM messages")?.m ?? 0;
  if (!maxId || maxId <= lastId) return;
  const convs = all<{ conversation_id: string }>("SELECT DISTINCT conversation_id FROM messages WHERE id > ? AND id <= ?", lastId, maxId);
  for (const { conversation_id: conv } of convs) {
    const tail = get<{ ref: string; chunk_no: number }>(
      "SELECT ref, chunk_no FROM sem_chunks WHERE source = 'messages' AND substr(ref, 1, ?) = ? ORDER BY chunk_no DESC LIMIT 1",
      conv.length + 1, `${conv}:`,
    );
    const fromId = tail ? Number(tail.ref.slice(conv.length + 1)) : 0;
    const startNo = tail ? tail.chunk_no : 0;
    const msgs = all<{ id: number; role: string; content: string }>(
      "SELECT id, role, content FROM messages WHERE conversation_id = ? AND id >= ? AND id <= ? ORDER BY id", conv, fromId, maxId,
    );
    const rows: Row[] = [];
    let buf = "";
    let firstId = 0;
    const flush = () => {
      if (!buf.trim()) return;
      rows.push({ source: "messages", ref: `${conv}:${firstId}`, title: `konverzace ${conv}`, chunk_no: startNo + rows.length, text: buf.trim(), hash: sha1(buf), mtime: 0 });
      buf = "";
    };
    for (const m of msgs) {
      const who = m.role === "user" ? "Majitel" : m.role === "assistant" ? "Apex" : m.role;
      for (const piece of windows(`${who}: ${m.content}`)) {
        if (buf && buf.length + piece.length + 1 > CHUNK) flush();
        if (!buf) firstId = m.id;
        buf += piece + "\n";
      }
    }
    flush();
    await replaceChunks("messages", rows,
      "DELETE FROM sem_chunks WHERE source = 'messages' AND substr(ref, 1, ?) = ? AND chunk_no >= ?", [conv.length + 1, `${conv}:`, startNo]);
  }
  setMeta("messages_last_id", String(maxId));
}

async function indexAll(): Promise<void> {
  if (S.indexing) return;
  S.indexing = true;
  const t0 = Date.now();
  const errors: string[] = [];
  try {
    await loadExtractor();
    for (const [name, fn] of [["paměť", indexMemory], ["vault", indexVault], ["konverzace", indexMessages]] as const) {
      try {
        const errs = await fn();
        if (Array.isArray(errs)) errors.push(...errs.slice(0, 5));
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    S.firstPassDone = true;
    S.lastIndexedAt = new Date().toISOString();
    S.lastPassMs = Date.now() - t0;
    S.error = errors.length ? errors.join("; ").slice(0, 1000) : undefined;
  } catch (e) {
    S.error = e instanceof Error ? e.message : String(e);
  } finally {
    S.indexing = false;
  }
}

/* ---------- public API ---------- */

/* Starts the background indexer: one pass now, then every 5 minutes. Idempotent. */
export function startSemanticIndexer(): void {
  if (S.started) return;
  S.started = true;
  const tick = () => { indexAll().catch((e) => { S.error = String(e); }); };
  setTimeout(tick, 1_000);
  S.timer = setInterval(tick, INTERVAL_MS);
  S.timer.unref?.();
}

/* Runs one full indexing pass and waits for it (used by scripts/tests). */
export async function semanticIndexNow(): Promise<void> {
  await indexAll();
}

/* Re-embeds the given vault files right away (call after vault writes). Never throws. */
export async function reindexVaultPaths(paths: string[]): Promise<void> {
  const files = new Map(walkVault().map((f) => [f.path, f.mtimeMs]));
  for (const p of paths) {
    const path = p.replace(/\\/g, "/").replace(/^\/+/, "");
    try {
      const mtime = files.get(path);
      if (mtime === undefined) {
        run("DELETE FROM sem_chunks WHERE source = 'vault' AND ref = ?", path);
        delete S.matrices.vault;
      } else {
        await indexVaultFile(path, mtime, true);
      }
    } catch (e) {
      S.error = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

export function semanticStatus(): { ready: boolean; model: string; indexed: { vault: number; memory: number; messages: number }; lastIndexedAt?: string; error?: string; indexing: boolean; lastPassMs?: number } {
  const indexed = { vault: 0, memory: 0, messages: 0 };
  let error = S.error;
  try {
    for (const r of all<{ source: SemSource; n: number }>("SELECT source, COUNT(DISTINCT ref) AS n FROM sem_chunks GROUP BY source")) {
      if (r.source in indexed) indexed[r.source] = r.n;
    }
  } catch (e) {
    error = `Index není k dispozici (restartuj server kvůli migraci): ${e instanceof Error ? e.message : String(e)}`;
  }
  return { ready: S.firstPassDone && !!S.extractor, model: MODEL, indexed, lastIndexedAt: S.lastIndexedAt, error, indexing: S.indexing, lastPassMs: S.lastPassMs };
}

function matrix(source: SemSource): Matrix {
  const cached = S.matrices[source];
  if (cached) return cached;
  const rows = all<{ id: number; ref: string; vec: Uint8Array }>("SELECT id, ref, vec FROM sem_chunks WHERE source = ?", source);
  const mat = new Float32Array(rows.length * DIM);
  rows.forEach((r, i) => {
    const bytes = r.vec.byteOffset % 4 ? r.vec.slice() : r.vec;
    mat.set(new Float32Array(bytes.buffer, bytes.byteOffset, DIM), i * DIM);
  });
  const m = { ids: rows.map((r) => r.id), refs: rows.map((r) => r.ref), mat };
  S.matrices[source] = m;
  return m;
}

/* Czech function words that would make BM25 reward any chunk containing "kdo" or "jak". */
const STOP = new Set(["kdo", "koho", "komu", "čím", "což", "jak", "jaký", "jaká", "jaké", "který", "která", "které", "kde", "kdy", "proč", "pro", "při", "nad", "pod", "před", "mezi", "jsem", "jsi", "jsou", "být", "mám", "máme", "mít", "mně", "mne", "můj", "moje", "moji", "náš", "naše", "tak", "také", "ten", "tam", "tady", "nebo", "ale", "aby", "když", "jestli", "ještě", "už", "jen", "the", "and"]);

function ftsQuery(text: string): string {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).slice(0, 12);
  return [...new Set(words)].map((w) => `"${w}"*`).join(" OR ");
}

/* Hybrid search: 0.75 * cosine + 0.25 * normalized BM25. Up to 2 chunks per ref. */
export async function semanticSearch(
  query: string,
  opts: { sources?: SemSource[]; limit?: number; pathPrefix?: string } = {},
): Promise<SemHit[]> {
  const q = query.trim();
  if (!q) return [];
  const sources = (opts.sources?.length ? opts.sources : SOURCES).filter((s) => SOURCES.includes(s));
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
  const prefix = opts.pathPrefix?.replace(/^\/+/, "");
  const [qv] = await embed([`query: ${q}`]);

  // keyword scores, normalized so the best match of this query = 1
  const bm = new Map<number, number>();
  const fq = ftsQuery(q);
  if (fq) {
    const hits = all<{ id: number; b: number }>(
      `SELECT c.id AS id, bm25(sem_fts) AS b FROM sem_fts JOIN sem_chunks c ON c.id = sem_fts.rowid
       WHERE sem_fts MATCH ? AND c.source IN (${sources.map(() => "?").join(",")}) ORDER BY b LIMIT 300`, fq, ...sources,
    );
    const best = Math.min(...hits.map((h) => h.b), -1e-9);
    for (const h of hits) bm.set(h.id, h.b / best);
  }

  const scored: { id: number; ref: string; source: SemSource; score: number }[] = [];
  for (const source of sources) {
    const m = matrix(source);
    for (let i = 0; i < m.ids.length; i++) {
      if (prefix && (source !== "vault" || !m.refs[i].startsWith(prefix))) continue;
      let dot = 0;
      const off = i * DIM;
      for (let d = 0; d < DIM; d++) dot += m.mat[off + d] * qv[d];
      let score = 0.75 * dot + 0.25 * (bm.get(m.ids[i]) ?? 0);
      // curated wiki pages beat the raw sources they were distilled from (SCHEMA §5)
      if (source === "vault" && m.refs[i].startsWith("00-raw/")) score *= RAW_WEIGHT;
      scored.push({ id: m.ids[i], ref: m.refs[i], source, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const perRef = new Map<string, number>();
  const picked: typeof scored = [];
  for (const s of scored) {
    const key = `${s.source}\u0000${s.ref}`;
    const n = perRef.get(key) ?? 0;
    if (n >= 2) continue;
    perRef.set(key, n + 1);
    picked.push(s);
    if (picked.length >= limit) break;
  }
  return picked.map((p) => {
    const row = get<{ title: string; text: string }>("SELECT title, text FROM sem_chunks WHERE id = ?", p.id);
    const text = row?.text ?? "";
    return {
      source: p.source,
      ref: p.ref,
      title: row?.title ?? p.ref,
      text: text.length > 700 ? text.slice(0, 700) + "…" : text,
      score: Math.round(p.score * 1000) / 1000,
    };
  });
}
