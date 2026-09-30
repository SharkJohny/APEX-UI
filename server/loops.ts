import { all, get, run as dbRun } from "./db";
import { detectProviders } from "./llm";
import { runSpecialist } from "./orchestrator";
import type { AgentKey } from "@/lib/roster";

/* Loops: scheduled agent jobs that survive restarts. Each firing claims a
 * (loop, period) row in loop_runs BEFORE the agent runs - the UNIQUE key
 * makes a restart (or a second bundle) unable to fire the same period twice.
 * Times are Europe/Prague wall clock. A run missed by more than three hours
 * (server was off) is skipped, not fired late. */

export type LoopRow = { id: string; name: string; agent: string; prompt: string; schedule: string; enabled: number; speak: number };
export type LoopRunRow = { id: number; loop_id: string; period: string; job_id: number | null; status: string; started_at: string; finished_at: string | null };

const TZ = "Europe/Prague";
const MISSED_WINDOW_MIN = 180;
const TICK_MS = 60_000;

const SEED: Omit<LoopRow, "enabled" | "speak">[] = [
  {
    id: "morning_brief",
    name: "Ranní brífink",
    agent: "chief_of_staff",
    schedule: "daily 08:00",
    prompt: `Připrav ranní brífink na dnešek. Projdi:
1) dnešní a zpožděné úkoly (tasks_list),
2) dnešní kalendář (calendar_list),
3) nepřečtenou důležitou poštu za poslední den (gmail_search s dotazem "is:unread newer_than:1d"),
4) leady, které stojí nebo potřebují další krok (crm_pipeline).
Pokud některý zdroj není připojený nebo nástroj selže, prostě ho přeskoč a krátce to zmiň.
Výstup: stručný brífink seřazený podle priority – co dnes udělat jako první, na co nezapomenout, co počká. Nic neodesílej.`,
  },
  {
    id: "weekly_review",
    name: "Týdenní revize",
    agent: "strategist",
    schedule: "weekly mon 09:00",
    prompt: `Udělej týdenní revizi firmy. Projdi pipeline obchodů (crm_pipeline), finanční souhrn (finance_summary), stav úkolů a projektů (tasks_list, projects_list).
Shrň: co se minulý týden povedlo, co vázne, rizika a příležitosti. Navrhni 3–5 konkrétních priorit na tento týden s odůvodněním. Opírej se jen o data z nástrojů.`,
  },
  {
    id: "lead_followups",
    name: "Follow-upy leadů",
    agent: "sales",
    schedule: "daily 10:00",
    prompt: `Najdi leady, které potřebují follow-up (crm_pipeline, crm_*): prošlé nebo dnešní datum dalšího kroku, dlouho bez změny, nabídky bez odpovědi.
Pro každý napiš krátký koncept follow-up zprávy (česky, přirozeně, konkrétně). Koncepty jen vrať jako text – nic neodesílej.
Když žádný lead follow-up nepotřebuje, napiš to jednou větou.`,
  },
];

type State = { seeded?: boolean; started?: boolean; busy?: boolean; timer?: ReturnType<typeof setInterval> };
const g = globalThis as { __apexLoops?: State };
const state: State = (g.__apexLoops ??= {});

function ensureSeeded() {
  if (state.seeded) return;
  for (const l of SEED) {
    dbRun("INSERT OR IGNORE INTO loops (id, name, agent, prompt, schedule, enabled, speak) VALUES (?,?,?,?,?,0,0)",
      l.id, l.name, l.agent, l.prompt, l.schedule);
  }
  state.seeded = true;
}

/* ── schedule syntax ── */

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type Schedule =
  | { kind: "daily"; minute: number }
  | { kind: "weekly"; day: number; minute: number } // day: 1 = Monday … 7 = Sunday
  | { kind: "every"; n: number };

