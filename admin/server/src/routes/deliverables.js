'use strict';

/**
 * A project's checklist, as the studio works it (merged-admin R3): the hub
 * editor's asset list, moved behind billing's login and onto real records.
 *
 * A deliverable is a checklist item. Each file it has been given is a numbered
 * version, which starts unpublished; publishing it is what puts it in front of
 * the client (delivery.js reads that as In review). A published version never
 * changes, because the client may have commented on it, and C5's approvals name
 * it: the next file is a new version.
 *
 * The stage (Draft Cut or Final) belongs to the item and says what its next
 * version is. Flipping it carries the newest version along only while that is
 * unpublished. A file is a NAS path, checked here when it's added and again when
 * it's published; the deliverables folder is only ever read.
 *
 * Every write answers with the folder, as the other project actions do.
 */

const { basename, extname } = require('path');
const { newId, nowIso } = require('../db');
const { readFolder, todayOf, logActivity, stageNow } = require('./projects');
const {
  createDeliverables, streamFile, toRelativeDeliverablePath, MAX_PHOTOS_PER_FOLDER, VIDEO_EXTENSIONS, PHOTO_EXTENSIONS,
} = require('../hub/deliverables');
const { normalizeDeliverablePath } = require('../hub/routes');
const { inviteView, setEnv, sendInvite } = require('../portal-invite');

const MAX_TITLE = 200;
const MAX_SHORT = 100;
const INVITE_REFUSALS = {
  sent: 'This client has already been invited.',
  has_access: 'This client can already sign in to the portal.',
  no_client: 'This project has no client record to invite.',
  no_email: 'Add the client’s email in Client details first.',
  email_shared: 'Another client has the same email. Give each client their own before inviting them.',
  no_portal: 'The Client Portal isn’t set up on this server.',
  no_mail: 'Email isn’t set up yet, so the invite can’t be sent.',
  busy: 'An invite is already being sent. Check again in a moment.',
};
const PIPELINE = ['draft', 'sent', 'declined'];

