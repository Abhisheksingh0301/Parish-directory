'use strict';

/**
 * Reading and writing the spreadsheets a parish actually has.
 *
 * Small enough to write out rather than take a dependency, and it has to
 * handle the three things a real parish sheet contains: commas inside a quoted
 * name, doubled quotes inside that, and a line break inside a quoted address
 * cell — which is how a two-line address arrives out of Excel, and which a
 * split on newlines would tear in half.
 *
 * bin/import-hierarchy.js has a line-at-a-time reader that handles the first
 * two. It is left alone deliberately — it is shipped, it works, and a diocese
 * list has no multi-line cells — but a family sheet does, because an address
 * is exactly the field somebody presses Alt+Enter in. This is the reader the
 * family import uses, and the writer the rejects file is produced with.
 */

/** Rows of cells, from the whole file. Quoted newlines stay inside their cell. */
function parse(input) {
  const text = String(input).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }

    if (ch === '\r' || ch === '\n') {
      // \r\n is one line ending, not two.
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += ch;
  }

  row.push(cell);
  rows.push(row);

  // A file ending in a newline leaves one empty row behind it.
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** One CSV field: quoted, with embedded quotes doubled. */
function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** One CSV line, terminated the way a spreadsheet expects. */
function row(values) {
  return values.map(cell).join(',') + '\r\n';
}

module.exports = { parse, cell, row };
