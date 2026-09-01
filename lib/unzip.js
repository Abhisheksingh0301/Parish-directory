'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { crc32 } = require('./zip');

/**
 * Reading a .zip, the other half of lib/zip.js.
 *
 * The parish sends its photographs the way anybody sends two hundred files:
 * a folder, right-clicked, "Compress" or "Send to → Compressed folder". So
 * something here has to open one.
 *
 * Written out rather than taken as a dependency, for the reason lib/zip.js and
 * lib/csv.js give: what a general archiver does for this job is an index at
 * the end of the file, a header per entry, and inflate — which Node already
 * ships in zlib. The whole format this needs is below.
 *
 * ── What it does differently from the writer ────────────────────────────────
 *
 *   It reads by range, not by slurping. An archive of two hundred photographs
 *   is a few hundred megabytes, and holding that in memory to look at the
 *   names in it would be absurd. The file stays on disk behind a descriptor,
 *   the index at the end is read, and each entry is pulled out one at a time.
 *   Peak memory is one photograph, whether the archive holds ten or a thousand.
 *
 *   It reads the central directory, not the local headers. Scanning forward
 *   through local headers looks simpler and is wrong: an archive written by a
 *   streaming writer puts the sizes *after* the data, in a descriptor the
 *   local header only hints at. The index at the end always has them.
 *
 *   It distrusts every number in the file. Sizes are checked against what was
 *   actually produced, checksums are verified, and inflate is given a hard
 *   output cap — a few kilobytes of zip can claim to expand to a terabyte, and
 *   an uploaded archive is exactly where somebody would try it.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

const STORED = 0;
const DEFLATED = 8;

/** Bit 0 of the general purpose flags: the entry is encrypted. */
const FLAG_ENCRYPTED = 0x0001;
/** Bit 11: the name is UTF-8 rather than the format's ancient default codepage. */
const FLAG_UTF8 = 0x0800;

/** The end record is 22 bytes plus a comment of at most 64 KB. */
const EOCD_SEARCH = 22 + U16_MAX;

/**
 * Something about the archive itself, rather than about what is in it.
 *
 * Its own type so a caller can put the message in front of the person who
 * uploaded the file instead of on an error page — the same division
 * lib/import-families.js draws with SheetError.
 */
class ArchiveError extends Error {}

class Archive {
  constructor(handle, entries) {
    this.handle = handle;
    this.entryList = entries;
  }

  /** Everything in the archive, directories and all, in the order stored. */
  entries() {
    return this.entryList;
  }

  /** Just the files: no directory markers, and nothing of zero length. */
  files() {
    return this.entryList.filter((e) => !e.isDirectory);
  }

  async readRange(offset, length) {
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) {
      throw new ArchiveError('The archive ends sooner than its own index says it should. It may not have finished uploading.');
    }
    return buffer;
  }

  /**
   * One entry's bytes.
   *
   * `maxBytes` is a real limit rather than a formality: it caps what inflate
   * is allowed to produce, so a small archive claiming to hold an enormous
   * file fails here instead of in the allocator.
   */
  async read(entry, { maxBytes = 64 * 1024 * 1024 } = {}) {
    if (entry.encrypted) {
      throw new ArchiveError(`"${entry.name}" is password-protected, so it cannot be read.`);
    }
    if (entry.size > maxBytes) {
      throw new ArchiveError(`"${entry.name}" is larger than this can unpack.`);
    }

    // The local header repeats the name and may carry a different amount of
    // extra data than the central one, so where the bytes actually start has
    // to be read from it rather than assumed.
    const header = await this.readRange(entry.headerOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL_SIG) {
      throw new ArchiveError(`"${entry.name}" is not where the archive's index says it is.`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const start = entry.headerOffset + 30 + nameLength + extraLength;

    const stored = await this.readRange(start, entry.compressedSize);

    let body;
    if (entry.method === STORED) {
      body = stored;
    } else if (entry.method === DEFLATED) {
      try {
        body = zlib.inflateRawSync(stored, { maxOutputLength: maxBytes });
      } catch (err) {
        throw new ArchiveError(`"${entry.name}" could not be unpacked. The archive may be damaged.`);
      }
    } else {
      throw new ArchiveError(
        `"${entry.name}" is compressed in a way this cannot read. Make the archive again with `
        + 'the ordinary "Compress" or "Send to → Compressed (zipped) folder" command.'
      );
    }

    if (body.length !== entry.size || crc32(body) !== entry.crc) {
      throw new ArchiveError(`"${entry.name}" did not survive the archive intact. It may have been damaged in transit — try making the zip again.`);
    }

    return body;
  }

  async close() {
    await this.handle.close().catch(() => {});
  }
}

/**
 * Find the end-of-central-directory record, which is the only fixed point in
 * the format: everything else is found through it. It sits at the very end
 * unless the archive carries a comment, so the tail is searched backwards.
 */
function findEndRecord(tail) {
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    // The comment length has to account for exactly the bytes that follow, or
    // this is four bytes of a photograph that happen to look like a signature.
    if (tail.readUInt16LE(i + 20) === tail.length - i - 22) return i;
  }
  return -1;
}

