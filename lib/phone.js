'use strict';

/**
 * Mobile numbers for the directory.
 *
 * The number is how a household is actually reached — it prints on the
 * follow-up sheet and the parish office dials it straight off the page.
 *
 * This used to check the shape of an Indian mobile number: ten digits,
 * beginning 6, 7, 8 or 9. That is wrong for a parish with families abroad,
 * who are reached on a number with a country code, a different length, and
 * no reason to start with any particular digit — "+1 416 555 0199" is not a
 * broken Indian number, it is a Canadian one. Rather than keep widening one
 * regular expression to chase every country's dialling plan, the shape of a
 * real number is not checked at all: whatever a household gives is what is
 * printed for it.
 *
 * One shape is still refused, and it is not a phone number's: a spreadsheet
 * column that was not formatted as text turns a long digit string into
 * scientific notation ("9.18594E+11") on every affected row, silently, and
 * the export carries that instead of the number anyone typed. Reading it in
 * as a mobile number would print a household nobody can call, and the
 * original digits are gone by the time the file reaches here — there is
 * nothing to straighten out, only something to catch and name so the sheet
 * can be fixed at the source. See SCIENTIFIC_NOTATION below.
 *
 * What is otherwise kept is the shape of the *field* — how many numbers a
 * member may list, and how they are told apart — because that governs what
 * fits in a printed cell, which has nothing to do with which country a
 * number belongs to.
 */

/**
 * How many numbers one member may have.
 *
 * A household reaches its head on one number and, often enough, on a second —
 * a work phone, or the one the family actually answers. More than three is a
 * contact list rather than a directory entry, and each one printed has to fit
 * the cell it goes in, so there is a limit and it is stated here rather than
 * discovered when the page comes back from the press out of shape.
 */
const MAX_NUMBERS = 3;

/** Stored as one field, numbers separated by commas. Printed one per line. */
const SEPARATOR = ',';

/** A comma, a semicolon, a slash, a new line, or a run of spaces. */
const SPLIT_ON = /[,;/\n\r]+|\s{2,}/;

/**
 * How long one number may be typed as — generous enough for a country code,
 * the number itself and the visual separators somebody writes it with
 * ("+91 98765 43210" is 16 characters), without being long enough for a
 * sentence to hide in the box unnoticed.
 */
const MAX_NUMBER_LENGTH = 20;

/** How long the box may get: room for MAX_NUMBERS of them, comma-separated. */
const MAX_INPUT = MAX_NUMBER_LENGTH * MAX_NUMBERS + (MAX_NUMBERS - 1) * 2;

/**
 * What was typed, with the visual separators taken out — spaces, parentheses,
 * hyphens and dots — so "+91 98765 43210" and "+91-98765-43210" are stored
 * the same way. Nothing about the digits themselves is read: a leading "+", a
 * leading "0", a length that is not ten, all pass through exactly as given.
 */
function normalise(value) {
  return String(value ?? '').replace(/[\s()\-.]/g, '');
}

/**
 * A spreadsheet's own mistake, not a phone number anybody typed.
 *
 * Excel turns a long digit string into scientific notation — "9.18594E+11" —
 * the moment its column is not formatted as text, silently and on every row,
 * and a sheet exported after that carries the mangled form instead of the
 * number that was there. It is never what a real number looks like, no
 * matter which country it is from, so it is the one shape still checked for:
 * everything else about a number is left alone, but this is caught and named
 * rather than filed as somebody's telephone number, because the original
 * digits cannot be recovered from it after the fact — the column has to be
 * fixed at the source and the sheet exported again.
 */
const SCIENTIFIC_NOTATION = /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/;

/**
 * The numbers in a field, split apart.
 *
 * People separate them however they like — a comma, a slash, a new line, or
 * just a space — so all four are accepted going in and one spelling comes out.
 * An empty field is no numbers, which is an ordinary entry and not an error.
 */
function split(value) {
  return String(value ?? '')
    .split(SPLIT_ON)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** What is stored: the numbers alone, comma-separated, in the order given. */
function normaliseList(value) {
  return split(value).map(normalise).join(SEPARATOR);
}

/** The numbers to print, one per line. */
function list(value) {
  return split(value);
}

/**
 * Why this one number cannot be used, written for the person who typed it, or
 * null if it is fine. The shape of a real number is never judged — only
 * whether it is a spreadsheet's scientific-notation mistake rather than a
 * number at all. See SCIENTIFIC_NOTATION above.
 */
function problem(value, who) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;

  if (SCIENTIFIC_NOTATION.test(trimmed)) {
    const quoted = `"${trimmed}"`;
    const whose = who ? `The mobile number ${quoted} for ${who}` : `The mobile number ${quoted}`;
    return `${whose} has turned into scientific notation, which a spreadsheet does to a ` +
      'long number when its column is not formatted as text. The original digits cannot ' +
      'be recovered from this — fix the Mobile column in the spreadsheet and export again.';
  }

  return null;
}

/**
 * Why this field cannot be used, written for the person who typed it, or null
 * if it is fine. Two things are checked: how many numbers are in the box,
 * and whether any of them is a spreadsheet's mistake rather than a number —
 * never what a real number looks like.
 */
function listProblem(value, who) {
  const numbers = split(value);
  if (!numbers.length) return null;

  if (numbers.length > MAX_NUMBERS) {
    const whose = who ? ` for ${who}` : '';
    return `${numbers.length} mobile numbers${whose} — keep it to ${MAX_NUMBERS}, ` +
      'which is what the printed entry has room for.';
  }

  for (const number of numbers) {
    const bad = problem(number, who);
    if (bad) return bad;
  }

  return null;
}

module.exports = {
  MAX_NUMBERS,
  MAX_INPUT,
  MAX_NUMBER_LENGTH,
  normalise,
  normaliseList,
  list,
  split,
  problem,
  listProblem
};
