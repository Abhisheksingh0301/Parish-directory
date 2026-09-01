'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

/**
 * Accepting the two files the Manage pages take: the family sheet, and the
 * archive of photographs.
 *
 * Kept apart from lib/upload.js, which is about one photograph posted with one
 * family. The two here differ from that and from each other in where the bytes
 * go, which is the whole of what these are.
 *
 * ── The sheet ───────────────────────────────────────────────────────────────
 *
 * It never reaches the disk. A parish sheet is tens
 * of kilobytes, it is read once and then it is either imported or reported on,
 * and a file written to disk is a file somebody has to remember to delete —
 * after a failed parse, after a rejected row, after the process is killed
 * halfway. Holding it in memory makes the whole question disappear.
 *
 * The cap is well under what the request body limits allow and far above any
 * real parish: a thousand-family sheet with ten columns of text is a few
 * hundred kilobytes. It exists to stop a mistake, not to be a quota.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MB = Math.round(MAX_BYTES / (1024 * 1024));

/**
 * What a browser calls a CSV depends on the operating system and, on Windows,
 * on which program is registered for the extension — text/csv,
 * application/vnd.ms-excel and application/octet-stream are all seen for the
 * same file. So the extension decides, and the bytes are checked afterwards.
 *
 * The one thing worth refusing by name is .xlsx, because it is the mistake
 * people actually make and "that file is not a CSV" does not tell them what to
 * do about it.
 */
function extensionProblem(originalname) {
  const name = String(originalname || '');
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();

  if (ext === '.csv') return null;

  if (ext === '.xlsx' || ext === '.xls' || ext === '.ods') {
    return 'That is an Excel workbook, which cannot be read directly. Open it, '
      + 'choose File → Save As, pick "CSV (comma delimited)" and upload that file instead.';
  }

  return 'That file is not a spreadsheet saved as CSV. Fill in the template above '
    + 'and save it as a .csv file.';
}

/**
 * A workbook renamed to .csv is still a workbook, and it arrives as a zip.
 * Reading it as text would produce a screenful of nonsense rows and a list of
 * problems that tells the office nothing, so it is caught by its own bytes and
 * answered with the same sentence as an honestly named one.
 */
function contentProblem(buffer) {
  if (!buffer || !buffer.length) {
    return 'That file is empty.';
  }
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return 'That file is an Excel workbook that has been renamed, not a CSV. Open it, '
      + 'choose File → Save As and pick "CSV (comma delimited)".';
  }
  // A UTF-16 sheet — "Unicode Text" in Excel's Save As list — is not readable
  // as UTF-8 and would come back as unrecognised columns rather than as this.
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) {
    return 'That file was saved as Unicode Text rather than CSV. Save it again, '
      + 'choosing "CSV (comma delimited)".';
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const problem = extensionProblem(file.originalname);
    if (problem) {
      // Refused here rather than thrown, so the message reaches the page as
      // itself instead of as multer's own wording for an unexpected file.
      req.sheetError = problem;
      return cb(null, false);
    }
    return cb(null, true);
  }
}).single('sheet');

/**
 * Run multer, but keep every failure as a sentence on `req.sheetError` rather
 * than a 500. "That file is too large" belongs on the import page under the
 * button, with the instructions still on screen.
 */
function acceptSheet(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        req.sheetError = err.code === 'LIMIT_FILE_SIZE'
          ? `That file is larger than ${MAX_MB} MB, which is far bigger than any parish sheet. `
            + 'Check that it is the spreadsheet and not something else.'
          : 'Only one file can be uploaded at a time.';
        return next();
      }
      return next(err);
    }

    if (req.file && !req.sheetError) {
      const problem = contentProblem(req.file.buffer);
      if (problem) {
        req.sheetError = problem;
        req.file = undefined;
      }
    }

    return next();
  });
}


// ---------------------------------------------------------------------------
// The archive of photographs
// ---------------------------------------------------------------------------

/**
 * The zip does reach the disk, and has to.
 *
 * A folder of two hundred photographs is a few hundred megabytes, and the
 * archive is read by seeking to the index at its end — neither of which
 * survives being held in memory as a single Buffer. So it lands in a scratch
 * folder under the data directory, is read from there, and is deleted in a
 * `finally` whatever happens. Under the data directory rather than the system
 * temp folder for one practical reason: it is the same volume the photographs
 * are written to and the same one the operator already gave this application
 * room on.
 */
