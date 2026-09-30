"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, RefreshCw, Eye, EyeOff } from "lucide-react";
import { apiJson } from "./useApexStatus";
import type { DeckSection } from "./ApexDeck";

/* Nastavení - right-side drawer where the owner sets API keys, models, voice
 * modes and integration options instead of editing .env.local. Everything is
 * rendered from GET /api/settings (groups → links, fields, actions); writes go
 * to POST /api/settings one key at a time, tests to POST /api/settings/test.
 * Secrets never come back from the server - only `set` + a masked tail.
 * Opens from the dock gear, the Deck, or the URL (?settings=<group>). After
 * every change it fires the window event "apex:settings-changed" so voice /
 * status hooks can refetch. */

type FieldType = "secret" | "text" | "bool" | "select" | "number";
type Source = "settings" | "env" | "default" | "unset";
export type SettingsField = {
  key: string; label: string; type: FieldType;
  options?: { value: string; label: string }[];
  placeholder?: string; help?: string; value?: string;
  set: boolean; masked?: string; source: Source;
};
type SettingsAction = { id: string; label: string; href?: string; test?: string };
export type SettingsGroup = {
  id: string; title: string; description?: string;
  links?: { label: string; url: string }[];
  fields: SettingsField[];
  actions?: SettingsAction[];
};

export const SETTINGS_EVENT = "apex:settings-changed";

const SOURCE_LABEL: Record<Source, string> = { settings: "Nastavení", env: ".env.local", default: "výchozí", unset: "nenastaveno" };
const ALIAS: Record<string, string> = { models: "ai", modely: "ai", mozek: "ai", hlas: "voice", crm: "raqeto", socialni: "social", obsidian: "vault" };
const TRUE_VALUES = new Set(["1", "true", "yes", "on", "ano"]);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// Durations stored in ms are edited in minutes.
const isMinutes = (f: SettingsField) => f.type === "number" && /_MS$/.test(f.key);

function saveSetting(body: { key: string; value?: string; clear?: true }) {
  return apiJson<{ ok: boolean; field?: SettingsField; warning?: string }>("/api/settings", { method: "POST", body: JSON.stringify(body) });
}

function SourceBadge({ source }: { source: Source }) {
  return <span className={`sett-src sett-src-${source}`} title="Odkud se hodnota bere">{SOURCE_LABEL[source] ?? source}</span>;
}

/* ─────────────────────────── field renderers ─────────────────────────── */

type Saver = (body: { key: string; value?: string; clear?: true }) => Promise<void>;

