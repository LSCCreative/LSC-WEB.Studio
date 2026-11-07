'use strict';

/**
 * Copies the Client Hub's client-hub.db into billing.db (merge task M5).
 *
 *   node scripts/import-hub.js --hub <client-hub.db> [--billing <billing.db>]
 *                              [--deliverables <dir>] [--dry-run] [--list-paths]
 *
 * --hub          a copy of the hub's database, taken with
 *                `sqlite3 -readonly <db> ".backup <dest>"` with the hub stopped.
 *                Not `cp`: a WAL database can keep all its data in its -wal.
 * --billing      defaults to this server's own (DATA_DIR/billing.db). It is
 *                brought to the current schema first, as the server would.
 * --deliverables the deliverables share as this machine sees it (in the
 *                container, /srv/deliverables): every file token is checked as
 *                servable, the way GET /hub/files decides.
 * --dry-run      the whole import and every check, on a throwaway copy of
 *                billing.db. The file itself is only read.
 * --list-paths   prints only the hub's file-token paths, one per line, and
 *                imports nothing: for checking the share from another machine.
 *
 * Run it with the server stopped, before it serves the portal: until the
 * import, every link already handed out would answer 404, and a link made in
 * that gap could clash with the hub's. It refuses if a server answers on PORT,
 * here or on any host in IMPORT_PROBE_HOSTS (comma-separated): under Docker the
 * import runs in a container of its own, whose 127.0.0.1 never sees the
 * server's, so the NAS compose file names the server's container there.
 * On the NAS: `docker compose run --rm admin node scripts/import-hub.js …`
 * before `docker compose up -d`.
 *
 * Before writing, billing.db is copied to backups/preimport-*.db beside it.
 * Safe to run again: rows already there and identical are left alone. A row
 * there with different values stops the whole import (src/hub/import.js).
 * Leave TZ unset, as the server does (merge safeguard S19); times are copied as
 * written either way.
 *
 * Exit 0 = imported (or, with --dry-run, would be) and checked. Links or files
 * that were already dead on the hub are listed as warnings and don't change it.
 * 1 = a conflict, a failed check, or no file found on the share at all.
 * 2 = it couldn't start.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { openDatabase } = require('../src/db');
const { snapshotSync } = require('../src/backup');
const { createDeliverables } = require('../src/hub/deliverables');
const { importHub, verifyImport, checkHub, hubVersion, checkTokens, tokenPaths } = require('../src/hub/import');

const USAGE = 'Usage: node scripts/import-hub.js --hub <client-hub.db> [--billing <billing.db>] [--deliverables <dir>] [--dry-run] [--list-paths]';
const VALUE_FLAGS = new Set(['--hub', '--billing', '--deliverables']);
const SWITCHES = new Set(['--dry-run', '--list-paths']);

class Stop extends Error {}

/* A file token is what lets anyone holding the link fetch the file, so the
   output (which ends up in terminals and logs) names it by its start only. */
const shortToken = (token) => `${String(token).slice(0, 8)}…`;

