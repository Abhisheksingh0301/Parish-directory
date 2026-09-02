'use strict';

/**
 * The open-ended member fields — qualification and occupation.
 *
 * The third used to be `links`, a free-text column that in practice held email
 * addresses. It is now `emails`, named and checked as what it is, so it is
 * validated by lib/email.js instead of by the "it has to say something" rule
 * below — which an address passes trivially and which would never have caught
 * the missing ".com" that matters.
 *
 * There is no list of every degree or every job, and a parish that was handed
 * one would find the first family it could not describe on the first evening,
 * so these stay free text. What they are not is a scratch pad: each prints
 * into a fixed-width cell of the directory table, so a paragraph pasted into
 * one pushes the page out of shape, and a value with no letter anywhere in it
 * ("###", "12345") is a slip of the keyboard rather than a qualification.
 *
 * Hence two rules and no more: a length, and "it has to say something". Any
 * script counts as saying something — a qualification typed in Malayalam is a
 * qualification.
 */

const LIMITS = { qualification: 60, occupation: 60 };
const LABELS = { qualification: 'Qualification', occupation: 'Occupation' };

// Characters that do not appear in a degree or a job title, and do appear when
// something has been pasted in from a page or a spreadsheet formula.
const FORBIDDEN = /[<>{}\\|]/;
const HAS_LETTER = /\p{L}/u;

/**
 * The same rule as a `pattern` attribute, so the browser objects first. The
 * lookahead is the "has to say something" half; the class is the other.
 *
 * Written raw, and with every one of those characters escaped inside the
 * class, because the browser compiles a `pattern` in unicode mode — where a
 * bare brace or pipe in a character class is a syntax error, and a pattern
 * that fails to compile is a pattern the browser quietly stops enforcing.
 */
const PATTERN_CLASS = String.raw`[^<>\{\}\\\|]`;

function htmlPattern(field) {
  return String.raw`(?=.*\p{L})` + PATTERN_CLASS + `{1,${LIMITS[field]}}`;
}

/**
 * Why this value cannot be used, written for the person who typed it, or null
 * if it is fine. Blank is fine — all three fields are optional.
 */
function problem(field, value, who) {
  const entered = String(value ?? '').trim();
  if (!entered) return null;

  const max = LIMITS[field];
  const what = who ? `${LABELS[field]} for "${who}"` : LABELS[field];

  if (entered.length > max) {
    return `${what} is ${entered.length} characters long — keep it to ${max}, which is what the printed entry has room for.`;
  }

  const bad = entered.match(FORBIDDEN);
  if (bad) return `${what} has a "${bad[0]}" in it, which cannot be used here.`;

  if (!HAS_LETTER.test(entered)) {
    return `${what} is "${entered}", which has no letters in it.`;
  }

  return null;
}

module.exports = { LIMITS, LABELS, htmlPattern, problem };
