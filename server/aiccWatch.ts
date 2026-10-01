import { all, get, run } from "./db";
import { aiccAvailable, brief, listTerminals, readRoadmap, recentSessions, type AiccTerminal } from "./integrations/aicc";

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

function record(kind: string, t: Pick<AiccTerminal, "projectName" | "id"> | null, win: string, text: string) {
  run("INSERT INTO aicc_events (kind, project, terminal_id, win, text) VALUES (?,?,?,?,?)", kind, t?.projectName ?? "", t?.id ?? "", win, text);
}

export async function aiccTick(): Promise<void> {
  if (S.busy || !enabled() || !aiccAvailable()) return;
  S.busy = true;
  try {
    const terminals = await listTerminals();
    const next: Snapshot = { terminals: new Map(terminals.map((t) => [t.id, t])), sessions: new Map(), roadmaps: new Map() };
    const prev = S.prev;
    const byCwd = new Map<string, AiccTerminal[]>();
    for (const t of terminals) byCwd.set(t.cwd, [...(byCwd.get(t.cwd) ?? []), t]);

    for (const [cwd, list] of byCwd) {
      const finishedHere: string[] = [];
      // one transcript per agent window in this folder (newest first)
      for (const s of recentSessions(cwd, list.length)) {
        if (!s.lastAssistantId) continue;
        next.sessions.set(s.file, s.finished ? s.lastAssistantId : prev?.sessions.get(s.file) ?? "");
        if (prev && s.finished && prev.sessions.get(s.file) !== s.lastAssistantId && Date.now() - s.mtime < 10 * 60_000) {
          finishedHere.push(brief(s.lastAssistant));
        }
      }
      const t = list[0];
      for (const text of finishedHere) record("done", t, winName(t), text || "dokončilo práci");
      // waits for the owner - unless the same tick already said it finished
      for (const w of list) {
        if (prev && w.attention && !prev.terminals.get(w.id)?.attention && !finishedHere.length) record("attention", w, winName(w), "čeká na tebe");
      }
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
  const rows = all<AiccEvent>("SELECT * FROM aicc_events WHERE chief_seen = 0 AND kind IN ('done','attention','roadmap') ORDER BY id DESC LIMIT 8").reverse();
  if (!rows.length) return "";
  run("UPDATE aicc_events SET chief_seen = 1 WHERE id <= ? AND chief_seen = 0", rows[rows.length - 1].id);
  const lines = rows.map((r) => `- ${r.created_at.slice(11, 16)} ${r.win}: ${r.text}`);
  return `Novinky z oken v AI Command Center (od minula; podrobnosti aicc_window, poslat zprávu do okna jen návrhem propose_aicc_send):\n${lines.join("\n")}`;
}

export function lastEventId(): number {
  return get<{ m: number | null }>("SELECT MAX(id) AS m FROM aicc_events")?.m ?? 0;
}