function SecretField({ f, save, inputId }: { f: SettingsField; save: Saver; inputId: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const cancel = () => { setEditing(false); setDraft(""); setShow(false); setErr(null); };

  const submit = async () => {
    if (!draft.trim()) { setErr("Zadej hodnotu, nebo úpravu zruš."); return; }
    setBusy(true); setErr(null);
    try { await save({ key: f.key, value: draft.trim() }); setDraft(""); setShow(false); setEditing(false); }
    catch (e) { setErr(`Uložení selhalo: ${errText(e)}`); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setErr(null);
    try { await save({ key: f.key, clear: true }); setConfirm(false); }
    catch (e) { setErr(`Smazání selhalo: ${errText(e)}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="deck-stack sett-gap6">
      {!editing && (
        <div className="deck-row deck-wrap">
          <span id={inputId} className={`deck-mono deck-grow ${f.set ? "" : "sett-dim"}`}>{f.set ? f.masked || "••••••••" : "není nastaveno"}</span>
          {!confirm && (
            <>
              <button type="button" className="deck-btn deck-btn-sm" disabled={busy} onClick={() => { setEditing(true); setConfirm(false); }} aria-label={`Změnit ${f.label}`}>
                {f.set ? "Změnit" : "Nastavit"}
              </button>
              {f.source === "settings" && (
                <button type="button" className="deck-btn deck-btn-sm" disabled={busy} onClick={() => setConfirm(true)} aria-label={`Smazat ${f.label}`}>Smazat</button>
              )}
            </>
          )}
          {confirm && (
            <span className="deck-row deck-wrap sett-confirm" role="group" aria-label="Potvrzení smazání">
              <span className="deck-meta deck-warn">Opravdu smazat? Použije se hodnota z .env.local, pokud tam je.</span>
              <button type="button" className="deck-btn deck-btn-sm sett-danger" disabled={busy} onClick={() => void clear()}>{busy ? "Mažu…" : "Ano, smazat"}</button>
              <button type="button" className="deck-btn deck-btn-sm" disabled={busy} onClick={() => setConfirm(false)}>Zpět</button>
            </span>
          )}
        </div>
      )}
      {editing && (
        <form className="deck-row deck-wrap" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <span className="sett-secret deck-grow">
            <input
              ref={inputRef} id={inputId} aria-labelledby={`${inputId}-label`} className="deck-input" type={show ? "text" : "password"}
              value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={f.placeholder || "Vlož nový klíč"}
              autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}
            />
            <button type="button" className="sett-eye" onClick={() => setShow((s) => !s)} aria-label={show ? "Skrýt hodnotu" : "Zobrazit hodnotu"} aria-pressed={show}>
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </span>
          <button type="submit" className="deck-btn deck-btn-sm deck-btn-gold" disabled={busy}>{busy ? "Ukládám…" : "Uložit"}</button>
          <button type="button" className="deck-btn deck-btn-sm" disabled={busy} onClick={cancel}>Zrušit</button>
        </form>
      )}
      {err && <p className="deck-note deck-err" role="alert">{err}</p>}
    </div>
  );
}

function TextField({ f, save, inputId, list }: { f: SettingsField; save: Saver; inputId: string; list?: string }) {
  const minutes = isMinutes(f);
  const toUi = useCallback((v?: string) => {
    if (!minutes || !v) return v ?? "";
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round((n / 60_000) * 100) / 100) : v;
  }, [minutes]);
  const current = toUi(f.value);
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setDraft(current); }, [current]);
  const dirty = draft !== current;

  const submit = async () => {
    let value = draft.trim();
    if (f.type === "number" && value) {
      const n = Number(value.replace(",", "."));
      if (!Number.isFinite(n) || n < 0) { setErr("Zadej kladné číslo."); return; }
      value = String(minutes ? Math.round(n * 60_000) : n);
    }
    setBusy(true); setErr(null);
    try { await save(value ? { key: f.key, value } : { key: f.key, clear: true }); }
    catch (e) { setErr(`Uložení selhalo: ${errText(e)}`); }
    finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true); setErr(null);
    try { await save({ key: f.key, clear: true }); }
    catch (e) { setErr(`Obnovení selhalo: ${errText(e)}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="deck-stack sett-gap6">
      <form className="deck-row deck-wrap" onSubmit={(e) => { e.preventDefault(); if (dirty) void submit(); }}>
        <input
          id={inputId} className="deck-input deck-grow sett-inp" list={list}
          type="text" inputMode={f.type === "number" ? "decimal" : undefined}
          value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={f.placeholder}
          autoComplete="off" spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Escape" && dirty) { e.stopPropagation(); setDraft(current); setErr(null); } }}
        />
        {minutes && <span className="deck-meta deck-none">min</span>}
        {dirty && <button type="submit" className="deck-btn deck-btn-sm deck-btn-gold" disabled={busy}>{busy ? "Ukládám…" : "Uložit"}</button>}
        {dirty && <button type="button" className="deck-btn deck-btn-sm" disabled={busy} onClick={() => { setDraft(current); setErr(null); }}>Zrušit</button>}
        {!dirty && f.source === "settings" && (
          <button type="button" className="deck-btn deck-btn-sm" disabled={busy} onClick={() => void reset()} title="Vrátit hodnotu z .env.local nebo výchozí">Obnovit výchozí</button>
        )}
      </form>
      {err && <p className="deck-note deck-err" role="alert">{err}</p>}
    </div>
  );
}

function BoolField({ f, save, inputId }: { f: SettingsField; save: Saver; inputId: string }) {
  const on = TRUE_VALUES.has((f.value ?? "").toLowerCase());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async () => {
    setBusy(true); setErr(null);
    try { await save({ key: f.key, value: on ? "false" : "true" }); }
    catch (e) { setErr(`Uložení selhalo: ${errText(e)}`); }
    finally { setBusy(false); }
  };
  return (
    <div className="deck-stack sett-gap6">
      <div className="deck-row">
        <button id={inputId} type="button" role="switch" aria-checked={on} aria-label={f.label} className="sett-switch" disabled={busy} onClick={() => void toggle()}>
          <span className="sett-knob" />
        </button>
        <span className="deck-meta">{busy ? "Ukládám…" : on ? "Zapnuto" : "Vypnuto"}</span>
      </div>
      {err && <p className="deck-note deck-err" role="alert">{err}</p>}
    </div>
  );
}

function SelectField({ f, save, inputId }: { f: SettingsField; save: Saver; inputId: string }) {
  const opts = f.options ?? [];
  const hasCustom = opts.some((o) => o.value === "custom");
  const value = f.value ?? "";
  const known = opts.some((o) => o.value === value && o.value !== "custom");
  const [customMode, setCustomMode] = useState(hasCustom && !known && value !== "");
  const [draft, setDraft] = useState(known ? "" : value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setCustomMode(hasCustom && !known && value !== "");
    setDraft(known ? "" : value);
  }, [value, known, hasCustom]);

  const put = async (v: string) => {
    setBusy(true); setErr(null);
    try { await save(v ? { key: f.key, value: v } : { key: f.key, clear: true }); }
    catch (e) { setErr(`Uložení selhalo: ${errText(e)}`); }
    finally { setBusy(false); }
  };
  const onSelect = (v: string) => {
    if (v === "custom") { setCustomMode(true); return; }
    setCustomMode(false);
    // The empty option ("Výchozí") is stored as a real empty override so it wins
    // over .env.local; "Obnovit výchozí" clears the override instead.
    setBusy(true); setErr(null);
    save({ key: f.key, value: v })
      .catch((e) => setErr(`Uložení selhalo: ${errText(e)}`))
      .finally(() => setBusy(false));
  };
  const selectValue = customMode ? "custom" : known ? value : value === "" ? (opts.some((o) => o.value === "") ? "" : "__none") : "__current";

  return (
    <div className="deck-stack sett-gap6">
      <div className="deck-row deck-wrap">
        <select id={inputId} className="deck-input deck-grow sett-inp" value={selectValue} disabled={busy} onChange={(e) => onSelect(e.target.value)}>
          {selectValue === "__none" && <option value="__none" disabled>– vyber –</option>}
          {selectValue === "__current" && <option value="__current" disabled>{value}</option>}
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {f.source === "settings" && !customMode && (
          <button type="button" className="deck-btn deck-btn-sm" disabled={busy} onClick={() => void put("")} title="Vrátit hodnotu z .env.local nebo výchozí">Obnovit výchozí</button>
        )}
      </div>
      {customMode && (
        <form className="deck-row deck-wrap" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void put(draft.trim()); }}>
          <label className="visually-hidden" htmlFor={`${inputId}-custom`}>{f.label} – vlastní hodnota</label>
          <input
            id={`${inputId}-custom`} className="deck-input deck-grow sett-inp deck-mono" value={draft}
            onChange={(e) => setDraft(e.target.value)} placeholder="Přesné ID modelu, např. claude-opus-5-5"
            autoComplete="off" spellCheck={false}
          />
          <button type="submit" className="deck-btn deck-btn-sm deck-btn-gold" disabled={busy || !draft.trim() || draft.trim() === value}>{busy ? "Ukládám…" : "Uložit"}</button>
        </form>
      )}
      {err && <p className="deck-note deck-err" role="alert">{err}</p>}
    </div>
  );
}

function FieldRow({ f, save, warning }: { f: SettingsField; save: Saver; warning?: string }) {
  const inputId = `sett-${f.key}`;
  // Free-text fields that come with options (e.g. codex model ids) get suggestions.
  const listId = f.type !== "select" && f.options?.length ? `${inputId}-list` : undefined;
  return (
    <div className="sett-field">
      <div className="deck-row deck-wrap">
        {f.type === "secret" || f.type === "bool"
          ? <span className="sett-label deck-grow" id={`${inputId}-label`}>{f.label}</span>
          : <label className="sett-label deck-grow" htmlFor={inputId}>{f.label}</label>}
        <SourceBadge source={f.source} />
      </div>
      <div className="sett-key deck-mono">{f.key}</div>
      {f.type === "secret" && <SecretField f={f} save={save} inputId={inputId} />}
      {(f.type === "text" || f.type === "number") && <TextField f={f} save={save} inputId={inputId} list={listId} />}
      {f.type === "bool" && <BoolField f={f} save={save} inputId={inputId} />}
      {f.type === "select" && <SelectField f={f} save={save} inputId={inputId} />}
      {listId && (
        <datalist id={listId}>
          {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </datalist>
      )}
      {warning && <p className="deck-note deck-warn" role="status">{warning}</p>}
      {f.help && <p className="deck-meta">{f.help}</p>}
    </div>
  );
}

/* ─────────────────────────── group ─────────────────────────── */

const fieldValue = (g: SettingsGroup, key: string) => g.fields.find((f) => f.key === key)?.value ?? "";

/* Plain-words summary of who thinks with which model (group "ai"). */
function AiExplainer({ g }: { g: SettingsGroup }) {
  const provider = fieldValue(g, "APEX_DEFAULT_PROVIDER");
  const cli = /codex|openai|chatgpt/i.test(provider) ? "CODEX" : "CLAUDE";
  const model = (role: "CHIEF" | "SPECIALIST") => {
    if (provider === "openai-api" || provider === "openai_api") return fieldValue(g, "OPENAI_MODEL") || "výchozí model API";
    if (provider === "anthropic-api" || provider === "anthropic_api") return fieldValue(g, "ANTHROPIC_MODEL") || "výchozí model API";
    return fieldValue(g, `APEX_${cli}_MODEL_${role}`) || fieldValue(g, `APEX_${cli}_MODEL`) || "výchozí model CLI";
  };
  const provLabel = provider ? g.fields.find((f) => f.key === "APEX_DEFAULT_PROVIDER")?.options?.find((o) => o.value === provider)?.label ?? provider : "automaticky";
  return (
    <div className="deck-card deck-stack sett-explain">
      <p className="deck-text">
        <strong>Chief of staff</strong> (Apex, se kterým mluvíš) plánuje, rozděluje práci a odpovídá – myslí modelem pro roli „Chief“.
        {" "}<strong>Specialisté</strong> (Finance, Sales, Research…) dostávají dílčí úkoly a používají model „Specialista“ – může být levnější a rychlejší.
      </p>
      <p className="deck-text">
        Ve výchozím stavu Apex běží přes tvoje <strong>předplatné</strong> – Claude (Claude Code) nebo ChatGPT (Codex) – bez placení za tokeny.
        Placené API klíče (OpenAI, Anthropic) jsou <strong>volitelné</strong>: hodí se pro hlas OpenAI a jako chat bez nástrojů, platí se podle spotřeby.
      </p>
      <p className="deck-meta">
        Teď: poskytovatel <span className="deck-mono">{provLabel}</span> · Chief → <span className="deck-mono">{model("CHIEF")}</span> · specialisté → <span className="deck-mono">{model("SPECIALIST")}</span>
      </p>
    </div>
  );
}

function GroupView({ g, save, warnings, onOpenDeck }: { g: SettingsGroup; save: Saver; warnings: Record<string, string>; onOpenDeck: (s: DeckSection) => void }) {
  const [tests, setTests] = useState<Record<string, { busy?: boolean; ok?: boolean; message?: string }>>({});
  useEffect(() => { setTests({}); }, [g.id]);

  const runTest = async (a: SettingsAction) => {
    setTests((t) => ({ ...t, [a.id]: { busy: true } }));
    try {
      const r = await apiJson<{ ok: boolean; message: string }>("/api/settings/test", { method: "POST", body: JSON.stringify({ target: a.test }) });
      setTests((t) => ({ ...t, [a.id]: { ok: !!r.ok, message: r.message || (r.ok ? "V pořádku." : "Test selhal.") } }));
    } catch (e) {
      setTests((t) => ({ ...t, [a.id]: { ok: false, message: errText(e) } }));
    }
  };

  const actions = [...(g.actions ?? [])];
  const deckHref = (href?: string) => href?.match(/[?&]deck=([a-z_]+)/i)?.[1] as DeckSection | undefined;
  // Contract-level shortcuts the owner expects even if the backend omits them.
  if (g.id === "raqeto" && !actions.some((a) => deckHref(a.href))) actions.push({ id: "open_crm", label: "Otevřít CRM", href: "/?deck=crm" });
  if (g.id === "google" && !actions.some((a) => a.href?.includes("/api/integrations/google/start"))) actions.push({ id: "google_connect", label: "Připojit Google", href: "/api/integrations/google/start" });

  return (
    <section className="deck-stack sett-group" aria-labelledby={`sett-g-${g.id}`}>
      <h3 id={`sett-g-${g.id}`} className="deck-h">{g.title}</h3>
      {g.description && <p className="deck-note">{g.description}</p>}
      {g.id === "ai" && <AiExplainer g={g} />}

      {!!g.links?.length && (
        <div className="deck-stack sett-gap6">
          <span className="deck-label">Odkazy do nastavení služeb</span>
          <div className="deck-row deck-wrap">
            {g.links.map((l) => (
              <a key={l.url} className="deck-btn deck-btn-sm deck-btn-cyan" href={l.url} target="_blank" rel="noopener noreferrer" aria-label={`${l.label} (otevře se v nové záložce)`}>
                {l.label} <span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {actions.length > 0 && (
        <div className="deck-stack sett-gap6">
          <div className="deck-row deck-wrap">
            {actions.map((a) => {
              const deck = deckHref(a.href);
              if (a.test) {
                const t = tests[a.id];
                return (
                  <button key={a.id} type="button" className="deck-btn deck-btn-sm deck-btn-gold" disabled={t?.busy} onClick={() => void runTest(a)}>
                    {t?.busy ? "Testuji…" : a.label}
                  </button>
                );
              }
              if (deck) return <button key={a.id} type="button" className="deck-btn deck-btn-sm" onClick={() => onOpenDeck(deck)}>{a.label}</button>;
              if (a.href && /^https?:/i.test(a.href)) {
                return (
                  <a key={a.id} className="deck-btn deck-btn-sm deck-btn-cyan" href={a.href} target="_blank" rel="noopener noreferrer" aria-label={`${a.label} (otevře se v nové záložce)`}>
                    {a.label} <span aria-hidden="true">↗</span>
                  </a>
                );
              }
              if (a.href) return <a key={a.id} className="deck-btn deck-btn-sm deck-btn-gold" href={a.href}>{a.label}</a>;
              return null;
            })}
          </div>
          {actions.filter((a) => tests[a.id]?.message).map((a) => (
            <p key={a.id} className={`deck-note ${tests[a.id].ok ? "deck-ok" : "deck-err"}`} role="status">
              {a.label}: {tests[a.id].message}
            </p>
          ))}
        </div>
      )}

      <div className="deck-stack">
        {g.fields.map((f) => <FieldRow key={f.key} f={f} save={save} warning={warnings[f.key]} />)}
        {g.fields.length === 0 && <p className="deck-note">Tahle skupina nemá žádná nastavení.</p>}
      </div>
    </section>
  );
}

/* ─────────────────────────── drawer ─────────────────────────── */

export default function ApexSettings({ group, onGroup, onClose, onOpenDeck, onChanged }: {
  group: string | null;              // null = closed, "" = open on the first group
  onGroup: (g: string) => void;
  onClose: () => void;
  onOpenDeck: (s: DeckSection) => void;
  onChanged: () => void;
}) {
  const open = group !== null;
  const [groups, setGroups] = useState<SettingsGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // ?settings=<group> → open the drawer on that group, then clean the URL.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("settings")) return;
    const raw = (url.searchParams.get("settings") || "").toLowerCase();
    onGroup(ALIAS[raw] ?? raw);
    // null state (not history.state) lets the app router adopt the new URL -
    // with its own state it would restore the param on its next update. Deferred
    // until after the router's own mount effect.
    const t = setTimeout(() => {
      const u = new URL(window.location.href);
      u.searchParams.delete("settings");
      window.history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
    }, 0);
    return () => clearTimeout(t);
  }, [onGroup]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    apiJson<{ groups: SettingsGroup[] }>("/api/settings")
      .then((d) => { if (alive) { setGroups(Array.isArray(d?.groups) ? d.groups : []); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(errText(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, n]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus the drawer on open; hand focus back to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, [open]);

  const active = groups?.find((g) => g.id === group) ?? groups?.[0] ?? null;
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [active?.id]);

  const save = useCallback<Saver>(async (body) => {
    const { field, warning } = await saveSetting(body);
    setWarnings((w) => {
      const next = { ...w };
      if (warning) next[body.key] = warning; else delete next[body.key];
      return next;
    });
    if (field) setGroups((gs) => gs?.map((g) => ({ ...g, fields: g.fields.map((f) => (f.key === field.key ? { ...f, ...field } : f)) })) ?? gs);
    setN((x) => x + 1); // refetch: other fields / links may depend on the change
    window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { key: body.key } }));
    onChanged();
  }, [onChanged]);

  if (!open) return null;

  return (
    <div className="deck sett" role="dialog" aria-modal="false" aria-labelledby="sett-title">
      <header className="deck-head">
        <h2 id="sett-title" className="deck-brand">Nastavení</h2>
        <button type="button" className="deck-icon" aria-label="Obnovit" title="Obnovit" onClick={() => setN((x) => x + 1)} disabled={loading}>
          <RefreshCw size={15} />
        </button>
        <button ref={closeRef} type="button" className="deck-icon" aria-label="Zavřít Nastavení" title="Zavřít (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {groups && groups.length > 0 && (
        <nav className="deck-tabs" aria-label="Skupiny nastavení">
          {groups.map((g) => (
            <button key={g.id} type="button" className="deck-tab" aria-current={active?.id === g.id ? "page" : undefined} onClick={() => onGroup(g.id)}>
              {g.title}
            </button>
          ))}
        </nav>
      )}
      <div ref={bodyRef} className="deck-body">
        {!groups && loading && <p className="deck-note">Načítám nastavení…</p>}
        {error && (
          <div className="deck-stack">
            <p className="deck-note deck-err" role="alert">{error}</p>
            <div><button type="button" className="deck-btn deck-btn-sm" onClick={() => setN((x) => x + 1)}>Zkusit znovu</button></div>
          </div>
        )}
        {groups && groups.length === 0 && !error && <p className="deck-note">Server nevrátil žádné skupiny nastavení.</p>}
        {active && <GroupView key={active.id} g={active} save={save} warnings={warnings} onOpenDeck={onOpenDeck} />}
        <p className="deck-meta sett-foot">Uložené hodnoty mají přednost před <span className="deck-mono">.env.local</span> a platí hned, bez restartu. Klíče se do prohlížeče nikdy neposílají – vidíš jen jejich konec.</p>
      </div>
    </div>
  );
}
