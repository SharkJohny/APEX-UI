import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { get, run } from "../db";
import { baseUrl } from "../llm";

/* Google OAuth (Gmail, Calendar, Drive) over raw fetch — no googleapis.
 * Tokens live in the integrations table, row 'google'. The pending OAuth
 * state + PKCE verifier live in row 'google_oauth_state' for 10 minutes.
 * Nothing here is ever returned to the browser except googleStatus(). */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
];

export const NOT_CONNECTED = "Google není připojený – připoj ho v Decku (Integrace).";

type Tokens = {
  access_token: string;
  refresh_token: string;
  expiry: number; // epoch ms
  email?: string;
  scopes: string[];
  error?: string; // set when the grant died → disconnected
};

type OAuthState = { state: string; verifier: string; expires: number };

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function redirectUri(): string {
  return `${baseUrl()}/api/integrations/google/callback`;
}

function readRow<T>(id: string): T | null {
  const row = get<{ data: string }>("SELECT data FROM integrations WHERE id = ?", id);
  if (!row) return null;
  try { return JSON.parse(row.data) as T; } catch { return null; }
}

function writeRow(id: string, data: unknown) {
  run(
    `INSERT INTO integrations (id, data, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    id, JSON.stringify(data),
  );
}

function deleteRow(id: string) {
  run("DELETE FROM integrations WHERE id = ?", id);
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function googleStatus(): { configured: boolean; connected: boolean; account?: string; scopes?: string[]; error?: string } {
  const configured = !!config();
  const t = readRow<Tokens>("google");
  if (!t) return { configured, connected: false };
  if (t.error || !t.refresh_token) return { configured, connected: false, account: t.email, error: t.error || "Chybí refresh token." };
  return { configured, connected: true, account: t.email, scopes: t.scopes };
}

/* Build the consent URL; stores a fresh CSRF state + PKCE verifier. */
export function authUrl(): string {
  const cfg = config();
  if (!cfg) throw new Error("Google není nakonfigurovaný: doplň GOOGLE_CLIENT_ID a GOOGLE_CLIENT_SECRET do .env.local a restartuj server.");
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  writeRow("google_oauth_state", { state, verifier, expires: Date.now() + 10 * 60_000 } satisfies OAuthState);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

/* One-shot: returns the PKCE verifier if the state matches and is fresh. */
function consumeState(state: string): string | null {
  const saved = readRow<OAuthState>("google_oauth_state");
  deleteRow("google_oauth_state");
  if (!saved || saved.expires < Date.now()) return null;
  const a = Buffer.from(saved.state);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b) ? saved.verifier : null;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const err = new Error(`Google OAuth: ${json.error_description || json.error || res.status}`) as Error & { code?: string };
    err.code = json.error;
    throw err;
  }
  return json;
}

/* Callback: verify state, exchange code, fetch account email, store tokens. */
export async function exchangeCode(code: string, state: string): Promise<{ email?: string }> {
  const cfg = config();
  if (!cfg) throw new Error("Google není nakonfigurovaný.");
  const verifier = consumeState(state);
  if (!verifier) throw new Error("Neplatný nebo prošlý OAuth stav – zkus připojení znovu.");
  const j = await tokenRequest({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const prev = readRow<Tokens>("google");
  const refresh = j.refresh_token || prev?.refresh_token;
  if (!refresh) throw new Error("Google nevrátil refresh token – odeber aplikaci v účtu Google a připoj znovu.");
  let email: string | undefined;
  try {
    const u = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${j.access_token}` } });
    if (u.ok) email = ((await u.json()) as { email?: string }).email;
  } catch { /* email is cosmetic */ }
  writeRow("google", {
    access_token: j.access_token,
    refresh_token: refresh,
    expiry: Date.now() + Number(j.expires_in || 3600) * 1000,
    email,
    scopes: String(j.scope || "").split(" ").filter(Boolean),
  } satisfies Tokens);
  return { email };
}

