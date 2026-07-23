import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.11.2";
import process from "node:process";

/* =============================================================================
   CLIENT HUB — Bunny Edge Script (MIDDLEWARE model, matches script #82483)
   Attached to pull zone Client-Hub-PULLZONE. Implements BUILD-PLAN §5 /hub/*.

   RUNTIME NOTES (verified against the live dashboard):
   - Middleware uses servePullZone().onOriginRequest(); returning a Response
     short-circuits and serves it directly. Returning nothing = continue to origin.
   - Env vars AND secrets are read via process.env.* (NOT Bunny.env.*).
   - All /hub/* routes are POST and set Cache-Control: no-store, so the CDN
     never caches an API response (onOriginRequest only fires on cache miss).

   REQUIRED — set these under Environment → SECRETS (not Variables):
     ADMIN_API_KEY, STORAGE_WRITE_KEY, STORAGE_READ_KEY,
     PULLZONE_TOKEN_KEY, STREAM_TOKEN_KEY
   Never inline a key in this file. Never commit a key.
   ============================================================================= */

const ZONE        = "clienthubdata";
const STORAGE_API = "https://storage.bunnycdn.com/" + ZONE + "/";
const PULL_ZONE   = "https://client-hub-pullzone.b-cdn.net/";
const CORS = {
  "Access-Control-Allow-Origin": "*", // TODO: lock to the hub origin once the domain is fixed
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/* ---------- helpers ---------- */
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// URL-safe base64 of the RAW SHA-256 bytes — the format Bunny CDN Token Authentication expects.
async function sha256Base64Url(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(str)));
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Bunny CDN URL Token Authentication (expiration based):
//   token = base64url( SHA256_raw( security_key + signed_path + expires ) )
async function signPullUrl(path, ttl = 900) {
  const key = process.env.PULLZONE_TOKEN_KEY;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const signedPath = "/" + path;
  const token = await sha256Base64Url(key + signedPath + expires);
  return PULL_ZONE + path + "?token=" + token + "&expires=" + expires;
}

async function storagePut(path, bodyString) {
  const res = await fetch(STORAGE_API + path, {
    method: "PUT",
    headers: { AccessKey: process.env.STORAGE_WRITE_KEY, "Content-Type": "application/json" },
    body: bodyString,
  });
  if (!res.ok) throw new Error("storage PUT " + path + " → " + res.status);
}

async function storageGet(path) {
  const res = await fetch(STORAGE_API + path, {
    headers: { AccessKey: process.env.STORAGE_READ_KEY },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("storage GET " + path + " → " + res.status);
  return res.text();
}
const getJson = async (path) => { const t = await storageGet(path); return t ? JSON.parse(t) : null; };

function isAdmin(request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return token && token === process.env.ADMIN_API_KEY;
}

/* ---------- route handlers ---------- */

// POST /hub/publish (admin) — body { record, priv }
async function handlePublish(request) {
  if (!isAdmin(request)) return json({ error: "unauthorized" }, 401);
  const { record, priv } = await request.json();
  if (!record || !record.id || !priv) return json({ error: "bad payload" }, 400);
  const id = record.id;

  await storagePut("records/" + id + ".json", JSON.stringify(record));
  await storagePut("private/auth/" + id + ".json", JSON.stringify(priv));

  // Email index: emailHash → [projectId]; lets /hub/auth find candidates by email.
  if (priv.clientEmail) {
    const emailHash = await sha256Hex(priv.clientEmail.trim().toLowerCase());
    const idx = (await getJson("private/email-index.json")) || {};
    idx[emailHash] = Array.from(new Set([...(idx[emailHash] || []), id]));
    await storagePut("private/email-index.json", JSON.stringify(idx));
  }
  // Invite index: token → projectId (for ?invite= onboarding).
  if (priv.inviteToken) {
    const inv = (await getJson("private/invite-index.json")) || {};
    inv[priv.inviteToken] = id;
    await storagePut("private/invite-index.json", JSON.stringify(inv));
  }
  return json({ ok: true, publishedAt: new Date().toISOString() });
}

// POST /hub/auth — { email, code } → { token, projectIds, records }
//                  { invite }      → { projectId }
async function handleAuth(request) {
  const body = await request.json();

  if (body.invite) {
    const inv = (await getJson("private/invite-index.json")) || {};
    const projectId = inv[body.invite];
    if (!projectId) return json({ error: "invalid invite" }, 404);
    // Codes are stored hashed, so onboarding does not reveal one; the client still
    // signs in with email + the code from their invitation email.
    return json({ projectId, clientCode: "" });
  }

  const email = (body.email || "").trim().toLowerCase();
  const code = String(body.code || "");
  if (!email || !/^\d{4}$/.test(code)) return json({ error: "bad request" }, 400);

  const emailHash = await sha256Hex(email);
  const idx = (await getJson("private/email-index.json")) || {};
  const candidates = idx[emailHash] || [];
  const codeHash = await sha256Hex(code);

  const projectIds = [];
  const records = {};
  for (const pid of candidates) {
    const priv = await getJson("private/auth/" + pid + ".json");
    if (priv && priv.codeHash === codeHash) {
      projectIds.push(pid);
      records[pid] = await signPullUrl("records/" + pid + ".json");
    }
  }
  if (!projectIds.length) return json({ token: null, projectIds: [] }, 200);
  const token = await sha256Hex(codeHash + emailHash + Date.now());
  return json({ token, projectIds, records });
}

// POST /hub/sign — { path } → { url }
async function handleSign(request) {
  const { path } = await request.json();
  if (!path || path.indexOf("private/") === 0) return json({ error: "forbidden path" }, 403);
  return json({ url: await signPullUrl(path) });
}

// POST /hub/notify (admin) — invitation / reset / delivery email
async function handleNotify(request) {
  if (!isAdmin(request)) return json({ error: "unauthorized" }, 401);
  const payload = await request.json();
  // TODO(provider): read the provider key from process.env and POST to the provider.
  console.log("[hub/notify]", JSON.stringify(payload));
  return json({ ok: true, dispatched: payload.kind || "unknown" });
}

/* ---------- middleware entry ----------
   Return a Response to serve it directly; return nothing to continue to origin. */
async function onOriginRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS" && path.indexOf("/hub/") === 0) {
    return new Response(null, { status: 204, headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  // Defence in depth: block the private auth area even if the Edge Rule is missing.
  if (path.indexOf("/private/") === 0) {
    return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  if (path.indexOf("/hub/") === 0) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    try {
      if (path === "/hub/publish") return await handlePublish(request);
      if (path === "/hub/auth")    return await handleAuth(request);
      if (path === "/hub/sign")    return await handleSign(request);
      if (path === "/hub/notify")  return await handleNotify(request);
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
  }

  // records/*, invoices/*, media/* → fall through to origin (gated by the
  // pull-zone Token Authentication Edge Rule).
}

/* Client pages fetch the signed records/*.json URL cross-origin (hub origin →
   pull zone). Storage responses carry no CORS header, so the browser would block
   the read. Stamp it on here rather than maintaining a separate Edge Rule. */
async function onOriginResponse(context) {
  context.response.headers.set("Access-Control-Allow-Origin", "*");
}

BunnySDK.net.http.servePullZone()
  .onOriginRequest(onOriginRequest)
  .onOriginResponse(onOriginResponse);