/**
 * A name the archive can be trusted with.
 *
 * Backslashes become slashes, and anything that climbs — "..", a leading "/",
 * a drive letter — is dropped rather than resolved. Nothing here is written to
 * a path built from an archive name (photographs are stored under a random
 * one), but a name is put in front of a person and compared against a Family
 * ID, and neither should be doing it with "../../etc" in hand.
 */
function safeEntryName(raw) {
  return String(raw)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
    .replace(/^[a-zA-Z]:/, '');
}

/** Replace the 0xffffffff placeholders from a ZIP64 extra field, in format order. */
function applyZip64(extra, entry) {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + size);
    at += 4 + size;

    if (id !== 0x0001) continue;

    let cursor = 0;
    const next = () => {
      if (cursor + 8 > body.length) return null;
      const value = Number(body.readBigUInt64LE(cursor));
      cursor += 8;
      return value;
    };

    if (entry.size === U32_MAX) entry.size = next() ?? entry.size;
    if (entry.compressedSize === U32_MAX) entry.compressedSize = next() ?? entry.compressedSize;
    if (entry.headerOffset === U32_MAX) entry.headerOffset = next() ?? entry.headerOffset;
    return;
  }
}

/**
 * Open an archive and read its index. The file stays open until `close()`, and
 * the caller is responsible for calling it.
 */
async function open(filePath) {
  const handle = await fs.promises.open(filePath, 'r');

  try {
    const { size } = await handle.stat();
    if (size < 22) {
      throw new ArchiveError('That file is too small to be a zip archive.');
    }

    const tailLength = Math.min(size, EOCD_SEARCH);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    const endAt = findEndRecord(tail);
    if (endAt === -1) {
      throw new ArchiveError(
        'That file is not a zip archive, or it did not finish uploading. Make the folder '
        + 'into a zip again and upload the whole file.'
      );
    }

    let count = tail.readUInt16LE(endAt + 10);
    let directorySize = tail.readUInt32LE(endAt + 12);
    let directoryOffset = tail.readUInt32LE(endAt + 16);

    // A big archive keeps the real numbers in a ZIP64 record, pointed at by a
    // locator immediately before the end record.
    if (count === U16_MAX || directorySize === U32_MAX || directoryOffset === U32_MAX) {
      const locatorAt = endAt - 20;
      if (locatorAt >= 0 && tail.readUInt32LE(locatorAt) === ZIP64_LOCATOR_SIG) {
        const recordOffset = Number(tail.readBigUInt64LE(locatorAt + 8));
        const record = Buffer.alloc(56);
        await handle.read(record, 0, 56, recordOffset);
        if (record.readUInt32LE(0) === ZIP64_EOCD_SIG) {
          count = Number(record.readBigUInt64LE(32));
          directorySize = Number(record.readBigUInt64LE(40));
          directoryOffset = Number(record.readBigUInt64LE(48));
        }
      }
    }

    if (directoryOffset + directorySize > size) {
      throw new ArchiveError('The archive\'s index points past the end of the file. It is damaged or incomplete.');
    }

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    const entries = [];
    let at = 0;

    for (let i = 0; i < count && at + 46 <= directory.length; i += 1) {
      if (directory.readUInt32LE(at) !== CENTRAL_SIG) break;

      const flags = directory.readUInt16LE(at + 8);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);

      const rawName = directory.subarray(at + 46, at + 46 + nameLength)
        // Bit 11 promises UTF-8. Without it the format says the name is in
        // MS-DOS's old codepage, and latin1 agrees with it for every character
        // a Family ID is made of.
        .toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1');

      const entry = {
        name: safeEntryName(rawName),
        method: directory.readUInt16LE(at + 10),
        crc: directory.readUInt32LE(at + 16),
        compressedSize: directory.readUInt32LE(at + 20),
        size: directory.readUInt32LE(at + 24),
        headerOffset: directory.readUInt32LE(at + 42),
        encrypted: !!(flags & FLAG_ENCRYPTED),
        isDirectory: /\/$/.test(rawName) || (nameLength > 0 && rawName.endsWith('/'))
      };

      applyZip64(directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength), entry);

      // A name that was nothing but "../" leaves an empty string behind, and a
      // zero-length entry is a directory marker under another spelling.
      if (entry.name) entries.push(entry);

      at += 46 + nameLength + extraLength + commentLength;
    }

    return new Archive(handle, entries);
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

module.exports = { open, ArchiveError, safeEntryName };