function registerDeliverableRoutes(app, db, opts = {}) {
  const nas = createDeliverables(opts.deliverablesDir);

  const refuse = (res, status, error, message) => res.status(status).json({ error, message });

  /* The portal invite (C6) is part of every folder reply: portal-invite.js reads
     this environment for readFolder too. */
  const inviteEnv = opts.portal || {};
  setEnv(db, inviteEnv);
  const noneYet = db.prepare(`
    SELECT 1 FROM deliverable_versions v JOIN deliverables d ON d.id = v.deliverable_id
     WHERE d.project_id = ? AND v.published_at IS NOT NULL LIMIT 1
  `);

  function answer(req, res, extra = {}) {
    const today = todayOf(req);
    if (!today) return res.status(400).json({ error: 'today_invalid' });
    return res.json({ ok: true, ...readFolder(db, req.params.id, today), ...extra });
  }

  const projectFor = (req, res) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!p) res.status(404).json({ error: 'not_found' });
    return p || null;
  };

  /* A checklist exists from acceptance on, and an archived project is filed:
     it comes back to Complete before anything about it changes. */
  function workable(res, p) {
    if (PIPELINE.includes(stageNow(db, p).stage)) {
      refuse(res, 409, 'not_accepted', 'The checklist opens when the quote is accepted.');
      return false;
    }
    if (p.archived_at) {
      refuse(res, 409, 'archived', 'This project is archived. Unarchive it first.');
      return false;
    }
    return true;
  }

  /* The route's item, in the route's project: another project's id is a 404. */
  const itemFor = (req, res, p) => {
    const d = db.prepare('SELECT * FROM deliverables WHERE id = ? AND project_id = ?').get(req.params.itemId, p.id);
    if (!d) res.status(404).json({ error: 'not_found' });
    return d || null;
  };
  const versionFor = (req, res, d) => {
    const v = db.prepare('SELECT * FROM deliverable_versions WHERE id = ? AND deliverable_id = ?').get(req.params.versionId, d.id);
    if (!v) res.status(404).json({ error: 'not_found' });
    return v || null;
  };
  const newestOf = (itemId) =>
    db.prepare('SELECT * FROM deliverable_versions WHERE deliverable_id = ? ORDER BY n DESC LIMIT 1').get(itemId) || null;

  /* The routes that ask the NAS wait on it, and another request can land in that
     wait: an archive, Not needed, a newer version, the same publish twice. So
     inside the write, the item is read again. Its row, or why it can't be worked. */
  const AFTER_WAIT = {
    gone: [404, 'not_found', 'That deliverable no longer exists.'],
    archived: [409, 'archived', 'This project is archived. Unarchive it first.'],
    not_needed: [409, 'not_needed', 'This one is marked not needed. Mark it needed first.'],
    not_newest: [409, 'not_newest', 'Only the newest version can be published.'],
  };
  function itemNow(p, d) {
    if (db.prepare('SELECT archived_at FROM projects WHERE id = ?').pluck().get(p.id)) return 'archived';
    const item = db.prepare('SELECT * FROM deliverables WHERE id = ? AND project_id = ?').get(d.id, p.id);
    if (!item) return 'gone';
    return item.not_needed_at ? 'not_needed' : item;
  }
  const refuseAfterWait = (res, why) => refuse(res, ...AFTER_WAIT[why]);

  /* The words a checklist item is made of; a string naming the problem when one is wrong. */
  function itemWords(body, current) {
    const title = body.title === undefined ? current.title : String(body.title).trim();
    const format = body.format === undefined ? current.format : String(body.format).trim();
    const duration = body.duration === undefined ? current.duration : String(body.duration).trim();
    if (!title) return 'Give the deliverable a title.';
    if (title.length > MAX_TITLE) return `Keep the title to ${MAX_TITLE} characters.`;
    if (format.length > MAX_SHORT || duration.length > MAX_SHORT) return `Keep the format and length to ${MAX_SHORT} characters.`;
    return { title, format, duration };
  }

  const validLink = (value) => {
    if (!value) return true;
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  };

  /* What a pasted path is on the NAS: { sourcePath, kind, fileName, photoCount }
     or { status, error, message }. A file is a video, a folder a photo library. */
  async function readSource(raw) {
    const relative = toRelativeDeliverablePath(String(raw || '').trim());
    if (relative === null) {
      return { status: 422, error: 'outside_share', message: 'That path isn’t inside Client Deliverables_Media on the NAS.' };
    }
    const path = normalizeDeliverablePath(relative).replace(/\/+$/, '');
    if (!path || path === '.') return { status: 400, error: 'path_required', message: 'Paste the file or folder’s path from the NAS.' };
    if (!path.includes('/')) {
      return { status: 422, error: 'not_in_project_folder', message: 'That’s at the top of the share. It needs to be inside a project’s folder.' };
    }
    const file = nas.resolveDeliverablePath(path);
    if (file) {
      if (!VIDEO_EXTENSIONS.has(extname(path).toLowerCase())) {
        return { status: 422, error: 'not_a_video', message: 'That file isn’t a video (.mp4, .mov, .webm or .m4v). For photos, give the folder they’re in.' };
      }
      return { sourcePath: path, kind: 'video', fileName: basename(path), photoCount: 0 };
    }
    const names = nas.listDeliverableFolderImages(path);
    if (names === null) {
      const health = await nas.health();
      return health.ok
        ? { status: 404, error: 'file_not_found', message: 'Nothing at that path on the NAS. Check it against the file manager.' }
        : { status: 503, error: 'nas_unreachable', message: 'The NAS’s deliverables folder can’t be read right now.' };
    }
    if (!names.length) return { status: 422, error: 'no_images', message: 'That folder has no .jpg, .png or .webp images in it.' };
    if (names.length > MAX_PHOTOS_PER_FOLDER) {
      return { status: 422, error: 'too_many_images', message: `That folder has ${names.length} images (the limit is ${MAX_PHOTOS_PER_FOLDER}). Point at a single delivery folder.` };
    }
    return { sourcePath: path, kind: 'photos', fileName: basename(path), photoCount: names.length };
  }

  // ── The checklist ─────────────────────────────────────────────────────────

  app.post('/api/projects/:id/deliverables', (req, res) => {
    const p = projectFor(req, res);
    if (!p || !workable(res, p)) return undefined;
    const words = itemWords(req.body || {}, { title: '', format: '', duration: '' });
    if (typeof words === 'string') return refuse(res, 400, 'item_invalid', words);
    const now = nowIso();
    db.transaction(() => {
      const { top } = db.prepare('SELECT COALESCE(MAX(position), 0) AS top FROM deliverables WHERE project_id = ?').get(p.id);
      db.prepare(`
        INSERT INTO deliverables (id, project_id, position, title, format, duration, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newId('dlv'), p.id, top + 1, words.title, words.format, words.duration, now, now);
      // Work is expected after all: removing this later shouldn't complete the project.
      db.prepare('UPDATE projects SET no_deliverables_at = NULL WHERE id = ?').run(p.id);
      logActivity(db, p.id, 'deliverable_added', { title: words.title }, now);
    })();
    return answer(req, res);
  });

  app.put('/api/projects/:id/deliverables/:itemId', (req, res) => {
    const p = projectFor(req, res);
    if (!p || !workable(res, p)) return undefined;
    const d = itemFor(req, res, p);
    if (!d) return undefined;
    const body = req.body || {};
    const words = itemWords(body, d);
    if (typeof words === 'string') return refuse(res, 400, 'item_invalid', words);
    const stage = body.stage === undefined ? d.stage : body.stage;
    if (stage !== 'draft' && stage !== 'final') return refuse(res, 400, 'stage_invalid', 'A deliverable is a Draft Cut or a Final.');
    const now = nowIso();
    const notNeededAt = body.notNeeded === undefined ? d.not_needed_at : body.notNeeded ? d.not_needed_at || now : null;
    db.transaction(() => {
      db.prepare(`
        UPDATE deliverables SET title = ?, format = ?, duration = ?, stage = ?, not_needed_at = ?, updated_at = ? WHERE id = ?
      `).run(words.title, words.format, words.duration, stage, notNeededAt, now, d.id);
      if (stage !== d.stage) {
        const newest = newestOf(d.id);
        if (newest && !newest.published_at) {
          db.prepare('UPDATE deliverable_versions SET stage = ? WHERE id = ?').run(stage, newest.id);
        }
        logActivity(db, p.id, 'deliverable_stage', { title: words.title, stage }, now);
      }
      if (Boolean(notNeededAt) !== Boolean(d.not_needed_at)) {
        logActivity(db, p.id, notNeededAt ? 'deliverable_not_needed' : 'deliverable_needed', { title: words.title }, now);
      }
    })();
    return answer(req, res);
  });

  /* Only an extra the studio added, with nothing published: a quoted item is on
     the signed quote, and the way out is Not needed. */
  app.delete('/api/projects/:id/deliverables/:itemId', (req, res) => {
    const p = projectFor(req, res);
    if (!p || !workable(res, p)) return undefined;
    const d = itemFor(req, res, p);
    if (!d) return undefined;
    if (d.quote_line_id || d.estimate_id) {
      return refuse(res, 409, 'quoted_item', 'This one was on the quote, so it stays on record. Mark it not needed instead.');
    }
    if (db.prepare('SELECT 1 FROM deliverable_versions WHERE deliverable_id = ? AND published_at IS NOT NULL LIMIT 1').get(d.id)) {
      return refuse(res, 409, 'has_published', 'The client has seen a version of this, so it stays on record. Mark it not needed instead.');
    }
    const now = nowIso();
    db.transaction(() => {
      db.prepare('DELETE FROM deliverable_versions WHERE deliverable_id = ?').run(d.id);
      db.prepare('DELETE FROM deliverables WHERE id = ?').run(d.id);
      logActivity(db, p.id, 'deliverable_removed', { title: d.title }, now);
    })();
    return answer(req, res);
  });

  /* The state model's other way out of an empty checklist (IA "Project State
     Model"): the studio says none are expected, or takes that back. */
  app.post('/api/projects/:id/no-deliverables', (req, res) => {
    const p = projectFor(req, res);
    if (!p || !workable(res, p)) return undefined;
    const on = Boolean((req.body || {}).on);
    if (on && db.prepare('SELECT 1 FROM deliverables WHERE project_id = ? LIMIT 1').get(p.id)) {
      return refuse(res, 409, 'has_items', 'This project has deliverables. Mark each one not needed instead.');
    }
    if (Boolean(p.no_deliverables_at) !== on) {
      const now = nowIso();
      db.transaction(() => {
        db.prepare('UPDATE projects SET no_deliverables_at = ?, updated_at = ? WHERE id = ?').run(on ? now : null, now, p.id);
        logActivity(db, p.id, on ? 'no_deliverables' : 'deliverables_expected', {}, now);
      })();
    }
    return answer(req, res);
  });

  // ── Its versions ──────────────────────────────────────────────────────────

  app.post('/api/projects/:id/deliverables/:itemId/versions', async (req, res, next) => {
    try {
      const p = projectFor(req, res);
      if (!p || !workable(res, p)) return undefined;
      const d = itemFor(req, res, p);
      if (!d) return undefined;
      if (d.not_needed_at) return refuse(res, 409, 'not_needed', 'This one is marked not needed. Mark it needed first.');
      const body = req.body || {};
      const driveLink = String(body.driveLink || '').trim();
      if (!validLink(driveLink)) return refuse(res, 400, 'link_invalid', 'The backup link needs to be a full web address.');
      const source = await readSource(body.path);
      if (source.error) return refuse(res, source.status, source.error, source.message);

      const now = nowIso();
      const refused = db.transaction(() => {
        // As it stands after the NAS answered: its stage may have flipped meanwhile.
        const item = itemNow(p, d);
        if (typeof item === 'string') return item;
        const newest = newestOf(item.id);
        const n = (newest ? newest.n : 0) + 1;
        db.prepare(`
          INSERT INTO deliverable_versions
            (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, photo_count, drive_link, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newId('ver'), item.id, p.id, n, item.stage, source.sourcePath, source.fileName, source.kind, source.photoCount, driveLink, now);
        // A new file is what the client looks at next: where the old hub left it no longer stands.
        db.prepare('UPDATE deliverables SET hub_status = NULL, updated_at = ? WHERE id = ?').run(now, item.id);
        logActivity(db, p.id, 'version_added', { title: item.title, n, file: source.fileName }, now);
        return null;
      })();
      if (refused) return refuseAfterWait(res, refused);
      return answer(req, res);
    } catch (err) {
      return next(err);
    }
  });

  app.put('/api/projects/:id/deliverables/:itemId/versions/:versionId', (req, res) => {
    const p = projectFor(req, res);
    if (!p || !workable(res, p)) return undefined;
    const d = itemFor(req, res, p);
    const v = d && versionFor(req, res, d);
    if (!v) return undefined;
    const driveLink = String((req.body || {}).driveLink || '').trim();
    if (!validLink(driveLink)) return refuse(res, 400, 'link_invalid', 'The backup link needs to be a full web address.');
    db.prepare('UPDATE deliverable_versions SET drive_link = ? WHERE id = ?').run(driveLink, v.id);
    return answer(req, res);
  });

  /* A version nobody has seen, added by mistake. */
  app.delete('/api/projects/:id/deliverables/:itemId/versions/:versionId', (req, res) => {
    const p = projectFor(req, res);
    if (!p || !workable(res, p)) return undefined;
    const d = itemFor(req, res, p);
    const v = d && versionFor(req, res, d);
    if (!v) return undefined;
    if (v.published_at) return refuse(res, 409, 'published', 'The client has seen this version, so it stays on record. Add a new one instead.');
    if (newestOf(d.id).id !== v.id) return refuse(res, 409, 'not_newest', 'Only the newest version can be removed.');
    const now = nowIso();
    db.transaction(() => {
      db.prepare('DELETE FROM deliverable_versions WHERE id = ?').run(v.id);
      logActivity(db, p.id, 'version_removed', { title: d.title, n: v.n }, now);
    })();
    return answer(req, res);
  });

  /* Puts the newest version in front of the client. Publishing one that already
     is changes nothing. Bunny (Slice 2) attaches here: this route gains the fetch
     and its status, and a version isn't offered until its publish is ready. */
  app.post('/api/projects/:id/deliverables/:itemId/versions/:versionId/publish', async (req, res, next) => {
    try {
      const p = projectFor(req, res);
      if (!p || !workable(res, p)) return undefined;
      const d = itemFor(req, res, p);
      const v = d && versionFor(req, res, d);
      if (!v) return undefined;
      if (v.published_at) return answer(req, res);
      if (d.not_needed_at) return refuse(res, 409, 'not_needed', 'This one is marked not needed. Mark it needed first.');
      if (newestOf(d.id).id !== v.id) return refuse(res, 409, 'not_newest', 'Only the newest version can be published.');
      const source = await readSource(v.source_path);
      // The NAS being away says nothing about the file: that one is worth retrying.
      if (source.error === 'nas_unreachable') return refuse(res, source.status, source.error, source.message);
      if (source.error) {
        return refuse(res, 409, 'file_missing', `${v.file_name || 'That file'} can’t be published. ${source.message}`);
      }
      const now = nowIso();
      let first = false;
      let published = false;
      const refused = db.transaction(() => {
        const item = itemNow(p, d);
        if (typeof item === 'string') return item;
        const fresh = db.prepare('SELECT * FROM deliverable_versions WHERE id = ? AND deliverable_id = ?').get(v.id, item.id);
        if (!fresh) return 'gone';
        // The same publish twice (a double click) is one publish.
        if (fresh.published_at) return null;
        if (newestOf(item.id).id !== fresh.id) return 'not_newest';
        first = !noneYet.get(p.id);
        db.prepare('UPDATE deliverable_versions SET published_at = ?, photo_count = ? WHERE id = ?').run(now, source.photoCount, fresh.id);
        logActivity(db, p.id, 'version_published', { title: item.title, n: fresh.n, stage: fresh.stage }, now);
        published = true;
        return null;
      })();
      if (refused) return refuseAfterWait(res, refused);
      // The invite goes only with the project's first publish, and only if the
      // studio asked for it in the dialog that named who gets it. The publish
      // stands whatever happens to the email.
      if (published && first && (req.body || {}).invite === true) {
        const sent = await sendInvite(db, p, inviteEnv);
        // Asked for and not sent: say why, in the same words as the by-hand route.
        const why = sent.sent === false && !sent.failed ? { message: INVITE_REFUSALS[sent.state] || 'The invite can’t be sent.' } : {};
        return answer(req, res, { inviteResult: { ...sent, ...why } });
      }
      return answer(req, res);
    } catch (err) {
      return next(err);
    }
  });

  /* The file itself, for the studio's own look at it: behind the login, so
     previewing mints no public link. A photo library lists its images, or takes
     `?name=`: one image directly in its folder, by the rule the listing uses. */
  app.get('/api/projects/:id/deliverables/:itemId/versions/:versionId/file', (req, res) => {
    const p = projectFor(req, res);
    if (!p) return undefined;
    const d = itemFor(req, res, p);
    const v = d && versionFor(req, res, d);
    if (!v) return undefined;
    // Only ever a link on the old hub (R4): there is no file here to show.
    if (!v.source_path) return res.status(404).json({ error: 'file_not_found' });
    let relative = v.source_path;
    if (v.kind === 'photos') {
      if (req.query.name === undefined) {
        return res.json({ ok: true, photos: nas.listDeliverableFolderImages(v.source_path) || [] });
      }
      const name = String(req.query.name);
      if (basename(name) !== name || !PHOTO_EXTENSIONS.has(extname(name).toLowerCase())) {
        return res.status(404).json({ error: 'not_found' });
      }
      relative = `${v.source_path}/${name}`;
    }
    const file = nas.resolveDeliverablePath(relative);
    if (!file) return refuse(res, 404, 'file_missing', 'That file isn’t on the NAS any more.');
    return streamFile(req, res, file.absolute, file.stat, false);
  });

  /* The invite by hand, before a first publish (C6). Same rules as the dialog's:
     a client with no way in yet and no invite before, an address of their own,
     the portal and email set up. Answers with the folder and what happened. */
  app.post('/api/projects/:id/portal-invite', async (req, res, next) => {
    try {
      const p = projectFor(req, res);
      if (!p || !workable(res, p)) return undefined;
      const sent = await sendInvite(db, p, inviteEnv);
      if (sent.sent === false && !sent.failed) {
        return refuse(res, 409, `invite_${sent.state}`, INVITE_REFUSALS[sent.state] || 'The invite can’t be sent.');
      }
      return answer(req, res, { inviteResult: sent });
    } catch (err) {
      return next(err);
    }
  });
}

module.exports = { registerDeliverableRoutes };
