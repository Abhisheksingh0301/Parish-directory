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
 * How long the box may get. One more than a number, because the trunk "0" is
 * allowed in and then dropped — see normalise below.
 */
const MAX_INPUT = DIGITS + 1;

/**
 * The same shape as a `pattern` attribute, so the browser can object before
 * the form is sent. The server still has the last word — the browser check is
 * skipped entirely on an empty box, and a mobile number is optional.
 */
const HTML_PATTERN = '0?[6-9][0-9]{9}';

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

module.exports = { DIGITS, MAX_INPUT, HTML_PATTERN, normalise, problem };
