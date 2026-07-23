# Infrastructure Reference: Bunny.net & GitHub Integrations

## 🎥 1. Bunny Stream Token Authentication (Video Security)

> ⚠️ **SECURITY — READ FIRST.** Stream tokens must be signed **server-side, inside a Bunny Edge Script**, never in the browser. Signing in client JS ships the security key to every viewer and defeats token authentication entirely. The security key must **never** be committed to this repo (Bunny mirrors it to the public site).
>
> 🔴 **Action required (cannot be automated):** the previous key was committed to git history and is therefore compromised. **Rotate it now** in the Bunny dashboard (Stream → Security → regenerate Token Authentication Key), store the new value **only** as an Edge Script environment variable, and treat the old one as burned.

### Target Environment Identifiers
* **Target Video Library ID:** `683470`  _(not secret — safe to keep here)_
* **Token Authentication Security Key:** `<STORED AS EDGE-SCRIPT ENV VAR — NEVER COMMIT>`

### Reference Implementation — SERVER SIDE (Bunny Edge Script)
*The key stays on the edge. The browser calls this endpoint and gets back a ready-signed URL; it never sees the key.*

```javascript
// edge: /sign-stream  (Bunny Edge Script)
import * as BunnySDK from "@bunny.net/edgescript-sdk";

BunnySDK.net.http.serve(async (request) => {
  const securityKey = Bunny.env.STREAM_TOKEN_KEY;          // env var, NOT in source
  const { videoPath, ttl = 3600 } = await request.json();  // e.g. '/play/683470'
  const expires = Math.floor(Date.now() / 1000) + ttl;

  const data = new TextEncoder().encode(securityKey + videoPath + expires);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const token = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return new Response(JSON.stringify({ url: `${videoPath}?token=${token}&expires=${expires}` }), {
    headers: { 'Content-Type': 'application/json' }
  });
});
```

### Reference Implementation — CLIENT SIDE (no secret present)
```javascript
// browser: request a pre-signed URL; the key is never here
async function getSignedStreamUrl(videoPath) {
  const r = await fetch('/sign-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoPath })
  });
  const { url } = await r.json();
  return url; // feed into the Bunny Stream player
}
```