/** The options, or a Stop naming what's wrong: an unknown flag, or a value left off. */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (SWITCHES.has(arg)) {
      opts[arg] = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Stop(`${arg} needs a value.\n${USAGE}`);
      opts[arg] = value;
      i += 1;
    } else {
      throw new Stop(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (!opts['--hub']) throw new Stop(USAGE);
  return opts;
}

/** Opens the hub read-only and checks it is the hub's database, or explains why it can't. */
function openHub(file) {
  const abs = path.resolve(file);
  let hub;
  try {
    hub = new Database(abs, { readonly: true, fileMustExist: true });
    hub.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get(); // the first read is where a WAL file fails
  } catch (err) {
    if (hub) hub.close();
    if (/^SQLITE_(READONLY|CANTOPEN)/.test(err.code || '')) {
      throw new Stop(`Can't read the hub database at ${abs} (${err.code}). A WAL database has to write beside itself even to be read, `
        + 'so it can\'t be read in a read-only folder. Copy it somewhere writable first: sqlite3 -readonly <db> ".backup <copy>" (not cp), '
        + 'then point --hub at the copy.');
    }
    throw new Stop(`Can't open the hub database at ${abs}: ${err.message}`);
  }
  try {
    checkHub(hub);
  } catch (err) {
    hub.close();
    throw new Stop(err.message);
  }
  return hub;
}

/** Where a running server could answer: this machine, and any host IMPORT_PROBE_HOSTS names. */
const probeHosts = () => ['127.0.0.1', ...(process.env.IMPORT_PROBE_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)];

/** The first host where something answers HTTP on this port (the server, which must be stopped for a real import), or null. */
async function serverAnswering(port) {
  for (const host of probeHosts()) {
    if (await serverAnswers(host, port)) return host;
  }
  return null;
}

/** True if something answers HTTP at host:port. A host that doesn't resolve or connect is false. */
function serverAnswers(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(opts['--dry-run']);
  const billingFile = path.resolve(opts['--billing'] || config.dbFile);
  const hub = openHub(opts['--hub']);
  const cleanup = [];
  let billing = null;
  try {
    if (opts['--list-paths']) {
      for (const p of tokenPaths(hub)) console.log(p);
      return 0;
    }
    if (process.env.TZ) {
      console.warn(`Note: TZ is set (${process.env.TZ}). The import copies times as written, but the server runs with TZ unset (S19).`);
    }
    if (!fs.existsSync(billingFile)) throw new Stop(`No billing database at ${billingFile}.`);
    let share = null;
    if (opts['--deliverables']) {
      if (!fs.existsSync(opts['--deliverables'])) throw new Stop(`No folder at ${opts['--deliverables']} (--deliverables).`);
      share = createDeliverables(opts['--deliverables']);
    }
    const answering = dryRun ? null : await serverAnswering(config.port);
    if (answering) {
      throw new Stop(`A server is answering on port ${config.port} (at ${answering}). Run the import with it stopped, before it serves the portal `
        + '(docker compose run --rm admin node scripts/import-hub.js …, then docker compose up -d), or try --dry-run.');
    }

    console.log(`Hub database: ${path.resolve(opts['--hub'])} (its schema ${hubVersion(hub) || 'unknown'})`);
    let target = billingFile;
    if (dryRun) {
      // A throwaway copy, through SQLite's backup from a read-only connection:
      // the real file is never opened for writing, migrated or backed up.
      target = path.join(os.tmpdir(), `lsc-import-dry-${crypto.randomBytes(6).toString('hex')}.db`);
      cleanup.push(target, `${target}-wal`, `${target}-shm`);
      const source = new Database(billingFile, { readonly: true, fileMustExist: true });
      try {
        await source.backup(target);
      } finally {
        source.close();
      }
      console.log(`Billing database: ${billingFile} (dry run: on a throwaway copy; the file itself is only read)`);
      billing = openDatabase(target, { backupDir: false });
    } else {
      console.log(`Billing database: ${billingFile}`);
      billing = openDatabase(billingFile);
      const copy = snapshotSync(billing, path.join(path.dirname(billingFile), 'backups'), 'preimport');
      console.log(`Copied billing.db first: ${copy}`);
    }

    // On the dry run's copy too: it is thrown away after, so the checks below
    // see the import exactly as the real run would leave it.
    const report = importHub(hub, billing);
    const errors = [];
    const warnings = [];

    console.log('');
    console.log('table                 hub   added  already there');
    for (const t of report.tables) {
      if (t.absent) console.log(`${t.name.padEnd(20)}  (the hub has no such table)`);
      else console.log(`${t.name.padEnd(20)} ${String(t.hub).padStart(4)}  ${String(t.added).padStart(6)}  ${String(t.same).padStart(13)}`);
    }
    if (report.skipped.length) console.log(`Not copied, by design: ${report.skipped.join(', ')}`);

    if (report.conflicts.length) {
      errors.push(`${report.conflicts.length} conflict(s); nothing was written:`);
      for (const c of report.conflicts) errors.push(`  ${c.table} ${c.table === 'deliverable_tokens' ? shortToken(c.key) : c.key}: ${c.reason}`);
    } else {
      for (const s of verifyImport(hub, billing)) errors.push(`CHECK FAILED: ${s.table}: ${s.missing} of ${s.hub} hub rows aren't in billing.db as they were`);
      if (!errors.length) console.log('\nChecked: every hub row is in billing.db, unchanged.');
    }

    const links = report.links;
    console.log(`\nFile links stored in records: ${links.total}, on ${links.hosts.join(', ') || 'no host'}`);
    for (const m of links.missing) errors.push(`a record's link lost its token: ${shortToken(m.token)} (project ${m.projectId})`);
    for (const d of links.dead) warnings.push(`a record links to a token the hub never had: ${shortToken(d.token)} (project ${d.projectId})`);

    if (share && !report.conflicts.length) {
      const tokens = checkTokens(billing, hub, share.resolveDeliverablePath);
      console.log(`File tokens servable from ${share.root}: ${tokens.servable} of ${tokens.total}`);
      for (const t of tokens.lost) errors.push(`token not in billing.db after the import: ${shortToken(t)}`);
      if (tokens.total && !tokens.servable && tokens.noFile.length === tokens.total) {
        errors.push(`none of the ${tokens.total} tokens' files are in ${share.root}: is --deliverables the deliverables share?`);
      } else {
        for (const f of tokens.noFile) warnings.push(`no file for token ${shortToken(f.token)}: ${f.path}`);
      }
    }

    if (warnings.length) {
      console.log(`\n${warnings.length} warning(s), already so on the hub; the import doesn't change them:`);
      for (const w of warnings) console.log(`  ${w}`);
    }
    if (errors.length) {
      console.log('');
      for (const e of errors) console.log(e);
      console.log(`\nNot done: see above.${report.written && !dryRun ? ' (The rows were written; billing.db\'s copy from before is in backups/.)' : ''}`);
      return 1;
    }
    console.log(dryRun ? '\nDry run clean.' : '\nDone.');
    return 0;
  } finally {
    hub.close();
    if (billing) billing.close();
    for (const f of cleanup) fs.rmSync(f, { force: true });
  }
}

main().then((code) => {
  process.exitCode = code;
}, (err) => {
  console.error(err instanceof Stop ? err.message : `The import stopped: ${err.message}`);
  process.exitCode = 2;
});
