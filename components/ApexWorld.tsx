"use client";

/**
 * ApexWorld - the Apex app's CURRENT main screen, replicated for the site.
 * Layers: app-blue backdrop → clickable orb core (ring + particles, same tap
 * cycle) → ReasoningWeb (verbatim copy from the app: circuit traces, orbit
 * rings, the full asymmetric roster, ambient motes) → OrbStatusBar (equalizer
 * + STANDBY cluster at the bottom).
 * Clicking any node opens that agent's live cockpit (status, recent jobs,
 * example requests). Tapping the orb talks to Apex (useApexVoice); its voice
 * state and the backend's trace events drive the web (standby → listening →
 * processing → reasoning → speaking, consulted agents light up). The Command
 * Deck drawer holds approvals, jobs, CRM, loops, memory, guide, integrations;
 * the Nastavení drawer (dock gear, Deck, ?settings=<group>) holds keys, models
 * and voice modes. Only one of the two drawers is open at a time. Pending
 * approvals can pop up as a modal (ApexApprovalPopup, setting APEX_APPROVAL_POPUP).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import ApexHeroOrb, { type OrbState } from "./ApexHeroOrb";
import ReasoningWebJs from "./ReasoningWeb";
import ShaderBackgroundJs from "./ShaderBackground";
import OrbStatusBar from "./OrbStatusBar";
import ApexChatDock from "./ApexChatDock";
import ApexDeck, { ACTIONS_CHANGED, CopyButton, type DeckSection } from "./ApexDeck";
import ApexSettings from "./ApexSettings";
import ApexApprovalPopup from "./ApexApprovalPopup";
import ApexAiccToasts from "./ApexAiccToasts";
import { useApexVoice } from "./useApexVoice";
import { useApexStatus, apiJson, asList, fmtTime, type AgentLive } from "./useApexStatus";
import { ROSTER, ROSTER_BY_KEY, type AgentStatus } from "@/lib/roster";

const GOLD = "#f5a623";

export type NodeSel = { name: string; key: string; color: string };

// the copied .jsx defaults onSelect to null, which TS infers as `null | undefined`
const ReasoningWeb = ReasoningWebJs as unknown as React.ComponentType<{
  state?: string; trace?: unknown; mode?: string; coreless?: boolean;
  onSelect?: (n: NodeSel) => void; light?: boolean;
}>;
const ShaderBackground = ShaderBackgroundJs as unknown as React.ComponentType<{
  opacity?: number; voiceActive?: boolean; gold?: boolean;
}>;
type JobRow = { id: number; agent?: string; status?: string; source?: string; input?: string; output?: string; created_at?: string; finished_at?: string | null };

const STATUS_LINE: Record<AgentStatus, { color: string; text: string }> = {
  online: { color: "#34d399", text: "Online – Apex mu předává práci" },
  standby: { color: "#c9a84c", text: "Pohotovost – připraven, zatím bez práce" },
  integration: { color: "#7f9bb3", text: "Integrace – čeká na připojení služby" },
  offline: { color: "#f87171", text: "Offline – nedostupný" },
};
const JOB_DOT: Record<string, string> = { running: GOLD, done: "#34d399", failed: "#f87171" };

const sectionLabel = (c: string): React.CSSProperties => ({
  fontSize: 9, letterSpacing: "0.14em", color: `${c}99`, marginBottom: 8, fontFamily: "var(--font-mono)", textTransform: "uppercase",
});

/* ── AGENT COCKPIT - live card: role + caps (lib/roster), real status (/api/status),
      the agent's last jobs (/api/deck) and one-click example requests. ── */
