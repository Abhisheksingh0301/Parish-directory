'use strict';

/**
 * One date shape, used for both dates the directory records.
 *
 * A **date of marriage** and a **date of birth** are both day + month only —
 * "14 - Mar". Stored as two small integers rather than a date string, they
 * stay sortable for the birthday and anniversary lists and we never have to
 * invent a year nobody supplied.
 *
 * A date of birth used to carry an optional year. The Parish asked for it to
 * go: a printed directory that gives a member's age is a different document
 * from one that says when to wish them, and the year was the only part of the
 * entry a household had reason to mind about. Migration 11 drops the column;
 * nothing here reads a year any more, and no form offers one.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

// February gets 29 — with no year, a leap-day date is always valid.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const MONTH_OPTIONS = MONTHS.map((name, i) => ({ value: i + 1, name }));

/** "14 - Mar", or "" when either half is missing. */
function format(day, month) {
  const d = Number(day);
  const m = Number(month);
  if (!Number.isInteger(d) || !Number.isInteger(m)) return '';
  if (m < 1 || m > 12 || d < 1 || d > DAYS_IN_MONTH[m - 1]) return '';
  return `${String(d).padStart(2, '0')} - ${MONTHS[m - 1]}`;
}

/**
 * Normalise a day/month pair coming off a form.
 * Both blank -> {day: null, month: null}. Anything invalid or half-filled
 * reports an error so the user can fix it rather than silently losing the date.
 *
 * When there is an error the numbers are still handed back, so the form can
 * show people what they typed instead of blanking the fields they got wrong.
 * Callers must therefore check `error` before writing any of this to the
 * database — the routes here refuse to save while any error is outstanding.
 */
function parse(dayRaw, monthRaw, label) {
  const dayText = String(dayRaw ?? '').trim();
  const monthText = String(monthRaw ?? '').trim();

  if (!dayText && !monthText) return { day: null, month: null, error: null };

  const asNumber = (text) => {
    const n = Number(text);
    return text && Number.isInteger(n) ? n : null;
  };
  const day = asNumber(dayText);
  const month = asNumber(monthText);
  const echo = (error) => ({ day, month, error });

  if (!dayText || !monthText) {
    return echo(`${label} needs both a day and a month.`);
  }
  if (month === null || month < 1 || month > 12) {
    return echo(`${label} has an invalid month.`);
  }
  if (day === null || day < 1 || day > DAYS_IN_MONTH[month - 1]) {
    return echo(`${label}: ${MONTHS[month - 1]} has only ${DAYS_IN_MONTH[month - 1]} days.`);
  }

  return { day, month, error: null };
}

/** Sort key for birthday/anniversary listings: month first, then day. */
function ordinal(day, month) {
  if (!day || !month) return Number.MAX_SAFE_INTEGER;
  return month * 100 + day;
}

module.exports = {
  MONTHS,
  MONTH_OPTIONS,
  DAYS_IN_MONTH,
  format,
  parse,
  ordinal
};
