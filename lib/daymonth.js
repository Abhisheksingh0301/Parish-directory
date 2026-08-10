'use strict';

/**
 * Two date shapes live here.
 *
 * The **date of marriage** is day + month only — "14 - Mar". Stored as two
 * small integers rather than a date string, it stays sortable for the
 * anniversary list and we never have to invent a year nobody supplied.
 *
 * A **date of birth** is a full date — "02 - Aug - 1975" — but the year is
 * optional, so an entry can be filled in before anyone has asked the family
 * for it. Day and month are kept in their own columns for the same reason as
 * above: the birthday list sorts on them and does not care about the year.
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

// ---------------------------------------------------------------------------
// Dates of birth — the same day and month, with an optional year
// ---------------------------------------------------------------------------

const EARLIEST_BIRTH_YEAR = 1900;

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** How many days that month really had, once a year is known. */
function daysIn(month, year) {
  if (month === 2 && Number.isInteger(year)) return isLeapYear(year) ? 29 : 28;
  return DAYS_IN_MONTH[month - 1];
}

/** "02 - Aug - 1975", falling back to "02 - Aug" when no year was given. */
function formatFull(day, month, year) {
  const base = format(day, month);
  if (!base) return '';

  // Guard the empties explicitly: Number(null) and Number('') are both 0,
  // which would otherwise print a missing year as "02 - Aug - 0".
  if (year === null || year === undefined || year === '') return base;

  const y = Number(year);
  return Number.isInteger(y) && y > 0 ? `${base} - ${y}` : base;
}

/**
 * Normalise a date of birth off a form. The year is optional, so a family can
 * be recorded before anyone has asked for it — but a year that is given has to
 * be a real one, and 29 February only survives in a leap year.
 */
function parseFull(dayRaw, monthRaw, yearRaw, label) {
  const base = parse(dayRaw, monthRaw, label);
  const yearText = String(yearRaw ?? '').trim();

  const year = yearText && Number.isInteger(Number(yearText)) ? Number(yearText) : null;
  // As in `parse`, an error still hands the numbers back for redisplay.
  const echo = (error) => ({ day: base.day, month: base.month, year, error });

  if (base.error) return echo(base.error);
  if (!yearText) return { ...base, year: null };

  if (base.day === null) {
    return echo(`${label} needs a day and a month as well as a year.`);
  }

  const thisYear = new Date().getFullYear();

  if (year === null || year < EARLIEST_BIRTH_YEAR || year > thisYear) {
    return echo(`${label} must have a year between ${EARLIEST_BIRTH_YEAR} and ${thisYear}.`);
  }
  if (base.day > daysIn(base.month, year)) {
    return echo(
      `${label}: ${MONTHS[base.month - 1]} ${year} has only ${daysIn(base.month, year)} days.`
    );
  }

  return { day: base.day, month: base.month, year, error: null };
}

module.exports = {
  MONTHS,
  MONTH_OPTIONS,
  DAYS_IN_MONTH,
  EARLIEST_BIRTH_YEAR,
  format,
  formatFull,
  parse,
  parseFull,
  ordinal
};