function hhmm(s: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function parseSchedule(raw: string): Schedule | null {
  const p = raw.trim().toLowerCase().split(/\s+/);
  if (p[0] === "daily" && p.length === 2) {
    const minute = hhmm(p[1]);
    return minute === null ? null : { kind: "daily", minute };
  }
  if (p[0] === "weekly" && p.length === 3) {
    const day = DAYS.indexOf(p[1] as (typeof DAYS)[number]);
    const minute = hhmm(p[2]);
    return day < 0 || minute === null ? null : { kind: "weekly", day: day + 1, minute };
  }
  if (p[0] === "every" && p.length === 2) {
    const m = /^(\d+)m$/.exec(p[1]);
    const n = m ? Number(m[1]) : 0;
    return n >= 15 && n <= 10080 ? { kind: "every", n } : null;
  }
  return null;
}

export const SCHEDULE_HELP = 'Rozvrh: "daily HH:MM", "weekly mon..sun HH:MM" nebo "every Nm" (N ≥ 15), čas Europe/Prague.';

/* ── Prague wall clock ── */

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
});

function local(d: Date) {
  const parts = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const y = Number(parts.year), mo = Number(parts.month), da = Number(parts.day);
  return {
    y, mo, da,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: DAYS.indexOf(parts.weekday.toLowerCase().slice(0, 3) as (typeof DAYS)[number]) + 1,
    date: `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`,
  };
}

