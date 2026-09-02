'use strict';

/**
 * Reading a date out of somebody else's spreadsheet.
 *
 * The parish sheet was not written to be imported. It has "02-Aug-1975" in one
 * row, "2/8/1975" in the next, "Aug 1975" where nobody wrote the day down and
 * "14-Mar" where there never was a year. All of those are real information and
 * none of them should be thrown away.
 *
 * So: a day and a month, either of which may be missing, and nothing is
 * discarded silently. A date that cannot be read at all is reported as a
 * reject rather than being quietly blanked.
 *
 * A year in the sheet is read and then dropped. The directory stores neither a
 * birth year nor a marriage year (migration 11), but "02-Aug-1975" still has
 * to be understood as the second of August — refusing it because of the part
 * we do not keep would reject most of a real parish sheet.
 *
 * ── The one ambiguity, decided ─────────────────────────────────────────────
 * "03/04/1975" is the third of April in an Indian parish register and the
 * fourth of March in an American one. This reads day first, because that is
 * what the sheets this is written against use. A value whose first number is
 * above twelve is unambiguous either way and is read as the day regardless.
 */

const dayMonth = require('./daymonth');

const MONTH_NAMES = new Map();
dayMonth.MONTHS.forEach((name, i) => {
  MONTH_NAMES.set(name.toLowerCase(), i + 1);
});
[
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
].forEach((name, i) => MONTH_NAMES.set(name, i + 1));
MONTH_NAMES.set('sept', 9);

const empty = { day: null, month: null, error: null };

function monthFrom(token) {
  const text = String(token).trim().toLowerCase();
  if (MONTH_NAMES.has(text)) return MONTH_NAMES.get(text);
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

function looksLikeYear(token) {
  return /^\d{4}$/.test(String(token).trim());
}

/** Read whatever shape the sheet has, and keep the day and the month. */
function readDate(raw, { label = 'Date' } = {}) {
  const value = String(raw ?? '').trim();
  if (!value) return { ...empty };

  const tokens = value.split(/[\s./\-,]+/).filter(Boolean);
  if (!tokens.length) return { ...empty };

  let day = null;
  let month = null;
  let year = null;

  // ISO first — "1975-08-02" — because its first number is the year, which
  // every other shape reads as the day.
  if (tokens.length >= 3 && looksLikeYear(tokens[0])) {
    year = Number(tokens[0]);
    month = monthFrom(tokens[1]);
    day = Number(tokens[2]);
  } else {
    for (const token of tokens) {
      if (year === null && looksLikeYear(token)) { year = Number(token); continue; }
      if (day === null && /^\d{1,2}$/.test(token)) { day = Number(token); continue; }
      if (month === null) { month = monthFrom(token); continue; }
    }
    // "Aug 1975" and "8 1975": whichever number is left over is the month if
    // no month name was found and a day was.
    if (month === null && day !== null && tokens.length === 2 && year !== null) {
      month = day;
      day = null;
    }
  }

  if (!Number.isInteger(day) || !Number.isInteger(month)) {
    return { ...empty, error: `${label}: "${value}" could not be read as a date.` };
  }

  const parsed = dayMonth.parse(day, month, label);
  if (parsed.error) return { ...empty, error: parsed.error };

  return { day: parsed.day, month: parsed.month, error: null };
}

module.exports = { readDate };
