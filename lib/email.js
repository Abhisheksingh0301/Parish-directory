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

module.exports = { HTML_PATTERN, problem };
