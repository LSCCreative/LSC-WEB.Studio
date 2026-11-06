'use strict';

/**
 * Copies the Client Hub's client-hub.db into billing.db (merge task M5).
 *
 *   node scripts/import-hub.js --hub <client-hub.db> [--billing <billing.db>]
 *                              [--dry-run] [--deliverables <dir>] [--list-paths]
 *
 * --billing      defaults to this server's own (DATA_DIR/billing.db). It is
 *                brought to the current schema first, as the server would.
 * --dry-run      works it all out and reports, then writes nothing.
 * --deliverables the deliverables share as this machine sees it: each file
 *                token's path is checked as there (in the container,
 *                /srv/deliverables).
 * --list-paths   prints only the hub's file-token paths, one per line, and
 *                imports nothing: for checking the share from another machine.
 *
 * Before writing, billing.db is copied to backups/preimport-*.db beside it.
 * Safe to run again: rows already there and identical are left alone. A row
 * there with different values stops the whole import (src/hub/import.js).
 * Leave TZ unset, as the server does (merge safeguard S19); times are copied as
 * written either way. Exit 0 = imported (or would be, with --dry-run) and
 * verified; 1 = conflicts or a failed check; 2 = it couldn't start.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { openDatabase } = require('../src/db');
const { snapshotSync } = require('../src/backup');
const { importHub, verifyImport, tokenPaths } = require('../src/hub/import');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const has = (flag) => process.argv.includes(flag);

function main() {
  const hubFile = argValue('--hub');
  const billingFile = path.resolve(argValue('--billing') || config.dbFile);
  const dryRun = has('--dry-run');
  const share = argValue('--deliverables');
  if (!hubFile) {
    console.error('Usage: node scripts/import-hub.js --hub <client-hub.db> [--billing <billing.db>] [--dry-run] [--deliverables <dir>] [--list-paths]');
    return 2;
  }
  if (has('--list-paths')) {
    const hub = new Database(path.resolve(hubFile), { readonly: true, fileMustExist: true });
    for (const p of tokenPaths(hub)) console.log(p);
    hub.close();
    return 0;
  }
  if (process.env.TZ) {
    console.warn(`Note: TZ is set (${process.env.TZ}). The import copies times as written, but the server runs with TZ unset (S19).`);
  }
  if (!fs.existsSync(billingFile)) {
    console.error(`No billing database at ${billingFile}.`);
    return 2;
  }

  const hub = new Database(path.resolve(hubFile), { readonly: true, fileMustExist: true });
  const billing = openDatabase(billingFile);
  try {
    const version = hub.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get();
    console.log(`Hub database: ${path.resolve(hubFile)} (its schema ${version || 'unknown'})`);
    console.log(`Billing database: ${billingFile}${dryRun ? ' (dry run: nothing is written)' : ''}`);

    if (!dryRun) {
      const copy = snapshotSync(billing, path.join(path.dirname(billingFile), 'backups'), 'preimport');
      console.log(`Copied billing.db first: ${copy}`);
    }

    const report = importHub(hub, billing, { dryRun });
    console.log('');
    console.log('table                 hub   added  already there');
    for (const t of report.tables) {
      if (t.absent) console.log(`${t.name.padEnd(20)}  (the hub has no such table)`);
      else console.log(`${t.name.padEnd(20)} ${String(t.hub).padStart(4)}  ${String(t.added).padStart(6)}  ${String(t.same).padStart(13)}`);
    }
    if (report.skipped.length) console.log(`Not copied, by design: ${report.skipped.join(', ')}`);

    const links = report.links;
    console.log(`\nFile links stored in records: ${links.total}, on ${links.hosts.join(', ') || 'no host'}; tokens missing: ${links.missing.length}`);
    for (const m of links.missing) console.log(`  missing token ${m.token} (project ${m.projectId})`);

    let failed = links.missing.length > 0;
    if (report.conflicts.length) {
      failed = true;
      console.log(`\n${report.conflicts.length} conflict(s); nothing was written:`);
      for (const c of report.conflicts) console.log(`  ${c.table} ${c.key}: ${c.reason}`);
    } else if (report.written) {
      const short = verifyImport(hub, billing);
      if (short.length) {
        failed = true;
        for (const s of short) console.log(`  CHECK FAILED: ${s.table}: ${s.missing} of ${s.hub} hub rows aren't in billing.db as they were`);
      } else {
        console.log('\nChecked: every hub row is in billing.db, unchanged.');
      }
    }

    if (share) {
      const paths = tokenPaths(dryRun ? hub : billing);
      const absent = paths.filter((p) => !fs.existsSync(path.join(share, p)));
      console.log(`\nFiles behind the tokens on ${share}: ${paths.length - absent.length} of ${paths.length} there`);
      for (const p of absent) console.log(`  not found: ${p}`);
      if (absent.length) failed = true;
    }
    console.log(failed ? '\nNot done: see above.' : (dryRun ? '\nDry run clean.' : '\nDone.'));
    return failed ? 1 : 0;
  } finally {
    hub.close();
    billing.close();
  }
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 2;
}
