'use strict';

const { newId, nowIso } = require('../db');
const { normEmail, emailHolder, emailSharedWith, emailTakenReply, hasPortalLogin, moveLogin } = require('../clients');
const { readProjectRows, todayOf } = require('./projects');

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

function registerClientRoutes(app, db) {
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
