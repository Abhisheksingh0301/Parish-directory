#!/usr/bin/env node
'use strict';

/**
 * Back up the whole installation.
 *
 * The old advice — "backing up a parish is copying that folder" — was true
 * when the folder held one parish. It now holds all of them, and two things
 * have changed with it:
 *
 *   Copying a live SQLite file can capture a torn write. The database is
 *   snapshotted with VACUUM INTO, which SQLite guarantees is consistent even
 *   while the app is running, rather than with a file copy that is not.
 *
 *   It is no longer one bad disk against one parish. Two hundred churches
 *   depend on this file, so the output belongs somewhere other than the
 *   machine that serves it.
 *
 *   node bin/backup.js [--out <directory>] [--keep <n>]
 *
 * `--keep` deletes all but the newest n backups, so a nightly cron does not
 * quietly fill the disk. Nothing is deleted unless it is asked for.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return flags;
}

/** 2026-08-13-1432 — sorts chronologically as text, which `--keep` relies on. */
function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-').replace(/-(\d\d)-(\d\d)$/, '-$1$2');
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });

  let files = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) files += copyTree(src, dst);
    else { fs.copyFileSync(src, dst); files += 1; }
  }
  return files;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Delete all but the newest `keep` backup folders. */
function prune(root, keep) {
  const n = Number(keep);
  if (!Number.isInteger(n) || n < 1) return;

  const backups = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(e.name))
    .map((e) => e.name)
    .sort();

  const doomed = backups.slice(0, Math.max(0, backups.length - n));
  for (const name of doomed) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    console.log(`  removed old backup ${name}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const root = path.resolve(String(flags.out || path.join(config.dataDir, 'backups')));
  const target = path.join(root, stamp());

  if (fs.existsSync(target)) {
    throw new Error(`${target} already exists — wait a minute and run it again.`);
  }
  fs.mkdirSync(target, { recursive: true });

  await db.init();

  // VACUUM INTO is SQLite's own consistent snapshot. Other engines have their
  // own tool — pg_dump, mysqldump — and this script does not pretend otherwise.
  if (db.sequelize.getDialect() !== 'sqlite') {
    throw new Error(
      `This script snapshots SQLite. You are running ${db.sequelize.getDialect()}; ` +
      'use that engine\'s own dump tool instead.'
    );
  }

  const dbFile = path.join(target, 'parish.db');
  await db.sequelize.query('VACUUM INTO :file', { replacements: { file: dbFile } });
  await db.close();

  const photos = copyTree(config.uploadDir, path.join(target, 'uploads'));
  const size = fs.statSync(dbFile).size;

  console.log(`\nBacked up to ${target}`);
  console.log(`  parish.db   ${humanSize(size)}`);
  console.log(`  uploads     ${photos} file${photos === 1 ? '' : 's'}`);

  if (flags.keep) prune(root, flags.keep);

  console.log('\nCopy this folder somewhere that is not this machine.\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error(`\nBackup failed: ${err.message}\n`);
    await db.close().catch(() => {});
    process.exit(1);
  });
