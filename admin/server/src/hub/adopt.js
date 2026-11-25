'use strict';

/* The old hub's projects, brought onto billing's records (merged-admin R4).
 *
 * hub/import.js copied the hub's server tables across as they were (M5). What
 * they describe still isn't a billing project: the hub's ids mean nothing to
 * `projects`, and the richest copy of each project sits in the localStorage of
 * the browser that edited it (`lsc_hub_projects_v1`). This puts the two together:
 *
 *   draft()   What would happen: one row per hub project, from the browser's list
 *             (when pasted) and the server's records. Reads only. A published
 *             record the browser doesn't hold is still a row, so its evidence can
 *             be reached without that browser.
 *   adopt()   Does what the studio decided, inside the caller's transaction.
 *
 * THE RULES
 * - Once. A hub id in hub_imports is finished: a later paste of it changes
 *   nothing, however different it is, so an old copy can't overwrite a record
 *   the studio has moved on from.
 * - The portal isn't touched. `records`, `private_auth` and `agreement_evidence`
 *   keep the hub's id and every byte: clients' links and logins still use them.
 *   hub_imports is what connects them to the project.
 * - Matched by email. One client on the address is a match. Anything else (no
 *   email, no client, two clients sharing it) is shown and waits for the studio.
 * - Payment required stays off, and no invoice is made: the hub's invoices are
 *   PDF names, which stay readable in Documents. Money isn't touched.
 * - A client's code and invite token never come in. The browser holds the code in
 *   plain text; the server has only ever kept hashes. */

const { basename, dirname } = require('path');
const { newId } = require('../db');
const { normEmail, emailHolder } = require('../clients');
const { toRelativeDeliverablePath } = require('./deliverables');

const SECRETS = ['clientCode', 'inviteToken'];
const MAX_PROJECTS = 500;
const MAX_ASSETS = 200;
const MAX_TITLE = 200;
/* A link with one of the hub's file tokens in it. */
const FILE_TOKEN = /\/hub\/files\/([A-Za-z0-9_-]+)/;

const text = (value) => (value === null || value === undefined ? '' : String(value).trim());
const fold = (value) => text(value).toLowerCase();
const isHttp = (value) => /^https?:\/\//i.test(text(value));

