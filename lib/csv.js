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
 *
 * ── On what separates one cell from the next ──────────────────────────────
 * A comma, usually. Not always, and not because anybody chose otherwise.
 *
 * A parish downloads its own sheet, opens it in Excel, corrects one email
 * address and presses Save. Excel writes back what its own Save As box was
 * last set to — which is quite often "Text (Tab delimited)", and on a machine
 * whose Windows list separator is a semicolon, quite often that instead. The
 * file still ends in .csv, still looks right on screen, and every cell in it
 * is still correctly quoted. Only the character between the cells has changed.
 *
 * Read as commas, such a file is one enormous column, and the importer's
 * honest report of that — "No Family ID column was found" — names a symptom
 * so far from the cause that nobody could act on it. The office did nothing
 * wrong and has no way to see what happened.
 *
 * So the separator is read off the file rather than assumed. The first line
 * decides it: whichever of comma, tab and semicolon occurs most often outside
 * quotes wins, and a comma wins every tie and every empty count. A file that
 * was always commas therefore parses exactly as it always did.
 */

/** What may separate two cells. A comma first: it wins ties, and it is the default. */
const DELIMITERS = [',', '\t', ';'];

/**
 * Which of those this file uses, decided on its first line — the header row,
 * where every column is present and none of them is blank.
 *
 * Counted outside quotes, because "Salem Marthoma Church, Ranni" is one cell
 * with a comma in it and must not be read as a vote for commas.
 */
function sniff(text) {
  const counts = new Map(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') i += 1; else quoted = false;
      }
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    // The end of the first line is the end of the evidence.
    if (ch === '\r' || ch === '\n') break;
    if (counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
  }

  let best = ',';
  for (const d of DELIMITERS) {
    if (counts.get(d) > counts.get(best)) best = d;
  }
  return best;
}

/**
 * Rows of cells, from the whole file. Quoted newlines stay inside their cell.
 *
 * `delimiter` is read off the file when it is not given, which is how every
 * caller but the tests uses it.
 */
function parse(input, delimiter) {
  const text = String(input).replace(/^﻿/, '');
  const sep = delimiter || sniff(text);
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
    if (ch === sep) { row.push(cell); cell = ''; continue; }

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

module.exports = { parse, cell, row, sniff, DELIMITERS };
