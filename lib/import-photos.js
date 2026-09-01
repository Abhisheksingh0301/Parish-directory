'use strict';

const path = require('path');
const config = require('../config');
const Family = require('../models/family');
const unzip = require('./unzip');
const { storePhotoBuffer, removePhoto } = require('./upload');
const { matchesDeclaredType, readDimensions } = require('./image-dimensions');

/**
 * A folder of photographs, named after the families they belong to.
 *
 * The parish has the pictures long before it has this directory: two hundred
 * files in a folder on somebody's desktop, one per household. Adding them one
 * at a time through each family's own page is two hundred visits to two
 * hundred pages, and that is the reason a family entry goes to the printer
 * without a face on it.
 *
 * So: name each file after the Family ID it belongs to, zip the folder, upload
 * it once.
 *
 * ── Everything is checked before anything is stored ─────────────────────────
 *
 * The same promise the spreadsheet import makes, for the same reason, and it
 * costs more here: checking an image means unpacking it, so a clean archive is
 * unpacked twice — once to look at, once to keep. That is deliberate. Holding
 * two hundred decoded photographs in memory to save the second pass would be
 * hundreds of megabytes for a saving nobody asked for, and images are already
 * compressed formats, so inflating them is nearly free. Peak memory is one
 * photograph either way.
 *
 * ── What is checked, and why each one is worth refusing over ────────────────
 *
 *   The name matches a family.   A photograph named after a family that is not
 *                                in this directory has nowhere to go. Silently
 *                                skipping it is how a parish discovers at the
 *                                printer that forty entries have no face.
 *
 *   One photograph per family.   "F-001.jpg" and "F-001.png" in the same
 *                                folder is somebody's half-finished tidy-up.
 *                                Picking one is a guess; asking is not.
 *
 *   The bytes are what the name  A file renamed from .png to .jpg is still a
 *   claims.                      PNG, and every browser that displays it
 *                                anyway has taught people this works.
 *
 *   It is landscape.             Every photograph prints into a landscape
 *                                frame. A portrait one is cropped to a sliver
 *                                or loses the top of somebody's head, and the
 *                                place to find that out is not the proof copy.
 *                                The same rule the single-photo form enforces.
 */

/** What a file extension means here. The mimetype is then checked against the bytes. */
const BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

const TYPE_NAMES = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/gif': 'GIF'
};

/**
 * Files every operating system leaves in a folder and nobody put there.
 *
 * Ignored in silence rather than reported, which is the one place this import
 * departs from "nothing is passed over without saying so" — because the parish
 * did not create these, cannot see them in Explorer or Finder, and telling
 * them to delete a file they cannot find is worse than useless.
 */
function isSystemJunk(name) {
  const parts = name.split('/');
  const base = parts[parts.length - 1];
  return parts.includes('__MACOSX')
    || base.startsWith('._')
    || ['thumbs.db', '.ds_store', 'desktop.ini', '.picasa.ini'].includes(base.toLowerCase());
}

/** What an image actually is, from its own bytes, whatever it is called. */
function identify(buffer) {
  return Object.keys(TYPE_NAMES).find((type) => matchesDeclaredType(buffer, type)) || null;
}

const describe = (type) => TYPE_NAMES[type] || 'an image';

/**
 * Read the archive and decide, file by file, whether the whole thing can go in.
 *
 * Returns the problems in the order the files appear, the list of photographs
 * that would be stored, and what was passed over. Nothing is written.
 */
