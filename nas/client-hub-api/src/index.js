import { readdirSync } from 'node:fs';
import express from 'express';
import { schemaVersion } from './db.js';
import { hubRouter } from './hubRoutes.js';
import { DELIVERABLES_DIR } from './deliverables.js';

const PORT = Number(process.env.PORT) || 8097;

const app = express();

// Requests arrive via the Cloudflare Tunnel container, never directly.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  let deliverables;
  try {
    deliverables = { ok: true, projects: readdirSync(DELIVERABLES_DIR).length };
  } catch (err) {
    deliverables = { ok: false, error: err.code };
  }
  res.json({ ok: true, schemaVersion: schemaVersion(), deliverables });
});

app.use(hubRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Malformed JSON, oversized bodies, etc. land here instead of Express's
// default HTML error page — this API never returns anything but JSON.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[client-hub-api] unhandled error:', err);
  res.status(err.status || 400).json({ error: 'bad request' });
});

app.listen(PORT, () => {
  console.log(`client-hub-api listening on ${PORT}`);
});
