'use strict';

/**
 * Email addresses for the directory.
 *
 * A family's address is also its login username and one entry in the line the
 * parish office pastes into a message to the whole parish, so a typo is not
 * cosmetic — it is a household nobody can reach and an account nobody can sign
 * in to. The browser's own `type=email` is far too forgiving here: it accepts
 * "steve@gmail", because a bare hostname is a real address on a local network
 * and no address at all on the internet.
 *
 * So this is deliberately stricter than the RFC. Quoted local parts, comments
 * and address literals are all legal to a mail server; none of them belong in
 * a parish directory, and every one of them is far likelier to be a typo.
 */

const MAX_LENGTH = 254; // the longest address an SMTP envelope can carry
const MAX_LOCAL = 64;
const MAX_LABEL = 63;

const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
const ENDING = /^[A-Za-z]{2,}$/;

/**
 * The same shape as a `pattern` attribute, so the browser can object before
 * the form is sent. Looser than the checks below — the server has the last
 * word — but it does catch the missing ".com" the built-in check waves through.
 */
const HTML_PATTERN = '[^@\\s]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}';

/**
 * Why this address cannot be used, written for the person who typed it, or
 * null if it is fine. Blank is not this function's business: an email address
 * is optional in some places and required in others, and only the caller
 * knows which.
 */
function problem(value) {
  const address = String(value ?? '').trim();
  if (!address) return null;

  const quoted = `"${address}"`;

  if (/\s/.test(address)) return `${quoted} has a space in it.`;
  if (address.length > MAX_LENGTH) return `${quoted} is too long to be an email address.`;

  const parts = address.split('@');
  if (parts.length === 1) {
    return `${quoted} has no @ in it — an email address looks like name@example.com.`;
  }
  if (parts.length > 2) return `${quoted} has more than one @.`;

  const local = parts[0];
  const domain = parts[1];

  if (!local) return `${quoted} has nothing before the @.`;
  if (local.length > MAX_LOCAL) return `The part before the @ in ${quoted} is too long.`;
  if (!LOCAL.test(local)) {
    return `The part before the @ in ${quoted} is not a name an address can have.`;
  }

  if (!domain) return `${quoted} has nothing after the @.`;

  const labels = domain.split('.');
  if (labels.length < 2) {
    // The one this was written for: "steve@gmail" looks finished and is not.
    return `${quoted} is missing the end of the domain — did you mean ${address}.com?`;
  }
  if (labels.some((label) => label.length > MAX_LABEL || !LABEL.test(label))) {
    return `The part after the @ in ${quoted} is not a domain name.`;
  }
  if (!ENDING.test(labels[labels.length - 1])) {
    return `${quoted} does not end with a domain ending such as .com or .in.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Several addresses in one field
// ---------------------------------------------------------------------------

/**
 * A member may list more than one address, and often does — a personal one and
 * a work one. Three is the ceiling: beyond that it is a contact list rather
 * than a directory entry, and each address printed has to fit the cell it goes
 * into.
 *
 * The family's own `email` is a different thing and stays single: it is the
 * household's login username, and an account cannot have three of those.
 */
const MAX_ADDRESSES = 3;

/** Stored as one field, addresses separated by commas. Printed one per line. */
const SEPARATOR = ',';

/** A comma, a semicolon, or any run of whitespace. */
const SPLIT_ON = /[,;\s]+/;

/** The same shape as a `pattern` attribute, for a field holding a list. */
const HTML_PATTERN_LIST =
  HTML_PATTERN + '([,; ]+' + HTML_PATTERN + '){0,' + (MAX_ADDRESSES - 1) + '}';

/** The addresses in a field, tidied but not otherwise altered. */
function split(value) {
  return String(value ?? '')
    .split(SPLIT_ON)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** What is stored: the addresses alone, comma-separated, in the order given. */
function normaliseList(value) {
  return split(value).join(SEPARATOR);
}

/** The addresses to print, one per line. */
function list(value) {
  return split(value);
}

/**
 * Why this field cannot be used, or null if every address in it is fine.
 *
 * Each address is judged on its own and quoted in the message, because "one of
 * these is wrong" is no use against a field holding three of them.
 */
function listProblem(value, who) {
  const addresses = split(value);
  if (!addresses.length) return null;

  const whose = who ? ` for ${who}` : '';

  if (addresses.length > MAX_ADDRESSES) {
    return `${addresses.length} email addresses${whose} — keep it to ${MAX_ADDRESSES}, ` +
      'which is what the printed entry has room for.';
  }

  for (const address of addresses) {
    const bad = problem(address);
    if (bad) return who ? `For ${who}: ${bad}` : bad;
  }

  const seen = new Set();
  for (const address of addresses.map((a) => a.toLowerCase())) {
    if (seen.has(address)) return `The address "${address}"${whose} is listed twice.`;
    seen.add(address);
  }

  return null;
}

module.exports = {
  HTML_PATTERN,
  HTML_PATTERN_LIST,
  MAX_ADDRESSES,
  problem,
  normaliseList,
  list,
  listProblem
};
