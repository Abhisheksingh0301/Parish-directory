'use strict';

/**
 * Which members of a household are parents, and which are their children.
 *
 * Relation codes are a parish setting, so this can only recognise the codes
 * parishes actually use — the defaults ("HF, W, S, D") and the obvious longer
 * spellings. Ambiguous single letters are deliberately left out: an unknown
 * code drops out of the check rather than being guessed at, because a wrong
 * guess would stop a family saving a perfectly good entry.
 */

const PARENT_CODES = new Set([
  'HF', 'HOF', 'HEAD', 'HUSBAND', 'FATHER', 'W', 'WF', 'WIFE', 'MOTHER'
]);

const CHILD_CODES = new Set(['S', 'SON', 'D', 'DAU', 'DAUGHTER']);

const code = (m) => String(m.relation || '').trim().toUpperCase();

/** A date of birth as one comparable number, or null unless it is a full date. */
function bornOn(m) {
  if (!m.dob_year || !m.dob_month || !m.dob_day) return null;
  return m.dob_year * 10000 + m.dob_month * 100 + m.dob_day;
}

/**
 * "A child cannot be as old as a parent" — one message per son or daughter
 * born on or before the youngest parent in the same family. Members whose
 * date of birth has no year are skipped: without a year there is no age to
 * compare, and half the parish is recorded that way while the details are
 * still being collected.
 */
function generationErrors(members) {
  const youngestParent = members
    .filter((m) => PARENT_CODES.has(code(m)) && bornOn(m) !== null)
    .reduce((youngest, m) => (!youngest || bornOn(m) > bornOn(youngest) ? m : youngest), null);

  if (!youngestParent) return [];
  const parentBorn = bornOn(youngestParent);

  return members
    .filter((m) => CHILD_CODES.has(code(m)))
    .filter((m) => bornOn(m) !== null && bornOn(m) <= parentBorn)
    .map((m) => (
      `"${m.name}" is recorded as born on or before ${youngestParent.name} — ` +
      `a son or daughter has to be younger than their parents.`
    ));
}

/**
 * How many member rows the date-of-marriage cell is merged across.
 *
 * The approved layout merges it over the first two rows, which reads as the
 * couple only while the second row *is* the spouse. Put a son or a daughter
 * there — a widower with children, a household entered in another order — and
 * the merged cell straddles a child, which is a wedding date it has nothing to
 * do with. So the merge shrinks to the head's own row in exactly that case.
 *
 * It shrinks only for a code recognised as a child. An unfamiliar code is left
 * alone and prints as it always has: a parish's own codes should never quietly
 * redraw its book.
 */
function domSpan(members) {
  const span = Math.min(2, members.length);
  if (span === 2 && CHILD_CODES.has(code(members[1]))) return 1;
  return span;
}

module.exports = { PARENT_CODES, CHILD_CODES, generationErrors, domSpan };
