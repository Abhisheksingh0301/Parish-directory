'use strict';

const db = require('../db');

/**
 * Parish-specific settings — the layer that makes this app a template.
 * Everything a church needs to change (its name, how many families print per
 * page, the palette of the printed directory) is a row in `settings`, editable
 * by an administrator, so a new parish never has to touch the code.
 */

let cache = null;

async function load() {
  if (cache) return cache;
  const rows = await db.all('SELECT key, value FROM settings');
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return cache;
}

function invalidate() {
  cache = null;
}

async function save(updates) {
  await db.tx(async () => {
    for (const [key, value] of Object.entries(updates)) {
      await db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, String(value)]
      );
    }
  });
  invalidate();
}

/** Relation codes offered in the member editor, e.g. "HF, W, S, D". */
function relationOptions(settings) {
  return String(settings.relation_options || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expose settings to every view as `settings`. */
function middleware(req, res, next) {
  load()
    .then((settings) => {
      res.locals.settings = settings;
      req.settings = settings;
      next();
    })
    .catch(next);
}

module.exports = { load, save, invalidate, relationOptions, middleware };