async function check({ archive, families, maxImageBytes = config.maxPhotoBytes }) {
  const problems = [];
  const ready = [];
  const ignored = [];
  const claimed = new Map();

  /*
   * Every problem is one finished sentence starting with the file it is about,
   * so the page can print the list without knowing how any of them were built,
   * and so a person reading it always knows which file to go and open.
   */
  const fail = (file, predicate) => problems.push({ file, message: `"${file}" ${predicate}` });

  for (const entry of archive.files()) {
    const name = entry.name;
    const base = path.posix.basename(name);

    if (isSystemJunk(name)) {
      ignored.push(name);
      continue;
    }

    const ext = path.posix.extname(base).toLowerCase();
    const mimetype = BY_EXTENSION[ext];

    if (!mimetype) {
      fail(name, ext
        ? `is not a photograph — the folder should hold only image files, one for each family. `
          + 'Take it out of the folder and make the zip again.'
        : 'has no file extension, so there is no telling what it is. '
          + 'A photograph should be named after its family, like "F-001.jpg".');
      continue;
    }

    const ref = base.slice(0, base.length - ext.length).trim();
    if (!ref) {
      fail(name, 'is named after nothing. Each file should be named for the family it '
        + 'belongs to, like "F-001.jpg".');
      continue;
    }

    const key = ref.toLowerCase();

    const alreadyClaimed = claimed.get(key);
    if (alreadyClaimed) {
      fail(name, `and "${alreadyClaimed}" are both named for family ${ref}. `
        + 'Only one photograph can be kept per family, so remove the one you do not want.');
      continue;
    }
    claimed.set(key, name);

    const family = families.get(key);
    if (!family) {
      fail(name, `is named for family ${ref}, and no family in this directory has that `
        + 'Family ID. Check the spelling against the directory, or import that family first.');
      continue;
    }

    if (entry.size > maxImageBytes) {
      const mb = (entry.size / (1024 * 1024)).toFixed(1);
      const cap = Math.round(maxImageBytes / (1024 * 1024));
      fail(name, `is ${mb} MB, and the largest a photograph may be is ${cap} MB. `
        + 'Save it at a smaller size and put it back in the folder.');
      continue;
    }

    let buffer;
    try {
      buffer = await archive.read(entry, { maxBytes: maxImageBytes });
    } catch (err) {
      // Damaged, encrypted, or compressed in a way this cannot open. The
      // reader's message already names the file and says what to do.
      if (!(err instanceof unzip.ArchiveError)) throw err;
      problems.push({ file: name, message: err.message });
      continue;
    }

    if (!matchesDeclaredType(buffer, mimetype)) {
      const actual = identify(buffer);
      fail(name, actual
        ? `is a ${describe(actual)} image with a ${ext} name. Renaming a file does not `
          + `convert it — open it and save it as ${describe(mimetype)}, or just rename it `
          + `to "${ref}${Object.keys(BY_EXTENSION).find((e) => BY_EXTENSION[e] === actual)}".`
        : 'is not an image file at all, whatever its name says. Replace it with the '
          + "family's photograph.");
      continue;
    }

    const size = readDimensions(buffer, mimetype);
    if (!size) {
      fail(name, 'could not be read as a photograph. It may be damaged — open it to check, '
        + 'and save it again.');
      continue;
    }

    if (size.width <= size.height) {
      fail(name, `is ${size.width}×${size.height}, which is `
        + `${size.width === size.height ? 'square' : 'taller than it is wide'}. Every `
        + 'photograph prints into a landscape frame, so it has to be wider than it is '
        + 'tall. Crop it before importing.');
      continue;
    }

    ready.push({
      entry,
      name,
      ref: family.family_id,
      familyId: family.id,
      headName: family.head_name,
      mimetype,
      replacing: family.photo || null
    });
  }

  return { problems, ready, ignored };
}

/**
 * Store the photographs the check approved.
 *
 * A family that already had one keeps it until the new file is on disk and the
 * row points at it; only then is the old file removed. The order matters —
 * deleting first and failing second would leave a family with a row pointing
 * at nothing.
 */
async function store({ archive, churchId, ready, maxImageBytes = config.maxPhotoBytes }) {
  const added = [];
  const replaced = [];
  const failed = [];

  for (const item of ready) {
    try {
      const buffer = await archive.read(item.entry, { maxBytes: maxImageBytes });
      const stored = await storePhotoBuffer(churchId, buffer, item.mimetype);

      const ok = await Family.setPhoto(churchId, item.familyId, stored);
      if (!ok) {
        // The family was deleted between the check and now. Take the orphaned
        // file back off the disk rather than leaving it there for ever.
        removePhoto(churchId, stored);
        failed.push({
          file: item.name,
          message: `family ${item.ref} is no longer in the directory`
        });
        continue;
      }

      if (item.replacing) {
        removePhoto(churchId, item.replacing);
        replaced.push(item);
      } else {
        added.push(item);
      }
    } catch (err) {
      failed.push({ file: item.name, message: err.message });
    }
  }

  return { added, replaced, failed };
}

module.exports = { check, store, isSystemJunk, identify, BY_EXTENSION };