function isoWeek(y: number, mo: number, da: number): string {
  const t = new Date(Date.UTC(y, mo - 1, da));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/* The period a schedule is in at `now`, and whether it is due right now
 * (scheduled time passed, still inside the missed-run window). */
export function currentPeriod(s: Schedule, now: Date): { period: string; due: boolean } {
  if (s.kind === "every") return { period: `every-${Math.floor(now.getTime() / (s.n * 60_000))}`, due: true };
  const l = local(now);
  const late = l.minute - s.minute;
  const inWindow = late >= 0 && late <= MISSED_WINDOW_MIN;
  if (s.kind === "daily") return { period: l.date, due: inWindow };
  return { period: isoWeek(l.y, l.mo, l.da), due: inWindow && l.weekday === s.day };
}

/* Due check + claim in one step. Returns the loop_runs id when this caller
 * won the period, null when not due or already claimed (e.g. before a restart). */
export function claimIfDue(loop: LoopRow, now = new Date()): { runId: number; period: string } | null {
  const s = parseSchedule(loop.schedule);
  if (!s) return null;
  const { period, due } = currentPeriod(s, now);
  if (!due) return null;
  return claim(loop.id, period);
}

function claim(loopId: string, period: string): { runId: number; period: string } | null {
  const r = dbRun("INSERT OR IGNORE INTO loop_runs (loop_id, period) VALUES (?,?)", loopId, period);
  return Number(r.changes) === 1 ? { runId: Number(r.lastInsertRowid), period } : null;
}

/* ── running ── */

function pickProvider(): string | null {
  const tools = detectProviders().filter((p) => p.tools);
  return (tools.find((p) => p.id === "claude") ?? tools[0])?.id ?? null;
}

/* Loop runs of chief_of_staff (and others) inherit the chat persona rule
 * ("odpověď 1-4 věty, čte se nahlas") from the agent's stored system prompt.
 * runSpecialist already adds a depth-0 note ("Pracuješ samostatně…"); this
 * prefix additionally overrides the length constraint for scheduled runs,
 * whose output is read in the Deck, not spoken. Added at execution time so
 * the stored loop.prompt (editable in the Deck) stays untouched. */
const LOOP_TASK_PREFIX =
  "Toto je naplánovaná úloha: výstup si majitel přečte v přehledu, může být delší a strukturovaný (prostý text, bez markdownu).\n\n";

async function execute(loop: LoopRow, runId: number): Promise<void> {
  const provider = pickProvider();
  if (!provider) {
    dbRun("UPDATE loop_runs SET status = 'failed', finished_at = datetime('now') WHERE id = ?", runId);
    return;
  }
  let loopJobId: number | null = null;
  try {
    const { jobId } = await runSpecialist({
      agent: loop.agent as AgentKey,
      task: LOOP_TASK_PREFIX + loop.prompt,
      provider,
      source: `loop:${loop.id}`,
      signal: new AbortController().signal,
      // Link the job as soon as it exists so the Deck can follow it live -
      // only the loop's own top-level job, not a nested specialist it may
      // delegate to (which fires its own "job"+"running" event and would
      // otherwise overwrite loop_runs.job_id mid-run).
      emit: (ev) => {
        if (ev.t === "job" && ev.status === "running" && ev.agent === loop.agent && loopJobId === null) {
          loopJobId = ev.id;
          dbRun("UPDATE loop_runs SET job_id = ? WHERE id = ?", ev.id, runId);
        }
      },
    });
    dbRun("UPDATE loop_runs SET status = 'done', job_id = ?, finished_at = datetime('now') WHERE id = ?", jobId, runId);
  } catch {
    dbRun("UPDATE loop_runs SET status = 'failed', job_id = ?, finished_at = datetime('now') WHERE id = ?", loopJobId, runId);
  }
}

async function tick() {
  if (state.busy) return;
  state.busy = true;
  try {
    ensureSeeded();
    for (const loop of all<LoopRow>("SELECT * FROM loops WHERE enabled = 1 ORDER BY id")) {
      const c = claimIfDue(loop);
      if (c) await execute(loop, c.runId);
    }
  } catch (e) {
    console.error("[apex loops] tick failed:", e);
  } finally {
    state.busy = false;
  }
}

/* Start the minute ticker once per process (HMR and separate route bundles
 * share globalThis). Runs left 'running' by a previous process are closed. */
export function startScheduler() {
  if (state.started) return;
  state.started = true;
  try {
    ensureSeeded();
    dbRun(`UPDATE jobs SET status = 'failed', output = 'Přerušeno restartem serveru.', finished_at = datetime('now')
           WHERE status = 'running' AND id IN (SELECT job_id FROM loop_runs WHERE status = 'running')`);
    dbRun("UPDATE loop_runs SET status = 'failed', finished_at = datetime('now') WHERE status = 'running'");
  } catch (e) {
    console.error("[apex loops] startup cleanup failed:", e);
  }
  state.timer = setInterval(() => void tick(), TICK_MS);
  state.timer.unref?.();
  setTimeout(() => void tick(), 5_000).unref?.();
}

/* Manual run (Deck / tool): ignores enabled and schedule; fire-and-forget. */
export function runLoopNow(id: string): { runId: number; period: string } {
  const loop = getLoop(id);
  if (!loop) throw new Error(`Smyčka ${id} neexistuje.`);
  if (!pickProvider()) throw new Error("Chybí poskytovatel s nástroji (Claude nebo Codex CLI).");
  const c = claim(loop.id, `manual-${Date.now()}`);
  if (!c) throw new Error("Spuštění se nepodařilo zaznamenat, zkus to znovu.");
  void execute(loop, c.runId);
  return c;
}

/* ── data access ── */

export function listLoops(): LoopRow[] {
  ensureSeeded();
  return all<LoopRow>("SELECT * FROM loops ORDER BY id");
}

export function getLoop(id: string): LoopRow | undefined {
  ensureSeeded();
  return get<LoopRow>("SELECT * FROM loops WHERE id = ?", id);
}

export function loopRuns(loopId: string, limit = 10): LoopRunRow[] {
  return all<LoopRunRow>("SELECT * FROM loop_runs WHERE loop_id = ? ORDER BY id DESC LIMIT ?", loopId, limit);
}

export function updateLoop(id: string, patch: { enabled?: boolean; schedule?: string; prompt?: string; speak?: boolean }): LoopRow {
  const loop = getLoop(id);
  if (!loop) throw new Error(`Smyčka ${id} neexistuje.`);
  if (patch.schedule !== undefined && !parseSchedule(patch.schedule)) throw new Error(`Neplatný rozvrh "${patch.schedule}". ${SCHEDULE_HELP}`);
  if (patch.prompt !== undefined && !patch.prompt.trim()) throw new Error("Zadání smyčky nesmí být prázdné.");
  dbRun("UPDATE loops SET enabled = ?, schedule = ?, prompt = ?, speak = ? WHERE id = ?",
    patch.enabled === undefined ? loop.enabled : Number(patch.enabled),
    patch.schedule === undefined ? loop.schedule : patch.schedule.trim().toLowerCase().replace(/\s+/g, " "),
    patch.prompt === undefined ? loop.prompt : patch.prompt.trim(),
    patch.speak === undefined ? loop.speak : Number(patch.speak),
    id);
  return getLoop(id)!;
}
