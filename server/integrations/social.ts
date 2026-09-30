/* Publishing to social networks through their official APIs. Config comes
 * only from env (.env.local) - never from the browser. Secrets never leave
 * this module: only ids/urls/booleans are returned to callers. */

type NetworkResult = { ok: boolean; name?: string; error?: string };
type StatusEntry = { configured: boolean };

const FB_API = "https://graph.facebook.com/v21.0";

function fbPageId() { return process.env.FB_PAGE_ID || ""; }
function fbPageToken() { return process.env.FB_PAGE_TOKEN || ""; }
function igUserId() { return process.env.IG_USER_ID || ""; }
function igToken() { return process.env.IG_TOKEN || fbPageToken(); }
function liToken() { return process.env.LINKEDIN_TOKEN || ""; }
function liAuthorUrn() { return process.env.LINKEDIN_AUTHOR_URN || ""; }
function liVersion() { return process.env.LINKEDIN_VERSION || "202409"; }

/* Turn a Graph/LinkedIn error body into a readable Czech message. */
function readableError(status: number, body: string): string {
  let parsed: any = null;
  try { parsed = JSON.parse(body); } catch { /* not JSON */ }
  const message: string | undefined = parsed?.error?.message || parsed?.message;
  const code: number | undefined = parsed?.error?.code;
  if (code === 190) return "Přístupový token expiroval nebo je neplatný - je potřeba ho obnovit.";
  if (message) return `Chyba poskytovatele (${status}): ${message}`;
  return `Chyba poskytovatele (${status}): ${body.slice(0, 200) || "bez podrobností"}`;
}

async function fbCall(path: string, params: Record<string, string>): Promise<any> {
  const url = `${FB_API}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(readableError(res.status, text));
  return JSON.parse(text);
}

/* ── Facebook Page ── */

async function publishFacebook(text: string, imageUrl?: string, link?: string): Promise<string> {
  const pageId = fbPageId();
  const token = fbPageToken();
  if (!pageId || !token) throw new Error("Facebook není nastavený (FB_PAGE_ID / FB_PAGE_TOKEN).");
  if (imageUrl) {
    const data = await fbCall(`/${pageId}/photos`, { url: imageUrl, caption: text, access_token: token });
    return `Facebook post id ${data.post_id || data.id} - https://facebook.com/${data.post_id || data.id}`;
  }
  const params: Record<string, string> = { message: text, access_token: token };
  if (link) params.link = link;
  const data = await fbCall(`/${pageId}/feed`, params);
  return `Facebook post id ${data.id} - https://facebook.com/${data.id}`;
}

/* ── Instagram Business ── */

async function igCreateContainer(imageUrl: string, caption: string): Promise<string> {
  const userId = igUserId();
  const token = igToken();
  const data = await fbCall(`/${userId}/media`, { image_url: imageUrl, caption, access_token: token });
  return data.id as string;
}

async function igContainerStatus(creationId: string): Promise<string> {
  const token = igToken();
  const url = `${FB_API}/${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(readableError(res.status, text));
  return (JSON.parse(text).status_code as string) || "IN_PROGRESS";
}

async function igPermalink(mediaId: string): Promise<string | undefined> {
  const token = igToken();
  try {
    const url = `${FB_API}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return (JSON.parse(await res.text()).permalink as string) || undefined;
  } catch {
    return undefined;
  }
}

async function publishInstagram(text: string, imageUrl?: string): Promise<string> {
  const userId = igUserId();
  const token = igToken();
  if (!userId || !token) throw new Error("Instagram není nastavený (IG_USER_ID / IG_TOKEN nebo FB_PAGE_TOKEN).");
  if (!imageUrl) throw new Error("Instagram vyžaduje obrázek (veřejná URL).");
  const creationId = await igCreateContainer(imageUrl, text);
  const deadline = Date.now() + 30_000;
  let status = "IN_PROGRESS";
  while (Date.now() < deadline) {
    status = await igContainerStatus(creationId);
    if (status === "FINISHED") break;
    if (status === "ERROR") throw new Error("Instagram nedokázal zpracovat obrázek.");
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status !== "FINISHED") throw new Error("Instagram nezpracoval obrázek do 30 s - zkus to znovu.");
  const data = await fbCall(`/${userId}/media_publish`, { creation_id: creationId, access_token: token });
  const permalink = await igPermalink(data.id);
  return `Instagram media id ${data.id}${permalink ? ` - ${permalink}` : ""}`;
}