// Dedupe concurrent refreshes across route bundles / HMR reloads, like the
// other module-level registries in this codebase (e.g. server/loops.ts).
const refreshState = globalThis as { __apexGoogleRefresh?: Promise<string> | null };

async function refresh(t: Tokens): Promise<string> {
  const cfg = config();
  if (!cfg) throw new Error("Google není nakonfigurovaný (chybí GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  try {
    const j = await tokenRequest({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    });
    const next: Tokens = {
      ...t,
      access_token: j.access_token,
      refresh_token: j.refresh_token || t.refresh_token,
      expiry: Date.now() + Number(j.expires_in || 3600) * 1000,
      scopes: j.scope ? String(j.scope).split(" ").filter(Boolean) : t.scopes,
    };
    writeRow("google", next);
    return next.access_token;
  } catch (e) {
    if ((e as { code?: string }).code === "invalid_grant") {
      writeRow("google", { ...t, access_token: "", error: "Přístup ke Googlu byl odvolán nebo vypršel – připoj ho znovu." });
      throw new Error("Google přístup vypršel nebo byl odvolán – připoj Google znovu v Decku (Integrace).");
    }
    throw e;
  }
}

/* Valid access token, refreshed 60 s before expiry. */
export async function accessToken(): Promise<string> {
  const t = readRow<Tokens>("google");
  if (!t || t.error || !t.refresh_token) throw new Error(NOT_CONNECTED);
  if (t.access_token && t.expiry - 60_000 > Date.now()) return t.access_token;
  refreshState.__apexGoogleRefresh ??= refresh(t).finally(() => { refreshState.__apexGoogleRefresh = null; });
  return refreshState.__apexGoogleRefresh;
}

export function isGoogleConnected(): boolean {
  return googleStatus().connected;
}

/* Authenticated fetch against Google APIs with readable Czech errors.
 * Returns parsed JSON (or text for non-JSON bodies). */
export async function googleFetch<T = any>(url: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
  const doFetch = async (token: string) => fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  let res = await doFetch(await accessToken());
  if (res.status === 401) {
    // Token may have been revoked early; force one refresh and retry.
    const t = readRow<Tokens>("google");
    if (t && !t.error) res = await doFetch(await refresh(t));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body.slice(0, 300);
    let reason = "";
    try {
      const j = JSON.parse(body);
      msg = j.error?.message || j.error_description || msg;
      reason = j.error?.errors?.[0]?.reason || j.error?.status || "";
    } catch { /* not JSON */ }
    if (res.status === 401) throw new Error("Google odmítl přihlášení (401) – připoj Google znovu v Decku (Integrace).");
    if (res.status === 403 && /insufficient|scope/i.test(`${reason} ${msg}`)) {
      throw new Error("Google: chybí oprávnění (scope) pro tuto operaci – odpoj a znovu připoj Google a potvrď všechna oprávnění.");
    }
    if (res.status === 429 || /rateLimit|quota|RESOURCE_EXHAUSTED/i.test(reason)) {
      throw new Error("Google: překročena kvóta / limit požadavků – zkus to za chvíli.");
    }
    if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(`${reason} ${msg}`)) {
      throw new Error(`Google: API není v projektu Google Cloud povolené – povol ho v Cloud Console. (${msg})`);
    }
    if (res.status === 404) throw new Error("Google: položka nenalezena (404).");
    throw new Error(`Google API chyba ${res.status}: ${msg}`);
  }
  if (init.raw) return (await res.text()) as T;
  const text = await res.text();
  if (!text) return null as T;
  try { return JSON.parse(text) as T; } catch { return text as T; }
}

/* Disconnect: revoke at Google (best effort) and forget the tokens. */
export async function disconnectGoogle(): Promise<{ revoked: boolean }> {
  const t = readRow<Tokens>("google");
  deleteRow("google");
  deleteRow("google_oauth_state");
  const token = t?.refresh_token || t?.access_token;
  if (!token) return { revoked: false };
  try {
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    return { revoked: res.ok };
  } catch {
    return { revoked: false };
  }
}
