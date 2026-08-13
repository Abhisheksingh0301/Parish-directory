'use strict';

/**
 * URL-safe identifiers for churches.
 *
 * A church is reached by slug rather than by number so a link means something
 * when it is pasted into an email. Uniqueness is global, because the slug is
 * the URL — two dioceses may both have a St Mary's, and the second one gets
 * "st-marys-2" rather than a clash.
 */

/** A slug from a name, or `fallback` if the name has nothing usable in it. */
function slugify(text, fallback = 'church') {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/**
 * `slugify`, then a numeric suffix until `isTaken` says it is free.
 * `isTaken` is async so the caller can ask the database.
 */
async function uniqueSlug(text, isTaken, fallback = 'church') {
  const base = slugify(text, fallback);
  if (!(await isTaken(base))) return base;

  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(`Could not find a free web address based on "${base}".`);
}

module.exports = { slugify, uniqueSlug };