const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;
const ARCHIVE_MAX_MB = Math.round(ARCHIVE_MAX_BYTES / (1024 * 1024));

const scratchDir = path.join(config.dataDir, 'tmp');

function archiveProblem(originalname) {
  const name = String(originalname || '');
  const ext = path.extname(name).toLowerCase();

  if (ext === '.zip') return null;

  if (['.rar', '.7z', '.tar', '.gz', '.tgz'].includes(ext)) {
    return `A ${ext} archive cannot be read. Select the folder of photographs, right-click it `
      + 'and choose "Send to → Compressed (zipped) folder" on Windows, or "Compress" on a Mac, '
      + 'and upload the .zip that appears beside it.';
  }

  return 'That is not a zip archive. Put the photographs in one folder, right-click it and '
    + 'choose "Send to → Compressed (zipped) folder" on Windows, or "Compress" on a Mac.';
}

const archiveStorage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      fs.mkdirSync(scratchDir, { recursive: true });
      cb(null, scratchDir);
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    // The uploaded name is chosen by whoever made the archive; it never
    // becomes a path here.
    cb(null, `photos-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.zip`);
  }
});

const uploadArchive = multer({
  storage: archiveStorage,
  limits: { fileSize: ARCHIVE_MAX_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const problem = archiveProblem(file.originalname);
    if (problem) {
      req.archiveError = problem;
      return cb(null, false);
    }
    return cb(null, true);
  }
}).single('archive');

/**
 * Delete the upload once the response is over, whatever happened to it.
 *
 * This middleware creates the file, so this middleware owns removing it. The
 * route deletes it too, as soon as it has finished reading — but the route is
 * not always reached. Multer has to run before the CSRF check, because `_csrf`
 * is inside the body it parses, so a stale form is rejected *after* the
 * archive is on disk and the route never sees it. Without this, every expired
 * form would leave up to two hundred megabytes behind.
 *
 * Tied to the response rather than to the route for that reason: it is the one
 * thing that happens on every path out, including the ones that never get as
 * far as a handler.
 */
function discardWhenDone(res, filePath) {
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    fs.promises.unlink(filePath).catch(() => {});
  };
  // 'finish' for an ordinary response, 'close' for a client that gave up.
  res.once('finish', remove);
  res.once('close', remove);
}

/**
 * Run multer for the archive, keeping failures as a sentence on
 * `req.archiveError`.
 */
function acceptArchive(req, res, next) {
  uploadArchive(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        req.archiveError = err.code === 'LIMIT_FILE_SIZE'
          ? `That archive is larger than ${ARCHIVE_MAX_MB} MB. Photographs straight from a `
            + 'phone or camera are far bigger than a printed directory needs — save them at a '
            + 'smaller size, or upload the parish in two or three batches.'
          : 'Only one archive can be uploaded at a time.';
        return next();
      }
      return next(err);
    }

    if (req.file && req.file.path) discardWhenDone(res, req.file.path);
    return next();
  });
}

/**
 * Delete anything left in the scratch folder, called once at start-up.
 *
 * The route deletes its own upload in a `finally`, so the only way a file
 * survives is the one that finally cannot cover: the process being killed
 * while a request is in flight. Without this, every crash during an upload
 * leaves a few hundred megabytes behind for ever, and nothing ever looks in
 * the folder again.
 *
 * Safe because nothing here outlives its request — a file in this folder is by
 * definition abandoned by the time the application is starting up.
 */
async function sweepScratch() {
  let removed = 0;

  const names = await fs.promises.readdir(scratchDir).catch(() => []);
  for (const name of names) {
    if (await fs.promises.unlink(path.join(scratchDir, name)).then(() => true, () => false)) {
      removed += 1;
    }
  }

  if (removed) {
    console.log(`Cleared ${removed} abandoned upload${removed === 1 ? '' : 's'} from the scratch folder.`);
  }
  return removed;
}

module.exports = {
  acceptSheet,
  maxBytes: MAX_BYTES,
  acceptArchive,
  archiveMaxBytes: ARCHIVE_MAX_BYTES,
  sweepScratch
};