export function AgentCockpit({ sel, live, refreshKey, onAsk, onClose }: {
  sel: NodeSel; live?: AgentLive; refreshKey: number; onAsk: (prompt: string) => void; onClose: () => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ sx: number; sy: number } | null>(null);
  const dragListenersRef = useRef<{ move: (ev: MouseEvent) => void; up: () => void } | null>(null);
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const info = ROSTER_BY_KEY[sel.key];
  const c = sel.color;
  const status = live ? STATUS_LINE[live.status] ?? STATUS_LINE.standby : null;

  useEffect(() => {
    setPos({ x: Math.max(8, Math.min(window.innerWidth - 368, window.innerWidth / 2 - 180)), y: Math.max(70, window.innerHeight * 0.12) });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    apiJson<unknown>(`/api/deck?section=jobs&agent=${encodeURIComponent(sel.key)}&limit=5`)
      .then((d) => { if (alive) { setJobs(asList<JobRow>(d, "jobs").slice(0, 5)); setJobsError(null); } })
      .catch((e: unknown) => { if (alive) setJobsError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [sel.key, refreshKey]);

  // Move focus into the window when it opens and hand it back on close, so the
  // keyboard does not stay stranded on the agent list behind it.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pos) return;
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, [pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMouseDown = (e: React.MouseEvent) => {
    if (!pos || (e.target as HTMLElement).closest("button")) return;
    dragRef.current = { sx: e.clientX - pos.x, sy: e.clientY - pos.y };
    const move = (ev: MouseEvent) => {
      if (dragRef.current) setPos({ x: ev.clientX - dragRef.current.sx, y: ev.clientY - dragRef.current.sy });
    };
    const up = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      dragListenersRef.current = null;
    };
    dragListenersRef.current = { move, up };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // The drag listeners above live on `document`, not this panel - if the
  // cockpit closes (e.g. Esc) mid-drag the panel unmounts without a mouseup
  // ever firing, leaking them. Remove them on unmount too.
  useEffect(() => () => {
    if (dragListenersRef.current) {
      document.removeEventListener("mousemove", dragListenersRef.current.move);
      document.removeEventListener("mouseup", dragListenersRef.current.up);
      dragListenersRef.current = null;
    }
  }, []);

  if (!pos) return null;
  return (
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label={`${sel.name} – přehled agenta`} style={{
      position: "fixed", left: pos.x, top: pos.y,
      width: "min(360px, 92vw)", maxHeight: `calc(100vh - ${Math.max(0, pos.y) + 16}px)`, zIndex: 60,
      display: "flex", flexDirection: "column",
      background: "rgba(4,3,12,0.92)", backdropFilter: "blur(24px)",
      border: `1px solid ${c}44`, borderRadius: 16,
      boxShadow: `0 0 40px ${c}18, 0 8px 32px rgba(0,0,0,0.6)`,
      overflow: "hidden", color: "#f0ede8", userSelect: "text",
    }}>
      {/* header - drag handle */}
      <div onMouseDown={onMouseDown} style={{
        display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", flex: "none",
        borderBottom: `1px solid ${c}22`, cursor: "grab", userSelect: "none",
        background: `linear-gradient(135deg, ${c}0a 0%, transparent 100%)`,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: "50%", background: `${c}14`,
          border: `1px solid ${c}44`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: c, boxShadow: `0 0 10px ${c}` }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.08em", color: c }}>{sel.name.toUpperCase()}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{info?.role ?? "Specialista"}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Zavřít"
          style={{ marginLeft: "auto", background: "none", border: "none", color: "rgba(255,255,255,0.45)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "6px 8px" }}
        >×</button>
      </div>

      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", minHeight: 0 }}>
        {/* live status */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <span style={{ width: 7, height: 7, marginTop: 4, flex: "none", borderRadius: "50%", background: status?.color ?? "#546a7d", boxShadow: status ? `0 0 8px ${status.color}` : "none" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 9.5, letterSpacing: "0.1em", color: "rgba(255,255,255,0.6)", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
              {status?.text ?? "Stav se načítá…"}
            </span>
            {live?.note && <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", lineHeight: 1.45 }}>{live.note}</span>}
            {live && (typeof live.jobs7d === "number" || live.lastJobAt) && (
              <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-mono)" }}>
                {typeof live.jobs7d === "number" ? `${live.jobs7d} úloh za 7 dní` : ""}
                {live.lastJobAt ? ` · naposledy ${fmtTime(live.lastJobAt)}` : ""}
              </span>
            )}
          </div>
        </div>

        {info && (
          <div>
            <div style={sectionLabel(c)}>Co umí</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {info.caps.map((cap) => (
                <div key={cap} style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
                  <div style={{ width: 3, height: 3, borderRadius: "50%", background: `${c}99`, marginTop: 7, flexShrink: 0 }} />
                  <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.65)", lineHeight: 1.55 }}>{cap}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div style={sectionLabel(c)}>Poslední úlohy</div>
          {jobsError && <p style={{ margin: 0, fontSize: 11.5, color: "rgba(255,255,255,0.45)" }}>{jobsError}</p>}
          {!jobsError && jobs === null && <p style={{ margin: 0, fontSize: 11.5, color: "rgba(255,255,255,0.45)" }}>Načítám…</p>}
          {!jobsError && jobs?.length === 0 && <p style={{ margin: 0, fontSize: 11.5, color: "rgba(255,255,255,0.45)" }}>Zatím žádná práce.</p>}
          {jobs && jobs.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {jobs.map((j) => {
                const expanded = open === j.id;
                return (
                  <li key={j.id} style={{ border: `1px solid ${c}1f`, borderRadius: 10, background: "rgba(255,255,255,0.02)" }}>
                    <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : j.id)} style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 9px", textAlign: "left",
                      background: "none", border: "none", color: "inherit", cursor: "pointer", font: "inherit",
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flex: "none", background: JOB_DOT[j.status ?? ""] ?? "#7f9bb3" }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "rgba(255,255,255,0.75)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {j.input || `Úloha #${j.id}`}
                      </span>
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-mono)", flex: "none" }}>{fmtTime(j.created_at)}</span>
                    </button>
                    {expanded && (
                      <div style={{ padding: "0 9px 9px" }}>
                        {j.output && (
                          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
                            <CopyButton text={j.output} label="Kopírovat výstup" />
                          </div>
                        )}
                        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "rgba(255,255,255,0.7)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflowY: "auto" }}>
                          {j.output || (j.status === "running" ? "Pracuje se na tom…" : "Bez výstupu.")}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {info?.asks && info.asks.length > 0 && (
          <div>
            <div style={sectionLabel(c)}>Zkus se zeptat</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {info.asks.map((task) => (
                <button type="button" key={task} onClick={() => onAsk(task)} style={{
                  padding: "4px 10px", background: `${c}0d`, border: `1px solid ${c}2a`, cursor: "pointer",
                  borderRadius: 20, font: "inherit", fontSize: 10.5, color: `${c}dd`,
                }}>{task}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── The world ── */
export default function ApexWorld() {
  const [selected, setSelected] = useState<NodeSel | null>(null);
  const [reduced, setReduced] = useState(false);
  const [deck, setDeck] = useState<DeckSection | null>(null);
  const [settings, setSettings] = useState<string | null>(null);

  // The voice loop's state drives the backdrop, the light-cast and the
  // reasoning web's activity level. A tap on the orb starts / ends listening.
  const voice = useApexVoice();
  const { status, refresh: refreshStatus } = useApexStatus(voice.dataVersion);
  const orbState: OrbState = voice.state;
  const pending = status ? status.pendingActions ?? 0 : voice.newActions;

  // Single entry point for opening an agent, shared by the SVG graph and the
  // hidden accessible list, so both routes behave identically.
  const openAgent = (n: NodeSel) => {
    setSelected(n);
  };
  const closeAgent = useCallback(() => setSelected(null), []);
  const openDeck = useCallback((section: DeckSection = "approvals") => { setSelected(null); setSettings(null); setDeck(section); }, []);
  const closeDeck = useCallback(() => setDeck(null), []);
  const openSettings = useCallback((group = "") => { setSelected(null); setDeck(null); setSettings(group); }, []);
  const closeSettings = useCallback(() => setSettings(null), []);

  // An approval decided in the chat or the Deck → refresh the pending badge.
  useEffect(() => {
    const onActions = () => { void refreshStatus(); };
    window.addEventListener(ACTIONS_CHANGED, onActions);
    return () => window.removeEventListener(ACTIONS_CHANGED, onActions);
  }, [refreshStatus]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", userSelect: "none" }}>
      {/* backdrop - the app's EXACT stack (Chat.jsx dark mode): base radial page
          gradient, waves at 0.12, the cyan breathing glow behind the orb, and the
          dark moat disc directly behind the particle cloud that makes it pop. */}
      <div aria-hidden="true" style={{
        position: "absolute", inset: 0,
        background: "radial-gradient(ellipse 95% 88% at 50% 42%, #122c43 0%, #0c1d30 38%, #07111f 72%, #050b14 100%)",
      }} />

      {/* background waves - the app's WebGL shader at the app's opacity */}
      {!reduced && (
        <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 0 }}>
          <ShaderBackground opacity={0.12} voiceActive={orbState === "speaking"} gold={false} />
        </div>
      )}

      {/* cyan LIGHT-CAST - app copy exactly: mixBlendMode screen (only ever LIFTS the
          navy, never darkens), brightens while speaking. */}
      <div aria-hidden="true" style={{
        position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none", mixBlendMode: "screen",
        background: `radial-gradient(circle at 50% 42%, rgba(13,210,255,${orbState === "speaking" ? 0.30 : 0.18}) 0%, rgba(13,170,228,0.08) 30%, rgba(8,17,31,0) 62%)`,
        transition: "background 0.6s ease",
      }} />

      {/* the reasoning web - app z-order: web sits BELOW the orb canvas, so the
          bloom haze washes over the lines near the centre, exactly like the app.
          ReasoningWeb is a verbatim copy from the Apex app: its 18 agent nodes are
          imperative SVG hit-areas with no tabindex, so the graph is marked
          decorative here and the same onSelect path is exposed through the
          equivalent list of real buttons below. `trace` lights consulted agents. */}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }}>
        <ReasoningWeb
          state={voice.webState}
          trace={voice.trace}
          mode="full"
          coreless
          onSelect={(n: NodeSel) => { openAgent(n); }}
        />
      </div>

      {/* Keyboard and screen-reader equivalent of the agent graph. */}
      <nav className="visually-hidden" aria-label="Agenti Apexu">
        <ul>
          {ROSTER.map((a) => (
            <li key={a.key}>
              <button type="button" onClick={() => openAgent({ key: a.key, name: a.name, color: a.color })}>
                {a.name} – {a.role}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* the core - painted ABOVE the web (app order); display-only, the tap target
          is the circular disc below so agent nodes near the ring stay clickable */}
      <div style={{ position: "absolute", left: "50%", top: "50%", width: "min(560px, 58vw)", height: "min(500px, 56vw, 70vh)", transform: "translate(-50%, -50%)", zIndex: 3, pointerEvents: "none" }}>
        <ApexHeroOrb state={orbState} interactive={false} />
      </div>

      {/* central tap disc - covers the ring only (nodes orbit outside it) */}
      <div
        role="button"
        tabIndex={0}
        aria-label={orbState === "listening" ? "Apex - přestat poslouchat" : "Apex - klepni a mluv"}
        onClick={voice.tap}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); voice.tap(); } }}
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
          width: "min(340px, 36vw)", height: "min(340px, 36vw)", borderRadius: "50%",
          zIndex: 4, cursor: "pointer", background: "transparent", border: "none", userSelect: "none",
        }}
      />

      {/* equalizer + STANDBY cluster */}
      <OrbStatusBar state={orbState} />

      <ApexChatDock voice={voice} pending={pending} onOpenDeck={openDeck} onOpenSettings={() => openSettings()} />

      {selected && (
        <AgentCockpit
          key={selected.key}
          sel={selected}
          live={status?.agents[selected.key]}
          refreshKey={voice.dataVersion}
          onAsk={(prompt) => { setSelected(null); void voice.send(prompt); }}
          onClose={closeAgent}
        />
      )}

      <ApexDeck
        section={deck}
        onSection={setDeck}
        onClose={closeDeck}
        status={status}
        refreshKey={voice.dataVersion}
        onChanged={refreshStatus}
        onOpenSettings={openSettings}
      />

      <ApexSettings
        group={settings}
        onGroup={openSettings}
        onClose={closeSettings}
        onOpenDeck={openDeck}
        onChanged={refreshStatus}
      />

      <ApexApprovalPopup onOpenDeck={() => openDeck("approvals")} suppressed={deck === "approvals"} />
      <ApexAiccToasts />
    </div>
  );
}
