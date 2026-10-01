import { all, get, run } from "./db";
import { aiccAvailable, brief, listTerminals, readRoadmap, readTurns, sessionOf, sessionsFor, type AiccTerminal } from "./integrations/aicc";

/* Watches the owner's AI Command Center windows and records what changed:
 * an agent finished its turn, a window waits for him, a roadmap step got
 * done, a window opened or closed. Apex learns about them (chief context +
 * tools) and the UI shows a short notification. Read-only. */

const INTERVAL_MS = 15_000;

export type AiccEvent = { id: number; kind: string; project: string; terminal_id: string; win: string; text: string; chief_seen: number; created_at: string };

type Snapshot = {
  terminals: Map<string, AiccTerminal>;
  /* transcript file → last answered message id */
  sessions: Map<string, string>;
  /* project path → done roadmap items */
  roadmaps: Map<string, Set<string>>;
};

type WatchState = { started?: boolean; busy?: boolean; timer?: ReturnType<typeof setInterval>; prev?: Snapshot; lastError?: string; lastRunAt?: string };
const g = globalThis as { __apexAicc?: WatchState };
const S: WatchState = (g.__apexAicc ??= {});

const enabled = () => process.env.APEX_AICC !== "0";
const winName = (t: AiccTerminal) => (t.title && !/^Termin[aá]l \d+$/.test(t.title) ? `${t.projectName} · ${t.title}` : t.projectName || t.cwd);

/* Every short notification Apex shows (windows, new chat messages) lands here. */
export function recordEvent(kind: string, project: string, terminalId: string, win: string, text: string) {
  run("INSERT INTO aicc_events (kind, project, terminal_id, win, text) VALUES (?,?,?,?,?)", kind, project, terminalId, win, text);
}

function record(kind: string, t: Pick<AiccTerminal, "projectName" | "id"> | null, win: string, text: string) {
  recordEvent(kind, t?.projectName ?? "", t?.id ?? "", win, text);
}

export async function aiccTick(): Promise<void> {
  if (S.busy || !enabled() || !aiccAvailable()) return;
  S.busy = true;
  try {
    const terminals = await listTerminals();
    const next: Snapshot = { terminals: new Map(terminals.map((t) => [t.id, t])), sessions: new Map(), roadmaps: new Map() };
    const prev = S.prev;
    const sessions = sessionsFor(terminals);
    archiveWindows(terminals, sessions);
    const finishedIn = new Set<string>();
    for (const t of terminals) {
      const sess = sessionOf(sessions.get(t.id));
      if (!sess?.lastAssistantId) continue;
      const answered = sess.finished && sess.status !== "busy";
      next.sessions.set(sess.file, answered ? sess.lastAssistantId : prev?.sessions.get(sess.file) ?? "");
      if (prev && answered && prev.sessions.has(sess.file) && prev.sessions.get(sess.file) !== sess.lastAssistantId && Date.now() - sess.mtime < 10 * 60_000) {
        record("done", t, winName(t), brief(sess.lastAssistant) || "dokončilo práci");
        finishedIn.add(t.id);
      }
    }
    // waits for the owner - unless the same tick already said it finished
    for (const t of terminals) {
      if (prev && t.attention && !prev.terminals.get(t.id)?.attention && !finishedIn.has(t.id)) record("attention", t, winName(t), "čeká na tebe");
    }
    for (const cwd of new Set(terminals.map((t) => t.cwd))) {
      const t = terminals.find((x) => x.cwd === cwd)!;
      const done = new Set(readRoadmap(cwd).filter((i) => i.done).map((i) => i.text));
      next.roadmaps.set(cwd, done);
      const before = prev?.roadmaps.get(cwd);
      if (before) {
        const fresh = [...done].filter((x) => !before.has(x));
        if (fresh.length) record("roadmap", t, t.projectName || cwd, fresh.length === 1 ? `hotovo: ${brief(fresh[0], 120)}` : `hotovo ${fresh.length} kroků, např. ${brief(fresh[0], 90)}`);
      }
    }
    if (prev) {
      for (const t of terminals) if (!prev.terminals.has(t.id)) record("opened", t, winName(t), "nové okno");
      for (const [id, t] of prev.terminals) if (!next.terminals.has(id)) record("closed", t, winName(t), "okno zavřeno");
    }
    S.prev = next;
    S.lastError = undefined;
  } catch (e) {
    S.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    S.busy = false;
    S.lastRunAt = new Date().toISOString();
  }
}

/* Copies new turns of every window's Claude Code session into agent_archive,
 * so Apex remembers what was asked and done in each project. */
const TURN_MAX = 4000;
function archiveWindows(terminals: AiccTerminal[], sessions: ReturnType<typeof sessionsFor>) {
  if (process.env.APEX_AICC_ARCHIVE === "0") return;
  for (const t of terminals) {
    const sess = sessionOf(sessions.get(t.id));
    if (!sess) continue;
    try {
      const pos = get<{ offset: number }>("SELECT offset FROM agent_archive_pos WHERE file = ?", sess.file)?.offset;
      const { turns, offset } = readTurns(sess.file, pos);
      const sessionId = sess.file.slice(sess.file.lastIndexOf("/") + 1, -".jsonl".length);
      for (const turn of turns) {
        run(`INSERT OR IGNORE INTO agent_archive (project, win, cwd, session_id, role, text, at, key) VALUES (?,?,?,?,?,?,?,?)`,
          t.projectName, winName(t), t.cwd, sessionId, turn.role,
          turn.text.length > TURN_MAX ? `${turn.text.slice(0, TURN_MAX)}…` : turn.text, turn.at ?? null, turn.uuid);
      }
      run(`INSERT INTO agent_archive_pos (file, offset) VALUES (?,?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset`, sess.file, offset);
    } catch (e) {
      S.lastError = `archiv ${winName(t)}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

export function startAiccWatch(): void {
  if (S.started) return;
  S.started = true;
  setTimeout(() => void aiccTick(), 5_000).unref?.();
  S.timer = setInterval(() => void aiccTick(), INTERVAL_MS);
  S.timer.unref?.();
}

export function aiccStatus() {
  return { enabled: enabled(), available: aiccAvailable(), windows: S.prev?.terminals.size ?? 0, lastRunAt: S.lastRunAt, lastError: S.lastError };
}

export function aiccEvents(opts: { after?: number; limit?: number } = {}): AiccEvent[] {
  return all<AiccEvent>("SELECT * FROM aicc_events WHERE id > ? ORDER BY id DESC LIMIT ?", opts.after ?? 0, opts.limit ?? 20).reverse();
}

/* Chief context: what changed since the chief last heard about it (short). */
export function aiccChiefBlock(): string {
  const rows = all<AiccEvent>("SELECT * FROM aicc_events WHERE chief_seen = 0 AND kind IN ('done','attention','roadmap','message') ORDER BY id DESC LIMIT 8").reverse();
  if (!rows.length) return "";
  run("UPDATE aicc_events SET chief_seen = 1 WHERE id <= ? AND chief_seen = 0", rows[rows.length - 1].id);
  const lines = rows.map((r) => `- ${r.created_at.slice(11, 16)} ${r.win}: ${r.text}`);
  return `Novinky od minula – okna v AI Command Center a nové zprávy (podrobnosti aicc_window / messages_history; do okna píšeš jen návrhem propose_aicc_send, zprávy nikdy neposíláš):\n${lines.join("\n")}`;
}

export function lastEventId(): number {
  return get<{ m: number | null }>("SELECT MAX(id) AS m FROM aicc_events")?.m ?? 0;
}
