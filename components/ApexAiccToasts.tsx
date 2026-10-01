"use client";

import { useEffect, useRef, useState } from "react";

/* Short notifications from the owner's AI Command Center windows: an agent
 * finished its work or waits for him. Polls /api/aicc/events; starts from
 * the newest event (no backlog), keeps at most 3, each fades after 12 s.
 * Setting "Oznámení změn v Apexu" (APEX_AICC_TOAST) turns them off. */

type AiccEvent = { id: number; kind: string; win: string; text: string };

const POLL_MS = 8_000;
const SHOW_MS = 12_000;

export default function ApexAiccToasts() {
  const [items, setItems] = useState<AiccEvent[]>([]);
  const last = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const poll = async () => {
      try {
        const q = last.current === null ? "" : `?after=${last.current}`;
        const d = (await (await fetch(`/api/aicc/events${q}`)).json()) as { last: number; events: AiccEvent[]; toast: boolean };
        if (!alive) return;
        const fresh = last.current === null || !d.toast ? [] : d.events;
        last.current = d.last;
        if (!fresh.length) return;
        setItems((list) => [...list, ...fresh].slice(-3));
        for (const e of fresh) {
          const t = setTimeout(() => { timers.delete(t); setItems((list) => list.filter((x) => x.id !== e.id)); }, SHOW_MS);
          timers.add(t);
        }
      } catch { /* server restarting - next poll */ }
    };
    void poll();
    const iv = setInterval(() => void poll(), POLL_MS);
    return () => { alive = false; clearInterval(iv); timers.forEach(clearTimeout); };
  }, []);

  if (!items.length) return null;
  return (
    <div className="aicc-toasts" role="status" aria-live="polite">
      {items.map((e) => (
        <div key={e.id} className={`aicc-toast aicc-${e.kind}`}>
          <span className="aicc-dot" aria-hidden />
          <span className="aicc-text"><b>{e.win}</b> – {e.text}</span>
          <button type="button" className="aicc-x" aria-label="Zavřít" onClick={() => setItems((list) => list.filter((x) => x.id !== e.id))}>×</button>
        </div>
      ))}
    </div>
  );
}
