'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { matchesDeclaredType, readDimensions } = require('./image-dimensions');

/**
 * Photographs.
 *
 * Stored under `uploads/<churchId>/`, one folder per parish. Two reasons, and
 * both matter:
 *
 *   Isolation. Filenames are random, so guessing one was never realistic — but
 *   once churches are unrelated organisations, "unlikely" is a weaker promise
 *   than "checked", and a folder per church gives the server something to
 *   check against.
 *
 *   Size. Two hundred churches of two hundred families is forty thousand
 *   images, and directory enumeration on NTFS is slow well before that —
 *   backups, antivirus and any readdir all pay for it. Two hundred folders of
 *   two hundred files is a shape every tool is happy with.
 *
 * The database stores only the filename. Which folder it lives in follows from
 * the family's church, so moving a church's photographs never touches a row.
 */

/**
 * What the form says, and what the server does.
 *
 * The page asks for a JPG, in those words, because that is what a parish
 * office has: it is what every phone and every camera in the parish writes,
 * and one plain instruction is worth more to the person at the desk than a
 * list of five formats they have never had to think about.
 *
 * Nothing here refuses the others, though. Somebody who has a PNG because
 * they cropped it in Paint, or a WebP because they saved it out of a browser,
 * is not sent away to convert it first — the file is taken and stored exactly
 * as it arrived. The instruction is guidance; this is the rule.
 *
 * The rule is: every image format a browser will display, and only those. Not
 * a restriction for its own sake — a photograph the printed directory cannot
 * render is not a photograph that has been accepted, it is a broken picture
 * discovered later, and the office is better told now. `REFUSED` below names
 * the formats worth saying something specific about.
 */
const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif'
};

/**
 * Formats that arrive often enough to deserve their own answer.
 *
 * HEIC is what an iPhone writes by default, so it is the single most likely
 * thing to be handed to this form after a JPG — and "not a supported image"
 * would be a useless reply to somebody who has just taken a photograph on
 * their phone. TIFF comes off scanners. Both are told the one thing that
 * helps, which is how to get a JPG out of what they have.
 *
 * SVG is refused on different grounds and must stay refused: it is a document
 * that can carry script, it would be served back from this application's own
 * origin, and it is not a photograph of anybody's family in any case.
 */
const REFUSED = {
  'image/heic': 'iPhone photos (HEIC) need saving as JPG first — in Photos, ' +
    'choose Share, then Options, and turn Most Compatible on.',
  'image/heif': 'iPhone photos (HEIC) need saving as JPG first — in Photos, ' +
    'choose Share, then Options, and turn Most Compatible on.',
  'image/tiff': 'A TIFF cannot be shown in the printed directory. Open it and ' +
    'save it as a JPG.',
  'image/svg+xml': 'That is a drawing file, not a photograph. Please upload a ' +
    'JPG taken with a camera or phone.'
};

