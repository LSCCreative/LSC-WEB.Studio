'use strict';

/**
 * The old hub's projects onto billing's records (merged-admin R4): the screen's
 * three calls. The rules are in hub/adopt.js.
 *
 * GET  /api/setup/hub-import        Where billing's projects stand, and the hub
 *                                   projects the server knows about.
 * POST /api/setup/hub-import/read   The same, with a browser's pasted list.
 * POST /api/setup/hub-import        Does what was decided, all or nothing.
 * POST /api/setup/hub-import/restore  A left-out project back to waiting.
 *
 * The pasted list isn't stored between calls: a read leaves nothing behind, and
 * only what the studio imports is kept. app.js gives these routes a larger body
 * limit, because a list holds signature images.
 */

const { nowIso } = require('../db');
const { readPasted, draft, adopt, AdoptRefusal } = require('../hub/adopt');
const { readProjectRows, stageNow, logActivity } = require('./projects');

function registerHubImportRoutes(app, db) {
  const stageOf = (p) => stageNow(db, p).stage;

  /* Where billing's own projects landed (IA "Existing Data"). */
  function classified() {
    const today = nowIso().slice(0, 10);
    const rows = readProjectRows(db, { today });
    const count = (group) => rows.filter((r) => r.project.delivery.group === group).length;
    return {
      pipeline: count('pipeline'),
      live: count('live'),
      complete: count('done'),
      // Accepted with no client: their quotes named nobody, so a person has to.
      noClient: rows
        .filter((r) => r.project.delivery.group !== 'pipeline' && !r.project.client.id)
        .map((r) => ({ id: r.project.id, upid: r.project.upid, name: r.project.name })),
    };
  }

  function reply(pasted, extra) {
    return { ok: true, classified: classified(), ...draft(db, pasted.projects, stageOf), skipped: pasted.skipped, ...extra };
  }

  const refused = (res, err, next) => {
    if (!(err instanceof AdoptRefusal)) return next(err);
    return res.status(['not_hub_data', 'too_many', 'duplicate'].includes(err.error) ? 400 : 409)
      .json({ error: err.error, message: err.message, id: err.hubId || null });
  };

  app.get('/api/setup/hub-import', (_req, res) => res.json(reply({ projects: [], skipped: 0 })));

  app.post('/api/setup/hub-import/read', (req, res, next) => {
    try {
      return res.json(reply(readPasted((req.body || {}).projects)));
    } catch (err) {
      return refused(res, err, next);
    }
  });

  app.post('/api/setup/hub-import', (req, res, next) => {
    const body = req.body || {};
    if (!Array.isArray(body.decisions) || !body.decisions.length) {
      return res.status(400).json({ error: 'nothing_decided', message: 'Nothing was chosen to import.' });
    }
    try {
      const pasted = readPasted(body.projects);
      const now = nowIso();
      const log = (projectId, kind, detail, at) => logActivity(db, projectId, kind, detail, at);
      const result = db.transaction(() => adopt(db, pasted.projects, body.decisions, stageOf, log, now))();
      return res.json(reply(pasted, { result }));
    } catch (err) {
      return refused(res, err, next);
    }
  });

  /* "Bring back": a hub project left out goes back to waiting. Only a left-out
     row is ever removed; one that became a project stays once-only. */
  app.post('/api/setup/hub-import/restore', (req, res, next) => {
    const body = req.body || {};
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    try {
      const pasted = readPasted(body.projects);
      const row = id ? db.prepare('SELECT outcome, source_json FROM hub_imports WHERE hub_id = ?').get(id) : null;
      if (!row) return res.status(404).json({ error: 'not_found', message: 'That hub project isn’t left out.' });
      if (row.outcome !== 'left_out') {
        return res.status(409).json({ error: 'imported', message: 'That hub project is a project here already, so it stays as it is.' });
      }
      // The row was the only copy of a project the old browser alone held. It goes
      // back to the page, which holds it with the pasted list until it's imported.
      let restored = null;
      try {
        const source = JSON.parse(row.source_json);
        if (source && source.browser && typeof source.browser === 'object') restored = source.browser;
      } catch {
        // Nothing readable was kept: the server's own record, if any, still lists it.
      }
      const list = restored && !pasted.projects.some((p) => p.id === id)
        ? { ...pasted, projects: [...pasted.projects, { ...restored, id }] }
        : pasted;
      db.prepare("DELETE FROM hub_imports WHERE hub_id = ? AND outcome = 'left_out'").run(id);
      return res.json(reply(list, { restored: restored ? { ...restored, id } : null }));
    } catch (err) {
      return refused(res, err, next);
    }
  });
}

module.exports = { registerHubImportRoutes };
