'use strict';

/**
 * Mobile numbers for the directory.
 *
 * The number is how a household is actually reached — it prints on the
 * follow-up sheet and the parish office dials it straight off the page — so a
 * letter that slipped in, or a number two digits short, is not a cosmetic
 * problem. It is a family nobody can call.
 *
 * Indian mobile numbers only: ten digits beginning 6, 7, 8 or 9. That is a
 * decision, not an oversight — a parish whose families are abroad would have
 * to widen it, and this is deliberately the one place where that happens
 * rather than a regular expression copied across the form and the routes.
 */

const DIGITS = 10;
const FIRST = '6789';

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
 * How long the box may get. One more than a number, because the trunk "0" is
 * allowed in and then dropped — see normalise below — and room for the
 * separators between however many are allowed.
 */
const MAX_INPUT = (DIGITS + 1) * MAX_NUMBERS + (MAX_NUMBERS - 1) * 2;

/**
 * One number, as a `pattern` attribute. Exported as well as used below,
 * because the chip editor on the form judges each number on its own and the
 * list pattern would pass a bad one sitting beside three good ones.
 */
const HTML_PATTERN_ONE = '0?[6-9][0-9]{9}';

/**
 * The same shape as a `pattern` attribute, so the browser can object before
 * the form is sent. The server still has the last word — the browser check is
 * skipped entirely on an empty box, and a mobile number is optional.
 */
const HTML_PATTERN = `\\s*${HTML_PATTERN_ONE}\\s*([,/\\s]\\s*${HTML_PATTERN_ONE}\\s*){0,${MAX_NUMBERS - 1}}`;

/**
 * What was typed, reduced to the ten digits that are the number.
 *
 * Two things come off. The separators people put in a phone number, so
 * "98765 43210" and "9876-543210" are both stored the way "9876543210" is.
 * And a leading "0" in front of a full ten digits — the trunk prefix, which is
 * how a great many people here write a mobile number down and how a good deal
 * of what has already been imported is spelled. It is the same number, not a
 * different one, so it is taken in and straightened out rather than refused:
 * the alternative is an editor who cannot save a family until they have
 * retyped a number that was never wrong.
 *
 * Only when exactly ten digits follow it, so "0" at the front of something
 * that is not a number is still the error it looks like.
 */
function normalise(value) {
  const digits = String(value ?? '').replace(/[\s()\-.]/g, '');

  if (digits.length === DIGITS + 1 && digits[0] === '0' && FIRST.includes(digits[1])) {
    return digits.slice(1);
  }
  return digits;
}

/**
 * Why this number cannot be used, written for the person who typed it, or
 * null if it is fine. Blank is fine: a member without a mobile number is an
 * ordinary entry, not an incomplete one.
 */
function problem(value, who) {
  const number = normalise(value);
  if (!number) return null;

  const quoted = `"${String(value).trim()}"`;
  const whose = who ? `The mobile number ${quoted} for ${who}` : `The mobile number ${quoted}`;

  if (/\D/.test(number)) {
    return `${whose} has something other than digits in it — a mobile number is ${DIGITS} digits.`;
  }
  if (number.length !== DIGITS) {
    const had = `${number.length} digit${number.length === 1 ? '' : 's'}`;
    return `${whose} has ${had} — a mobile number is ${DIGITS} digits.`;
  }
  if (!FIRST.includes(number[0])) {
    return `${whose} does not start with 6, 7, 8 or 9, which every Indian mobile number does.`;
  }

  return null;
}

/**
 * The numbers in a field, each reduced to its ten digits.
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
 * Why this field cannot be used, written for the person who typed it, or null
 * if every number in it is fine.
 *
 * Each number is judged on its own and named in the message, because "one of
 * these is wrong" is no use against a field holding three of them.
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

  const seen = new Set();
  for (const number of numbers.map(normalise)) {
    if (seen.has(number)) {
      const whose = who ? ` for ${who}` : '';
      return `The mobile number "${number}"${whose} is listed twice.`;
    }
    seen.add(number);
  }

  return null;
}

module.exports = {
  DIGITS,
  MAX_NUMBERS,
  MAX_INPUT,
  HTML_PATTERN,
  HTML_PATTERN_ONE,
  normalise,
  normaliseList,
  list,
  problem,
  listProblem
};
