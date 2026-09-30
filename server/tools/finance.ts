import { z } from "zod";
import { defineTool } from "./registry";
import { all, get } from "../db";

/* Finance: revenue summaries, quote sanity-checks, and cross-cutting
 * analytics over CRM / tasks / llm usage. */

const PIPELINE_WEIGHT: Record<string, number> = { quote: 0.5, enquiry: 0.1 };

/* [start, end) as YYYY-MM-DD, `offset` periods back from the current one.
 * Built from local wall-clock parts (not UTC) so periods line up with the
 * owner's actual "this month" / "this year", and formatted from those local
 * parts rather than toISOString(), which would shift near midnight UTC. */
function periodRange(period: "month" | "quarter" | "year" | "all", offset: number): { start: string; end: string } | null {
  if (period === "all") return null;
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const ymd = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  if (period === "month") {
    const start = new Date(y, m - offset, 1);
    const end = new Date(y, m - offset + 1, 1);
    return { start: ymd(start), end: ymd(end) };
  }
  if (period === "quarter") {
    const q = Math.floor(m / 3);
    const start = new Date(y, (q - offset) * 3, 1);
    const end = new Date(y, (q - offset + 1) * 3, 1);
    return { start: ymd(start), end: ymd(end) };
  }
  const start = new Date(y - offset, 0, 1);
  const end = new Date(y - offset + 1, 0, 1);
  return { start: ymd(start), end: ymd(end) };
}

function revenueFor(range: { start: string; end: string } | null): { revenue: number; count: number } {
  const row = range
    ? get<{ revenue: number; count: number }>(
        "SELECT COALESCE(SUM(amount),0) AS revenue, COUNT(*) AS count FROM payments WHERE paid_at >= ? AND paid_at < ?",
        range.start, range.end,
      )
    : get<{ revenue: number; count: number }>("SELECT COALESCE(SUM(amount),0) AS revenue, COUNT(*) AS count FROM payments");
  return row ?? { revenue: 0, count: 0 };
}

function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

defineTool({
  name: "finance_summary",
  description: "Souhrn tržeb za období (z plateb), váženou hodnotu pipeline a srovnání s předchozím obdobím.",
  input: {
    period: z.enum(["month", "quarter", "year", "all"]).describe("Období: month, quarter, year nebo all (celá historie)."),
    offset: z.number().int().min(0).default(0).describe("Kolik období zpátky (0 = aktuální)."),
  },
  node: "finance",
  handler: ({ period, offset }) => {
    const range = periodRange(period, offset);
    const current = revenueFor(range);
    const avg = current.count ? Math.round((current.revenue / current.count) * 100) / 100 : 0;

    const pipelineRows = all<{ stage: string; currency: string; value: number }>(
      "SELECT stage, currency, COALESCE(SUM(value),0) AS value FROM leads WHERE stage IN ('enquiry','quote') GROUP BY stage, currency",
    );
    const pipelineWeighted: Record<string, number> = {};
    for (const row of pipelineRows) {
      const weight = PIPELINE_WEIGHT[row.stage] ?? 0;
      pipelineWeighted[row.currency] = Math.round(((pipelineWeighted[row.currency] ?? 0) + row.value * weight) * 100) / 100;
    }

    let comparison: { previous_revenue: number; change_pct: number | null } | null = null;
    if (range) {
      const previous = revenueFor(periodRange(period, offset + 1));
      comparison = { previous_revenue: previous.revenue, change_pct: pctChange(current.revenue, previous.revenue) };
    }

    return {
      period,
      offset,
      range,
      revenue: current.revenue,
      payments_count: current.count,
      avg_payment: avg,
      pipeline_weighted_value: pipelineWeighted,
      comparison,
    };
  },
});

defineTool({
  name: "finance_quote_check",
  description: "Porovná navrhovanou hodnotu nabídky s historií vyhraných a ztracených leadů, aby šlo posoudit, jestli je nabídka reálná.",
  input: {
    value: z.number().min(0).describe("Navrhovaná hodnota nabídky."),
    description: z.string().min(1).describe("Krátký popis nabídky/zakázky pro kontext."),
  },
  node: "finance",
  handler: ({ value, description }) => {
    const stats = (stage: "won" | "lost") =>
      get<{ count: number; avg: number | null; min: number | null; max: number | null }>(
        "SELECT COUNT(*) AS count, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max FROM leads WHERE stage = ?",
        stage,
      ) ?? { count: 0, avg: null, min: null, max: null };
    const won = stats("won");
    const lost = stats("lost");
    const higherThanWonCount = get<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE stage = 'won' AND value < ?", value)?.n ?? 0;
    return {
      value,
      description,
      won,
      lost,
      higher_than_won_count: higherThanWonCount,
      note: won.count ? `Nabídka je vyšší než ${higherThanWonCount} z ${won.count} vyhraných leadů.` : "Zatím žádná historie vyhraných leadů k porovnání.",
    };
  },
});

defineTool({
  name: "analytics_overview",
  description: "Přehled metrik za posledních N dní: konverze leadů, průměrná doba poptávka→výhra, splněné vs. prošlé úkoly, úlohy podle agenta a využití LLM.",
  input: {
    days: z.number().int().min(1).max(365).default(30).describe("Počet dní zpátky."),
  },
  node: "analytics",
  handler: ({ days }) => {
    const since = `datetime('now', '-${days} days')`;

    const closed = get<{ won: number; lost: number }>(
      `SELECT
         SUM(CASE WHEN stage = 'won' THEN 1 ELSE 0 END) AS won,
         SUM(CASE WHEN stage = 'lost' THEN 1 ELSE 0 END) AS lost
       FROM leads WHERE stage IN ('won','lost') AND updated_at >= ${since}`,
    ) ?? { won: 0, lost: 0 };
    const won = closed.won ?? 0;
    const lost = closed.lost ?? 0;
    const conversionRate = won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null;

    const avgDays = get<{ avg_days: number | null }>(
      `SELECT AVG(julianday(updated_at) - julianday(created_at)) AS avg_days
       FROM leads WHERE stage = 'won' AND updated_at >= ${since}`,
    )?.avg_days ?? null;

    const tasksCompleted = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE done = 1 AND done_at >= ${since}`)?.n ?? 0;
    const tasksOverdue = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tasks WHERE done = 0 AND due_date IS NOT NULL AND date(due_date) < date('now','localtime')",
    )?.n ?? 0;

    const jobsPerAgent = all<{ agent: string; n: number }>(
      `SELECT agent, COUNT(*) AS n FROM jobs WHERE created_at >= ${since} GROUP BY agent ORDER BY n DESC`,
    );

    const llm = get<{ count: number; avg_ms: number | null; sum_cost: number | null }>(
      `SELECT COUNT(*) AS count, AVG(ms) AS avg_ms, SUM(cost_usd) AS sum_cost FROM llm_calls WHERE created_at >= ${since}`,
    ) ?? { count: 0, avg_ms: null, sum_cost: null };

    return {
      days,
      lead_conversion_rate_pct: conversionRate,
      won_count: won,
      lost_count: lost,
      avg_days_enquiry_to_won: avgDays !== null ? Math.round(avgDays * 10) / 10 : null,
      tasks_completed: tasksCompleted,
      tasks_overdue: tasksOverdue,
      jobs_per_agent: jobsPerAgent,
      llm_calls: {
        count: llm.count,
        avg_ms: llm.avg_ms !== null ? Math.round(llm.avg_ms) : null,
        sum_cost_usd: llm.sum_cost !== null ? Math.round(llm.sum_cost * 10000) / 10000 : null,
      },
    };
  },
});
