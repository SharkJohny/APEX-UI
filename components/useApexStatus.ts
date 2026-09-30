"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStatus } from "@/lib/roster";

/* Live system status for the cockpit cards, the Deck badge and the
 * Integrations tab: GET /api/status, polled every 15s while the page is
 * visible and refetched whenever `refreshKey` changes (a turn produced jobs or
 * actions). Missing endpoint / errors leave the last good value in place. */

export type AgentLive = { status: AgentStatus; note?: string; jobs7d?: number; lastJobAt?: string | null };
export type ApexStatus = {
  agents: Record<string, AgentLive>;
  providers?: { id: string; label: string; kind?: string; tools?: boolean }[];
  google?: { configured: boolean; connected: boolean; account?: string; error?: string };
  social?: Record<string, { configured: boolean }>;
  vault?: { configured: boolean; path?: string; notes?: number };
  semantic?: {
    ready: boolean; model?: string; indexing?: boolean; error?: string; lastIndexedAt?: string;
    indexed?: { vault: number; memory: number; messages: number };
  };
  raqeto?: { configured: boolean; base?: string; ok?: boolean; workspace?: { id: string; name: string; slug: string | null }; scopes?: string[]; error?: string };
  raqetoQueue?: RaqetoQueueStatus;
  tts?: string;
  pendingActions?: number;
};

export type RaqetoQueueRun = {
  taskId: string; title: string; agent: string; status: "running" | "review" | "failed" | "skipped";
  at: string; finishedAt?: string; jobId?: number | null; result?: string; error?: string;
};
export type RaqetoQueueStatus = {
  enabled: boolean; lastPollAt?: string; queued: number; error?: string;
  processing?: { taskId: string; title: string; agent: string; startedAt: string };
  recent: RaqetoQueueRun[];
};

const POLL_MS = 15_000;

/* Small JSON fetch used by the Deck and cockpit: readable Czech errors, 404 = not built yet. */
export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...(init.headers || {}) } : init?.headers,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (res.status === 404 && !data?.error) throw new Error("Tahle část backendu zatím není k dispozici.");
  if (!res.ok) throw new Error(data?.error || `Chyba serveru (${res.status}).`);
  if (data && typeof data === "object" && "error" in data && data.error && !Array.isArray(data)) throw new Error(String(data.error));
  return data as T;
}

export function useApexStatus(refreshKey = 0) {
  const [status, setStatus] = useState<ApexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const s = await apiJson<ApexStatus>("/api/status");
      setStatus({ ...s, agents: s.agents || {} });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void refresh(); };
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [refresh]);

  return { status, error, refresh };
}

/* DB timestamps are UTC "YYYY-MM-DD HH:MM:SS"; show them in local time. */
export function fmtTime(ts?: string | null): string {
  if (!ts) return "";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return ts;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* Deck endpoints may answer with a bare array or wrap it; accept both. */
export function asList<T>(d: unknown, ...keys: string[]): T[] {
  if (Array.isArray(d)) return d as T[];
  if (d && typeof d === "object") {
    for (const k of [...keys, "items", "rows", "data"]) {
      const v = (d as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}
