'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

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

const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
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
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photo'));
  }
}).single('photo');

/**
 * Run multer but keep its failures as a friendly message on `req.photoError`
 * instead of a 500 — "that photo is too large" belongs on the form, next to
 * the field, with the rest of the user's answers still filled in.
 */
function acceptPhoto(req, res, next) {
  uploadPhoto(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      req.photoError =
        err.code === 'LIMIT_FILE_SIZE'
          ? `That photo is larger than ${Math.round(config.maxPhotoBytes / (1024 * 1024))} MB. Please use a smaller image.`
          : 'That file is not a supported image. Use a JPG, PNG, WebP or GIF.';
      return next();
    }
    next(err);
  });
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
  removePhoto,
  photoPath,
  relocateLegacyPhotos,
  maxBytes: config.maxPhotoBytes
};