/** The folder holding one church's photographs, created on demand. */
function churchDir(churchId) {
  const id = Number(churchId);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error('A church is required to store a photograph.');
  }
  const dir = path.join(config.uploadDir, String(id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where a stored photograph lives, refusing anything that escapes the folder. */
function photoPath(churchId, filename) {
  const dir = path.join(config.uploadDir, String(Number(churchId)));
  // basename first: the filename comes out of the database, and a crafted one
  // must not be able to climb out of the uploads tree.
  const target = path.resolve(dir, path.basename(String(filename)));
  return target.startsWith(path.resolve(config.uploadDir)) ? target : null;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      cb(null, churchDir(req.churchId));
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    // Random name: the original filename is attacker-controlled, and two
    // families uploading "photo.jpg" must not collide.
    const ext = ALLOWED[file.mimetype] || path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

const uploadPhoto = multer({
  storage,
  limits: { fileSize: config.maxPhotoBytes, files: 1 },
  fileFilter(req, file, cb) {
    if (ALLOWED[file.mimetype]) return cb(null, true);

    /*
     * Why the reason is carried on the request rather than thrown.
     *
     * multer's error has room for a code and a field name, not a sentence, so
     * refusing a HEIC through it would lose the only part of the answer worth
     * reading — how to turn it into something this form can take. The reason
     * is left here and picked up in `acceptPhoto`, which is where every other
     * message about this photograph is assembled.
     */
    req.photoRefusal = REFUSED[String(file.mimetype).toLowerCase()]
      || 'That file is not an image this directory can show. Please upload a JPG.';
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photo'));
  }
}).single('photo');

/**
 * Every photograph prints into a landscape frame, so a portrait or square
 * photo would either be cropped down to a sliver of itself or leave the
 * subject's head cut off — neither is something to discover after the book
 * is at the printer. Checked against the file's own bytes, not the
 * mimetype the request declared, which is exactly the value an attacker
 * controls.
 *
 * Returns a message for the form, or `null` when the photo is fine.
 */
async function landscapeProblem(file) {
  const buffer = await fs.promises.readFile(file.path);

  if (!matchesDeclaredType(buffer, file.mimetype)) {
    return 'That file does not look like a valid image. Please choose a photo straight from your camera or phone.';
  }

  const size = readDimensions(buffer, file.mimetype);
  if (!size) {
    return 'That photo could not be read. Please try a different file.';
  }

  /*
   * Against the displayed shape, not the stored one. A phone held sideways
   * writes a portrait frame and an EXIF tag that turns it a quarter turn, and
   * readDimensions has already applied that — so a photograph that looks
   * landscape to the person uploading it is landscape here too. Telling
   * somebody their landscape photograph is not landscape is the kind of
   * refusal nobody can act on.
   */
  if (size.width <= size.height) {
    return 'That photo is not landscape. Please upload one that is wider than it is tall.';
  }

  return null;
}

/**
 * Run multer but keep its failures as a friendly message on `req.photoError`
 * instead of a 500 — "that photo is too large" belongs on the form, next to
 * the field, with the rest of the user's answers still filled in.
 */
function acceptPhoto(req, res, next) {
  uploadPhoto(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        req.photoError =
          err.code === 'LIMIT_FILE_SIZE'
            ? `That photo is larger than ${Math.round(config.maxPhotoBytes / (1024 * 1024))} MB. `
              + 'Please use a smaller image.'
            : (req.photoRefusal || 'That file is not an image this directory can show. '
              + 'Please upload a JPG.');
        req.photoRefusal = undefined;
        return next();
      }
      return next(err);
    }

    if (req.file) {
      const problem = await landscapeProblem(req.file).catch(
        () => 'That photo could not be read. Please try a different file.'
      );
      if (problem) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        req.photoError = problem;
        req.file = undefined;
      }
    }

    next();
  });
}

/**
 * Store a photograph already in memory, under a name of this application's
 * choosing, and return that name.
 *
 * The bulk import needs this: its images arrive inside a zip rather than as a
 * multipart field, so multer's disk storage never sees them, but everything
 * after that point must be identical — the same folder per church, the same
 * random filename, the same extension taken from the type the bytes actually
 * are. A second convention for photographs that arrived a different way is a
 * second convention to keep working.
 *
 * The name from the archive is deliberately not reused. It is chosen by
 * whoever made the zip, it is the Family ID in plain sight, and two parishes
 * are free to number a family the same — a random name has none of those
 * problems, and the database has always stored only the filename.
 */
async function storePhotoBuffer(churchId, buffer, mimetype) {
  const ext = ALLOWED[mimetype];
  if (!ext) throw new Error(`Not a photograph this directory stores: ${mimetype}`);

  const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  await fs.promises.writeFile(path.join(churchDir(churchId), name), buffer);
  return name;
}

/** Remove a stored photo, ignoring the case where it is already gone. */
function removePhoto(churchId, filename) {
  if (!filename || !churchId) return;
  const target = photoPath(churchId, filename);
  if (!target) return;
  fs.promises.unlink(target).catch(() => {});
}

/**
 * Move photographs left in the flat `uploads/` folder into their church's own.
 *
 * An install that predates this change has every image in one directory. The
 * filename in the database does not change — only where it sits — so this runs
 * once at start-up, finds anything still loose, and files it. Safe to run
 * again: it only moves what is actually there.
 */
async function relocateLegacyPhotos(db) {
  let moved = 0;

  const families = await db.Family.findAll({
    attributes: ['photo', 'church_id'],
    where: { photo: { [db.Op.ne]: null } },
    raw: true
  });

  for (const { photo, church_id: churchId } of families) {
    if (!photo || !churchId) continue;

    const legacy = path.resolve(config.uploadDir, path.basename(photo));
    if (!legacy.startsWith(path.resolve(config.uploadDir))) continue;
    if (!fs.existsSync(legacy)) continue;

    // Only files sitting directly in uploads/ are legacy; anything already in
    // a church folder resolves elsewhere and is skipped by the check above.
    const destination = photoPath(churchId, photo);
    if (!destination || fs.existsSync(destination)) continue;

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(legacy, destination);
    moved += 1;
  }

  if (moved) {
    console.log(`Moved ${moved} photograph${moved === 1 ? '' : 's'} into their church's folder.`);
  }
  return moved;
}

module.exports = {
  acceptPhoto,
  storePhotoBuffer,
  removePhoto,
  photoPath,
  relocateLegacyPhotos,
  ALLOWED,
  REFUSED,
  maxBytes: config.maxPhotoBytes
};
