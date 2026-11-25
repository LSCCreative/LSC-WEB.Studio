'use strict';

const { newId, nowIso } = require('../db');
const { normEmail, emailHolder, emailSharedWith, emailTakenReply, hasPortalLogin, moveLogin } = require('../clients');
const { readProjectRows, todayOf } = require('./projects');
const { createPortalAccess, accessStatus } = require('../portal-access');

function loadJson(row) {
  return {
    id: row.id,
    businessName: row.business_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    abn: row.abn,
    address: row.address,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* How many project matches a client card names before "and N more". */
const MATCHES_SHOWN = 2;

/**
 * opts.portal: { secret, url } — the portal's signing secret and its page's
 * address (config.hub). Without the secret, issuing a Client code answers 503.
 */
function registerClientRoutes(app, db, opts = {}) {
  const portal = opts.portal || {};
  const access = portal.secret ? createPortalAccess(db, { secret: portal.secret }) : null;
  // Typeahead: GET /api/clients?q=acme — partial, case-insensitive match on
  // business name. No query = the full list, for the editor's name check.
  app.get('/api/clients', (req, res) => {
    const q = String(req.query.q || '').trim();
    const rows = q
      ? db.prepare(`
          SELECT * FROM clients
          WHERE business_name LIKE ? COLLATE NOCASE
          ORDER BY business_name COLLATE NOCASE LIMIT 20
        `).all(`%${q}%`)
      : db.prepare('SELECT * FROM clients ORDER BY business_name COLLATE NOCASE').all();
    res.json({ ok: true, clients: rows.map(loadJson) });
  });

  /* The Clients screen (IA "Clients"): every client with its count of live
     projects. `q` also finds a client through its projects' names and UPIDs, so
     an old job can be found without remembering whose it was; `matches` names
     the projects that did it, for the card to say why it is there. */
  app.get('/api/clients/summary', (req, res) => {
    const today = todayOf(req);
    if (!today) return res.status(400).json({ error: 'today_invalid' });
    const q = String(req.query.q || '').trim().toLowerCase();
    const byClient = new Map();
    readProjectRows(db, { today }).forEach((row) => {
      const id = row.project.client.id;
      if (!id) return;
      if (!byClient.has(id)) byClient.set(id, []);
      byClient.get(id).push(row);
    });
    const all = db.prepare('SELECT * FROM clients ORDER BY business_name COLLATE NOCASE').all();
    const clients = [];
    all.forEach((c) => {
      const rows = byClient.get(c.id) || [];
      const named = !q || [c.business_name, c.contact_name, c.email].join('\n').toLowerCase().includes(q);
      const found = q && !named ? rows.filter((row) => row.jobText.includes(q)) : [];
      if (!named && !found.length) return;
      clients.push({
        ...loadJson(c),
        projectCount: rows.length,
        emailSharedWith: emailSharedWith(db, c),
        liveCount: rows.filter((row) => row.project.delivery.group === 'live').length,
        matches: found.slice(0, MATCHES_SHOWN).map(({ project }) => ({
          id: project.id,
          upid: project.upid || null,
          name: project.name,
          archived: project.delivery.badge === 'archived',
        })),
        moreMatches: Math.max(0, found.length - MATCHES_SHOWN),
      });
    });
    res.json({ ok: true, clients, total: all.length });
  });

  /* One client as the record's screens read it: what the Delete button needs to
     know, and whether their address is shared from before the rule (S13). */
  function recordJson(row) {
    return {
      ...loadJson(row),
      projectCount: db.prepare('SELECT COUNT(*) AS n FROM projects WHERE client_id = ?').get(row.id).n,
      emailSharedWith: emailSharedWith(db, row),
    };
  }

  const rowOf = (id) => db.prepare('SELECT * FROM clients WHERE id = ?').get(id);

  app.get('/api/clients/:id', (req, res) => {
    const row = rowOf(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, client: recordJson(row) });
  });

  function writeFields(body) {
    return [
      body.businessName || '', body.contactName || '', normEmail(body.email),
      body.phone || '', body.abn || '', body.address || '', body.notes || '',
    ];
  }

  /* The refusal for a new address on `existing` (null for a new client), or
     null. An address the client already has is never refused, even a shared
     one from before the rule: the save may only be changing their phone. */
  function emailRefusal(body, existing) {
    const email = normEmail(body.email);
    if (existing && email === existing.email) return null;
    if (!email) {
      return existing && hasPortalLogin(db, existing.id)
        ? {
            error: 'email_required',
            message: 'This client signs in to the portal with their email, so it can’t be left empty. Change it instead.',
          }
        : null;
    }
    const holder = emailHolder(db, email, existing && existing.id);
    return holder ? emailTakenReply(email, holder) : null;
  }

  const insert = (id, fields, now) => db.prepare(`
    INSERT INTO clients
      (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id, ...fields, now, now);

  /* Writes the record and, when the address changed, the login that follows it. */
  const update = db.transaction((existing, fields, now) => {
    db.prepare(`
      UPDATE clients SET
        business_name = ?, contact_name = ?, email = ?, phone = ?, abn = ?,
        address = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(...fields, now, existing.id);
    const email = fields[2];
    if (email && email !== existing.email) moveLogin(db, existing.id, email, now);
  });

  app.post('/api/clients', (req, res) => {
    const body = req.body || {};
    const refused = emailRefusal(body, null);
    if (refused) return res.status(409).json(refused);
    const id = newId('cl');
    insert(id, writeFields(body), nowIso());
    res.status(201).json({ ok: true, client: recordJson(rowOf(id)) });
  });

  app.put('/api/clients/:id', (req, res) => {
    const existing = rowOf(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const body = req.body || {};
    const refused = emailRefusal(body, existing);
    if (refused) return res.status(409).json(refused);
    update(existing, writeFields(body), nowIso());
    res.json({ ok: true, client: recordJson(rowOf(req.params.id)) });
  });

  // Upsert-by-business-name — used when an estimate is saved with a client
  // name that doesn't yet exist in the CRM (the "add to client list" flow).
  // Case-insensitive exact match on business name; anything else is a new row.
  app.post('/api/clients/upsert', (req, res) => {
    const body = req.body || {};
    const name = (body.businessName || '').trim();
    if (!name) return res.status(400).json({ error: 'business_name_required' });

    const existing = db.prepare(
      'SELECT * FROM clients WHERE business_name = ? COLLATE NOCASE'
    ).get(name);
    const refused = emailRefusal(body, existing || null);
    if (refused) return res.status(409).json(refused);
    const now = nowIso();

    if (existing) {
      update(existing, writeFields(body), now);
      return res.json({ ok: true, client: loadJson(rowOf(existing.id)), created: false });
    }

    const id = newId('cl');
    insert(id, writeFields(body), now);
    res.status(201).json({ ok: true, client: loadJson(rowOf(id)), created: true });
  });

  /* ── Portal access (C1) ──────────────────────────────────────────────────
     The client's one Client code and their invite. The screen that sends them
     is C6's (an invite on first publish); these are what it calls. */

  app.get('/api/clients/:id/portal', (req, res) => {
    if (!rowOf(req.params.id)) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true, access: accessStatus(db, req.params.id) });
  });

  /* A new Client code and invite link, shown once: only their hashes are kept.
     Replaces any before, signs the client out everywhere, and retires their old
     per-project codes. Needs an address of their own (S13). `projectId`, one of
     theirs, is where the invite lands. */
  app.post('/api/clients/:id/portal', (req, res) => {
    const client = rowOf(req.params.id);
    if (!client) return res.status(404).json({ error: 'not_found' });
    if (!access) return res.status(503).json({ error: 'portal_not_set_up', message: 'The Client Portal isn’t set up on this server.' });
    if (!client.email) {
      return res.status(409).json({
        error: 'email_required',
        message: 'A client signs in to the portal with their email. Add one in Client details first.',
      });
    }
    const shared = emailSharedWith(db, client);
    if (shared.length) {
      return res.status(409).json({
        error: 'email_shared',
        message: `${client.email} is also on ${shared.map((c) => c.businessName).join(', ')}. ` +
          'Give each client their own address before inviting them.',
      });
    }
    const projectId = (req.body || {}).projectId ? String(req.body.projectId) : null;
    if (projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ? AND client_id = ?').get(projectId, client.id)) {
      return res.status(400).json({ error: 'project_invalid', message: 'That project isn’t this client’s.' });
    }
    const { code, invite } = access.issue(client.id, { projectId, now: nowIso() });
    return res.json({
      ok: true,
      code,
      // In the fragment, so the token never reaches a server's log or a Referer (IA URL Strategy).
      inviteUrl: `${portal.url || ''}#/invite/${invite}`,
      access: accessStatus(db, client.id),
    });
  });

  app.delete('/api/clients/:id', (req, res) => {
    // S11: a client with projects stays; their name is on every one of them.
    const n = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE client_id = ?').get(req.params.id).n;
    if (n > 0) {
      return res.status(409).json({
        error: 'has_projects',
        message: `This client has ${n === 1 ? 'a project' : n + ' projects'}, so they can’t be deleted. ` +
          'Archive finished work to file it away. The client stays on your list.',
      });
    }
    // FK is ON DELETE SET NULL — estimates keep their client_json snapshot.
    const result = db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });
}

module.exports = { registerClientRoutes };
