/* Apex's routes run on the user's personal subscriptions and accounts, so they
 * must only answer this machine — never another device on the LAN — and only
 * the Apex page itself: a foreign website open in the same browser must not be
 * able to fire requests at 127.0.0.1 (CSRF / DNS rebinding). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"]);

function localHost(h: string): boolean {
  return LOCAL_HOSTS.has(h.trim().toLowerCase());
}

export function isLoopback(request: Request): boolean {
  const host = (request.headers.get("host") || "").replace(/:\d+$/, "");
  if (!localHost(host)) return false;

  const fwd = request.headers.get("x-forwarded-for");
  if (fwd && !fwd.split(",").every(localHost)) return false;

  // Browsers label every request; only the Apex page itself (same origin, same
  // port - another local dev server is "same-site" but not same-origin) or a
  // direct navigation may pass. The MCP bridge / curl send neither header.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== `http://${request.headers.get("host")}`) return false;

  // No-preflight "simple" POSTs (text/plain forms) are how CSRF gets in.
  if (request.method === "POST" && !(request.headers.get("content-type") || "").includes("application/json")) return false;
  return true;
}

/* Host-only check for top-level navigations that legitimately arrive from
 * another site (the Google OAuth redirect). Such routes must carry their own
 * CSRF protection (OAuth state + PKCE). */
export function isLocalHostRequest(request: Request): boolean {
  return localHost((request.headers.get("host") || "").replace(/:\d+$/, ""));
}