class AdoptRefusal extends Error {
  constructor(error, message, id) {
    super(message);
    this.error = error;
    this.hubId = id;
  }
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A browser's project with what must never be stored taken out. */
function withoutSecrets(p) {
  const out = { ...p };
  SECRETS.forEach((key) => delete out[key]);
  return out;
}

/**
 * The pasted list, as far as it can be trusted: objects with an id. Throws when
 * it isn't a list of the hub's projects at all.
 */
function readPasted(list) {
  if (list === undefined || list === null) return { projects: [], skipped: 0 };
  if (!Array.isArray(list)) throw new AdoptRefusal('not_hub_data', 'That isn’t the old hub’s list of projects.');
  if (list.length > MAX_PROJECTS) throw new AdoptRefusal('too_many', `That list has ${list.length} projects; the most this takes is ${MAX_PROJECTS}.`);
  const projects = [];
  const seen = new Set();
  let skipped = 0;
  list.forEach((p) => {
    const id = p && typeof p === 'object' ? text(p.id) : '';
    if (!id || id.length > 100 || seen.has(id)) {
      skipped += 1;
      return;
    }
    seen.add(id);
    projects.push({ ...withoutSecrets(p), id });
  });
  if (list.length && !projects.length) throw new AdoptRefusal('not_hub_data', 'That isn’t the old hub’s list of projects: none of it has a project id.');
  return { projects, skipped };
}

const assetsOf = (p) => (p && Array.isArray(p.assets) ? p.assets.filter((a) => a && typeof a === 'object').slice(0, MAX_ASSETS) : []);

/* The server's side of the hub, by hub id. */
function serverHub(db) {
  const hub = new Map();
  db.prepare('SELECT project_id, data, updated_at FROM records').all().forEach((r) => {
    hub.set(r.project_id, { record: parseJson(r.data), publishedAt: r.updated_at, email: '', signed: false });
  });
  db.prepare('SELECT project_id, client_email FROM private_auth').all().forEach((a) => {
    if (hub.has(a.project_id)) hub.get(a.project_id).email = normEmail(a.client_email);
  });
  db.prepare('SELECT project_id FROM agreement_evidence').all().forEach((e) => {
    if (hub.has(e.project_id)) hub.get(e.project_id).signed = true;
  });
  return hub;
}

/* One hub project as this works with it: the browser's copy over the server's. */
function joined(id, browser, server) {
  const p = browser || (server && server.record) || {};
  return {
    id,
    browser: browser || null,
    server: server || null,
    p,
    title: text(p.name) || text(p.upid) || 'Untitled hub project',
    upid: text(p.upid),
    clientName: text(browser && browser.clientName),
    email: normEmail((browser && browser.clientEmail) || (server && server.email)),
    assets: assetsOf(p),
    delivered: p.delivered === true,
  };
}

/* Who the address belongs to: { client } for one holder, { reason, among } otherwise. */
function matchClient(hubProject, clients) {
  const { email, clientName } = hubProject;
  const named = clientName ? clients.find((c) => fold(c.business_name) === fold(clientName)) : null;
  if (!email) return { reason: 'no_email', suggested: named ? named.id : null };
  const holders = clients.filter((c) => c.email === email);
  if (holders.length === 1) return { client: holders[0] };
  if (holders.length > 1) {
    const among = holders.find((c) => named && c.id === named.id);
    return { reason: 'shared_email', among: holders.length, suggested: among ? among.id : null };
  }
  return { reason: 'no_match', suggested: named ? named.id : null };
}

/**
 * What the screen shows: every hub project known, and how each stands.
 *
 * @param {object[]} pasted  readPasted's projects
 * @param {(p: object) => string} stageOf  a project row's money stage
 */
function draft(db, pasted, stageOf) {
  const done = new Map(db.prepare('SELECT * FROM hub_imports').all().map((r) => [r.hub_id, r]));
  const server = serverHub(db);
  const browser = new Map(pasted.map((p) => [p.id, p]));
  const clients = db.prepare('SELECT id, business_name, contact_name, email FROM clients ORDER BY business_name COLLATE NOCASE, id').all();
  const clientName = new Map(clients.map((c) => [c.id, c.business_name]));
  // A hub project already dealt with is listed from what was kept of it, so the
  // screen still shows it when no list is pasted and the browser held it alone.
  const ids = [...new Set([...browser.keys(), ...server.keys(), ...done.keys()])];
  const kept = (id) => {
    const finished = done.get(id);
    const source = finished ? parseJson(finished.source_json) : null;
    return source && source.browser && typeof source.browser === 'object' ? source.browser : null;
  };

  const rows = ids.map((id) => {
    const hub = joined(id, browser.get(id) || kept(id), server.get(id));
    const row = {
      id,
      title: hub.title,
      upid: hub.upid,
      clientName: hub.clientName,
      email: hub.email,
      inBrowser: browser.has(id),
      onPortal: Boolean(hub.server),
      signed: Boolean(hub.server && hub.server.signed),
      assets: hub.assets.length,
      delivered: hub.delivered,
    };

    const finished = done.get(id);
    if (finished) {
      return { ...row, state: finished.outcome === 'left_out' ? 'left_out' : 'done', projectId: finished.project_id, importedAt: finished.imported_at };
    }

    const match = matchClient(hub, clients);
    if (match.client) {
      row.state = 'ready';
      row.client = { id: match.client.id, businessName: match.client.business_name };
    } else {
      row.state = 'decide';
      row.reason = match.reason;
      row.suggested = match.suggested;
      // Two clients already on the address: a third would make it worse (S13).
      row.canCreate = match.reason !== 'shared_email' && Boolean(hub.clientName || hub.email || hub.title);
      row.createAs = hub.clientName || hub.email || hub.title;
    }

    // The same UPID on a project already here: it may be the same job.
    if (hub.upid) {
      const there = db.prepare('SELECT * FROM projects WHERE upid = ?').get(hub.upid);
      if (there) {
        const free = !db.prepare('SELECT 1 FROM hub_imports WHERE project_id = ?').get(there.id);
        const stage = stageOf(there);
        row.upidProject = {
          id: there.id,
          clientId: there.client_id || null,
          clientName: there.client_id ? clientName.get(there.client_id) || '' : '',
          // Work can only join a project that has been accepted, once.
          joinable: free && !['draft', 'sent', 'declined'].includes(stage),
        };
        if (row.state === 'decide' && !row.suggested && there.client_id) row.suggested = there.client_id;
      }
    }
    return row;
  });

  const order = { decide: 0, ready: 1, done: 2, left_out: 3 };
  rows.sort((a, b) => order[a.state] - order[b.state] || a.title.localeCompare(b.title));
  return {
    rows,
    clients: clients.map((c) => ({ id: c.id, businessName: c.business_name, email: c.email })),
  };
}

/* ── Doing it ───────────────────────────────────────────────────────────── */

/* The NAS file behind an asset: its stored path, else the one its links' tokens
   were made for. Null when it was only ever a pasted link. */
function sourceOf(db, asset) {
  const tokenPath = (link) => {
    const found = FILE_TOKEN.exec(text(link));
    if (!found) return null;
    const row = db.prepare('SELECT relative_path FROM deliverable_tokens WHERE token = ?').get(found[1]);
    return row ? row.relative_path : null;
  };
  const stored = text(asset.deliverablePath);
  const relative = stored ? toRelativeDeliverablePath(stored) : null;
  if (relative) return relative.replace(/\/+$/, '');
  if (asset.type === 'photo') {
    const photos = Array.isArray(asset.photos) ? asset.photos : [];
    const first = photos.map((ph) => ph && (tokenPath(ph.reviewLink) || tokenPath(ph.downloadLink))).find(Boolean);
    return first ? dirname(first) : null;
  }
  return tokenPath(asset.reviewLink) || tokenPath(asset.downloadLink);
}

/* Where the hub left an asset, as deliverables.hub_status. */
function hubStatusOf(asset, delivered) {
  if (asset.status === 'approved') return 'approved';
  if (delivered) return 'delivered';
  return asset.status === 'changes' ? 'changes' : null;
}

/* One hub asset onto the project's checklist: its item, and a first version when
   there is any file or link. A joined project's quoted item with the same title
   and no file yet takes it, rather than the checklist listing the job twice. */
function addAsset(db, hub, projectId, asset, now) {
  const title = (text(asset.title) || (asset.type === 'photo' ? 'Photo library' : 'Video')).slice(0, MAX_TITLE);
  const hubStatus = hubStatusOf(asset, hub.delivered);
  const stage = hubStatus === 'approved' || hubStatus === 'delivered' || text(asset.downloadLink) ? 'final' : 'draft';

  const open = db.prepare(`
    SELECT d.id, d.title FROM deliverables d
     WHERE d.project_id = ? AND d.not_needed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM deliverable_versions v WHERE v.deliverable_id = d.id)
     ORDER BY d.position
  `).all(projectId).find((d) => fold(d.title) === fold(title));

  let itemId;
  if (open) {
    itemId = open.id;
    db.prepare('UPDATE deliverables SET stage = ?, hub_status = ?, updated_at = ? WHERE id = ?').run(stage, hubStatus, now, itemId);
  } else {
    itemId = newId('dlv');
    const { top } = db.prepare('SELECT COALESCE(MAX(position), 0) AS top FROM deliverables WHERE project_id = ?').get(projectId);
    db.prepare(`
      INSERT INTO deliverables (id, project_id, position, title, stage, hub_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, projectId, top + 1, title, stage, hubStatus, now, now);
  }

  const photos = asset.type === 'photo' && Array.isArray(asset.photos) ? asset.photos : [];
  const path = sourceOf(db, asset);
  const hasLink = isHttp(asset.reviewLink) || isHttp(asset.downloadLink) || isHttp(asset.driveLink) || photos.length > 0;
  if (!path && !hasLink) return;

  // Published when the client's record has it. A browser's newer draft may not.
  const record = hub.server && hub.server.record;
  const inRecord = record && Array.isArray(record.assets) && record.assets.some((a) => a && a.id === asset.id);
  const published = inRecord ? text(hub.p.publishedAt) || hub.server.publishedAt
    : !hub.server && text(hub.p.publishedAt) ? text(hub.p.publishedAt) : null;

  db.prepare(`
    INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, photo_count,
                                      drive_link, created_at, published_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId('ver'), itemId, projectId, stage, path, path ? basename(path) : 'Link from the old hub',
    asset.type === 'photo' ? 'photos' : 'video', photos.length, isHttp(asset.driveLink) ? text(asset.driveLink) : '', now, published);
}

/* The client a decision names. */
function clientFor(db, hub, row, decision, now) {
  if (decision.client === 'new') {
    if (!row.canCreate) throw new AdoptRefusal('client_needed', `Choose a client for “${row.title}”.`, row.id);
    // Two hub projects for one new client come to one record.
    const holder = hub.email ? emailHolder(db, hub.email) : null;
    if (holder) return holder.id;
    const name = row.createAs.slice(0, MAX_TITLE);
    // A client of the same name is the same one only when nothing says otherwise:
    // no address on either side, or none on theirs yet (which this one then fills).
    // One with a different address is someone else, so a new record is made.
    const named = db.prepare('SELECT id, business_name, email FROM clients ORDER BY created_at, id').all()
      .find((c) => fold(c.business_name) === fold(name) && (!hub.email || !text(c.email)));
    if (named) {
      if (hub.email) db.prepare('UPDATE clients SET email = ?, updated_at = ? WHERE id = ?').run(hub.email, now, named.id);
      return named.id;
    }
    const id = newId('cl');
    db.prepare(`
      INSERT INTO clients (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
      VALUES (?, ?, '', ?, '', '', '', '', ?, ?)
    `).run(id, name, hub.email, now, now);
    return id;
  }
  if (decision.client) {
    if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(String(decision.client))) {
      throw new AdoptRefusal('client_gone', `The client chosen for “${row.title}” no longer exists.`, row.id);
    }
    return String(decision.client);
  }
  if (row.client) return row.client.id;
  throw new AdoptRefusal('client_needed', `Choose a client for “${row.title}”.`, row.id);
}

/**
 * Does what was decided, inside the caller's transaction. A hub id already dealt
 * with, or one nobody has decided on, is passed over.
 *
 * @param {object[]} pasted     readPasted's projects
 * @param {object[]} decisions  [{ id, client?: id|'new', join?: boolean, leaveOut?: boolean }]
 * @param {(p: object) => string} stageOf
 * @param {(projectId, kind, detail, now) => void} log  the project's activity
 * @returns {{ imported, joined, leftOut, clashes: Array<{id, title, upid}> }}
 */
function adopt(db, pasted, decisions, stageOf, log, now) {
  const { rows } = draft(db, pasted, stageOf);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const server = serverHub(db);
  const browser = new Map(pasted.map((p) => [p.id, p]));
  const result = { imported: 0, joined: 0, leftOut: 0, clashes: [] };
  const record = db.prepare('INSERT INTO hub_imports (hub_id, project_id, outcome, source_json, imported_at) VALUES (?, ?, ?, ?, ?)');

  // One decision per hub project: a second for the same id would act on rows
  // read before the first, so the whole request is refused instead.
  const seen = new Set();
  decisions.forEach((decision) => {
    const id = text(decision && decision.id);
    if (seen.has(id)) throw new AdoptRefusal('duplicate', 'The same hub project was chosen twice. Reload the page and try again.', id);
    seen.add(id);
  });

  decisions.forEach((decision) => {
    const id = text(decision && decision.id);
    const row = byId.get(id);
    if (!row || row.state === 'done' || row.state === 'left_out') return;
    const hub = joined(id, browser.get(id), server.get(id));
    const source = JSON.stringify({ browser: hub.browser, record: hub.server ? hub.server.record : null });

    if (decision.leaveOut) {
      // A signed record has legal weight: it has to stay readable on a project.
      if (row.signed) throw new AdoptRefusal('signed', `“${row.title}” holds a client’s sign-off, so it can’t be left out.`, id);
      record.run(id, null, 'left_out', source, now);
      result.leftOut += 1;
      return;
    }

    const clientId = clientFor(db, hub, row, decision, now);
    const there = hub.upid ? db.prepare('SELECT * FROM projects WHERE upid = ?').get(hub.upid) : null;
    const free = there && !db.prepare('SELECT 1 FROM hub_imports WHERE project_id = ?').get(there.id);
    const canJoin = free && !['draft', 'sent', 'declined'].includes(stageOf(there)) &&
      (!there.client_id || there.client_id === clientId);

    let projectId;
    if (decision.join && canJoin) {
      projectId = there.id;
      if (!there.client_id) db.prepare('UPDATE projects SET client_id = ?, updated_at = ? WHERE id = ?').run(clientId, now, there.id);
      result.joined += 1;
    } else {
      projectId = newId('prj');
      // A UPID belongs to one project: a second one here waits for a new one.
      const upid = hub.upid && !there ? hub.upid : null;
      if (hub.upid && there) result.clashes.push({ id, title: hub.title, upid: hub.upid });
      const accepted = text(hub.p.publishedAt) || (hub.server && hub.server.publishedAt) || now;
      db.prepare(`
        INSERT INTO projects (id, upid, client_id, name, accepted_at, no_deliverables_at, opened_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, upid, clientId, hub.title.slice(0, MAX_TITLE), accepted,
        hub.delivered && !hub.assets.length ? now : null, now, now, now);
      result.imported += 1;
    }

    hub.assets.forEach((asset) => addAsset(db, hub, projectId, asset, now));
    // Work is on the checklist now: an empty-list answer no longer stands.
    if (hub.assets.length) db.prepare('UPDATE projects SET no_deliverables_at = NULL WHERE id = ?').run(projectId);

    record.run(id, projectId, decision.join && canJoin ? 'joined' : 'imported', source, now);
    log(projectId, 'hub_imported', { title: hub.title, assets: hub.assets.length, joined: Boolean(decision.join && canJoin) }, now);
  });
  return result;
}

/* ── Reading it back ────────────────────────────────────────────────────── */

/** The hub id linked to a project, or null. */
function hubIdOf(db, projectId) {
  return db.prepare('SELECT hub_id FROM hub_imports WHERE project_id = ?').pluck().get(projectId) || null;
}

/**
 * What the old hub knew about a project, for its Documents tab: the words and
 * names that have nowhere else to live yet. Every value is someone's typing, so
 * the screen escapes it (S8).
 */
function hubFacts(db, projectId) {
  const row = db.prepare('SELECT * FROM hub_imports WHERE project_id = ?').get(projectId);
  if (!row) return null;
  const source = parseJson(row.source_json) || {};
  const p = source.browser || source.record || {};
  const notes = [];
  assetsOf(p).forEach((asset) => {
    (Array.isArray(asset.comments) ? asset.comments : []).forEach((c) => {
      if (!c || !text(c.text)) return;
      notes.push({
        asset: text(asset.title), text: text(c.text), at: text(c.at),
        timestamp: c.timestamp === null || c.timestamp === undefined ? null : c.timestamp,
        photo: text(c.photoName),
      });
    });
  });
  const agreement = source.browser && source.browser.agreement;
  return {
    hubId: row.hub_id,
    outcome: row.outcome,
    importedAt: row.imported_at,
    message: text(p.message),
    invoices: (Array.isArray(p.invoices) ? p.invoices : []).filter(Boolean)
      .map((i) => ({ type: text(i.type), name: text(i.name), url: isHttp(i.url) ? text(i.url) : '' })),
    notes,
    // A sign-off only the old browser holds: worth keeping, but not server evidence.
    browserSignoff: agreement && agreement.accepted
      ? { signerName: text(agreement.signerName), signedAt: text(agreement.signedAt) }
      : null,
  };
}

module.exports = { readPasted, draft, adopt, hubIdOf, hubFacts, AdoptRefusal, SECRETS };