/* ── LinkedIn ── */

async function publishLinkedIn(text: string, link?: string): Promise<string> {
  const token = liToken();
  const author = liAuthorUrn();
  if (!token || !author) throw new Error("LinkedIn není nastavený (LINKEDIN_TOKEN / LINKEDIN_AUTHOR_URN).");
  const body: Record<string, unknown> = {
    author,
    commentary: text,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED" },
    lifecycleState: "PUBLISHED",
  };
  if (link) {
    body.content = { article: { source: link } };
  }
  const res = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "LinkedIn-Version": liVersion(),
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(body),
  });
  const text2 = await res.text();
  if (!res.ok) throw new Error(readableError(res.status, text2));
  const id = res.headers.get("x-restli-id");
  if (!id) throw new Error("LinkedIn nevrátil id příspěvku.");
  return `LinkedIn post id ${id}`;
}

/* ── Dispatch ── */

export type SocialNetwork = "facebook" | "instagram" | "linkedin";

export async function publishSocial(network: SocialNetwork, text: string, imageUrl?: string, link?: string): Promise<string> {
  if (network === "facebook") return publishFacebook(text, imageUrl, link);
  if (network === "instagram") return publishInstagram(text, imageUrl);
  if (network === "linkedin") return publishLinkedIn(text, link);
  throw new Error(`Neznámá síť ${network}.`);
}

/* ── Status + verify ── */

export function socialStatus(): Record<SocialNetwork, StatusEntry> {
  return {
    facebook: { configured: !!(fbPageId() && fbPageToken()) },
    instagram: { configured: !!(igUserId() && igToken()) },
    linkedin: { configured: !!(liToken() && liAuthorUrn()) },
  };
}

type VerifyCache = { at: number; result: Record<SocialNetwork, NetworkResult> };
const g = globalThis as { __apexSocialVerify?: VerifyCache };
const VERIFY_TTL_MS = 10 * 60 * 1000;

async function verifyFacebook(): Promise<NetworkResult> {
  const pageId = fbPageId();
  const token = fbPageToken();
  try {
    const res = await fetch(`${FB_API}/${pageId}?fields=name&access_token=${encodeURIComponent(token)}`);
    const text = await res.text();
    if (!res.ok) return { ok: false, error: readableError(res.status, text) };
    return { ok: true, name: JSON.parse(text).name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function verifyInstagram(): Promise<NetworkResult> {
  const userId = igUserId();
  const token = igToken();
  try {
    const res = await fetch(`${FB_API}/${userId}?fields=username&access_token=${encodeURIComponent(token)}`);
    const text = await res.text();
    if (!res.ok) return { ok: false, error: readableError(res.status, text) };
    return { ok: true, name: JSON.parse(text).username };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function verifyLinkedIn(): Promise<NetworkResult> {
  const token = liToken();
  try {
    const res = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: readableError(res.status, text) };
    const data = JSON.parse(text);
    return { ok: true, name: data.name || data.given_name || liAuthorUrn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function verifySocial(): Promise<Record<SocialNetwork, NetworkResult>> {
  const now = Date.now();
  if (g.__apexSocialVerify && now - g.__apexSocialVerify.at < VERIFY_TTL_MS) {
    return g.__apexSocialVerify.result;
  }
  const status = socialStatus();
  const [facebook, instagram, linkedin] = await Promise.all([
    status.facebook.configured ? verifyFacebook() : Promise.resolve<NetworkResult>({ ok: false, error: "Nenastaveno." }),
    status.instagram.configured ? verifyInstagram() : Promise.resolve<NetworkResult>({ ok: false, error: "Nenastaveno." }),
    status.linkedin.configured ? verifyLinkedIn() : Promise.resolve<NetworkResult>({ ok: false, error: "Nenastaveno." }),
  ]);
  const result: Record<SocialNetwork, NetworkResult> = { facebook, instagram, linkedin };
  g.__apexSocialVerify = { at: now, result };
  return result;
}
