'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, config.uploadDir);
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
function removePhoto(filename) {
  if (!filename) return;
  // Defend the upload directory against a crafted filename in the database.
  const target = path.resolve(config.uploadDir, path.basename(filename));
  if (!target.startsWith(path.resolve(config.uploadDir))) return;
  fs.promises.unlink(target).catch(() => {});
}

module.exports = { acceptPhoto, removePhoto, maxBytes: config.maxPhotoBytes };
