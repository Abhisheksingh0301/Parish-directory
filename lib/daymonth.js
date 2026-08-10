'use strict';

/**
 * Day-and-month dates, with no year.
 *
 * DOM (date of marriage) and DOB are both recorded and printed as day + month
 * only — "14 - Mar". Storing them as two small integers rather than a date
 * string keeps them sortable (birthday and anniversary lists) and means we
 * never have to invent a year we don't have.
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
 */
function parse(dayRaw, monthRaw, label) {
  const dayText = String(dayRaw ?? '').trim();
  const monthText = String(monthRaw ?? '').trim();

  if (!dayText && !monthText) return { day: null, month: null, error: null };

  if (!dayText || !monthText) {
    return { day: null, month: null, error: `${label} needs both a day and a month.` };
  }

  const day = Number(dayText);
  const month = Number(monthText);

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { day: null, month: null, error: `${label} has an invalid month.` };
  }
  if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]) {
    return {
      day: null,
      month: null,
      error: `${label}: ${MONTHS[month - 1]} has only ${DAYS_IN_MONTH[month - 1]} days.`
    };
  }

  return { day, month, error: null };
}

/** Sort key for birthday/anniversary listings: month first, then day. */
function ordinal(day, month) {
  if (!day || !month) return Number.MAX_SAFE_INTEGER;
  return month * 100 + day;
}

module.exports = { MONTHS, MONTH_OPTIONS, DAYS_IN_MONTH, format, parse, ordinal };
