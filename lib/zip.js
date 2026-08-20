'use strict';

const fs = require('fs');

/**
 * Writing a .zip, straight down a response.
 *
 * An export that hands over the spreadsheet but leaves the photographs behind
 * is half an export — the parish wants what the book is made of, and the book
 * has faces in it. One file they can send to the printer is the point, so
 * something here has to make an archive.
 *
 * Written out rather than taken as a dependency, for the same reason
 * lib/csv.js is: what an archiver does for this job is a header, a checksum
 * and a table at the end, and this needs exactly one shape of them.
 *
 *   Stored, not deflated. Everything going in is a JPEG, PNG, WebP or GIF —
 *   already compressed — plus one small spreadsheet. Deflate would spend CPU
 *   per megabyte to save almost nothing, and the operator is watching a
 *   download bar while it happens.
 *
 *   Streamed, not assembled. A whole-installation export is thousands of
 *   photographs; buffering them to measure the archive first would hold the
 *   lot in memory. Entries go out as they are read, and only the central
 *   directory — a few dozen bytes per file — is kept.
 *
 *   ZIP64 when it is needed. Forty thousand photographs is past the 65,535
 *   entries and the 4 GB a classic archive can describe. The extra fields are
 *   written per entry only when that entry needs them, so an ordinary parish
 *   export stays a plain zip that anything can open.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/** Bit 11: the name is UTF-8, not the archive format's ancient default codepage. */
const FLAG_UTF8 = 0x0800;

let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }

  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

/** A date as MS-DOS packed it in 1980, which is what the format still stores. */
function dosDateTime(date) {
  const when = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  };
}

/**
 * A name the archive can carry: forward slashes, no drive letters, and nothing
 * that climbs out of the folder it is unpacked into.
 *
 * Names here are built from parish data — a family id, a church name — so they
 * are not arbitrary, but they are not constants either, and a "../" reaching
 * one would be an archive that writes outside its own directory.
 */
function safeName(name) {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim().replace(/^\.+$/, '').replace(/[\u0000-\u001f:*?"<>|]/g, '_'))
    .filter(Boolean)
    .join('/');
}

class ZipWriter {
  constructor(stream) {
    this.stream = stream;
    this.offset = 0;
    this.entries = [];
    this.finished = false;
  }

  /** Write, waiting for the socket to drain rather than filling memory. */
  async write(chunk) {
    this.offset += chunk.length;
    if (this.stream.write(chunk)) return;

    await new Promise((resolve, reject) => {
      const onDrain = () => { this.stream.off('error', onError); resolve(); };
      const onError = (err) => { this.stream.off('drain', onDrain); reject(err); };
      this.stream.once('drain', onDrain);
      this.stream.once('error', onError);
    });
  }

  /** One file, from a Buffer or a string already in hand. */
  async add(name, contents, { date = new Date() } = {}) {
    const body = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
    await this.entry(safeName(name), body, crc32(body), date);
  }

  /**
   * One file, from disk.
   *
   * Read into memory rather than streamed: the checksum has to be known before
   * the header goes out, and a photograph is capped at a few megabytes.
   * Nothing else is held while it happens, so peak memory is one image whether
   * the archive holds ten or ten thousand.
   *
   * A file that has vanished since it was listed is skipped and reported back
   * as false, not thrown — one missing photograph must not cost the parish the
   * whole export.
   */
  async addFile(name, filePath, { date = null } = {}) {
    let body;
    let stat;
    try {
      body = await fs.promises.readFile(filePath);
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      return false;
    }

    await this.entry(safeName(name), body, crc32(body), date || stat.mtime);
    return true;
  }

  /** Local header, then the bytes, keeping what the table at the end needs. */
  async entry(name, body, crc, date) {
    if (this.finished) throw new Error('This archive has already been finished.');

    const nameBytes = Buffer.from(name, 'utf8');
    const stamp = dosDateTime(date);
    const size = body.length;
    // The size is known here, so only where this entry starts can force ZIP64
    // on its local header.
    const zip64 = size > U32_MAX || this.offset > U32_MAX;
    const offset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(zip64 ? U32_MAX : size, 18);
    header.writeUInt32LE(zip64 ? U32_MAX : size, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(zip64 ? 20 : 0, 28);

    await this.write(header);
    await this.write(nameBytes);

    if (zip64) {
      const extra = Buffer.alloc(20);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(size), 12);
      await this.write(extra);
    }

    await this.write(body);

    this.entries.push({ nameBytes, size, crc, offset, time: stamp.time, date: stamp.date });
  }

  /** The central directory and the end record. Nothing may be added after it. */
  async finish() {
    if (this.finished) return;
    this.finished = true;

    const start = this.offset;

    for (const e of this.entries) {
      /*
       * Anything too big for its 32-bit field moves into the extra block, in
       * the order the format fixes: uncompressed size, compressed size, then
       * offset. A field that fits is simply absent, which is why an ordinary
       * archive from here has no ZIP64 anywhere in it.
       */
      const sizeOverflows = e.size > U32_MAX;
      const offsetOverflows = e.offset > U32_MAX;
      const extraValues = [
        ...(sizeOverflows ? [e.size, e.size] : []),
        ...(offsetOverflows ? [e.offset] : [])
      ];
      const extraLength = extraValues.length ? 4 + extraValues.length * 8 : 0;

      const central = Buffer.alloc(46);
      central.writeUInt32LE(CENTRAL_SIG, 0);
      central.writeUInt16LE(extraLength ? 45 : 20, 4); // version made by
      central.writeUInt16LE(extraLength ? 45 : 20, 6); // version needed
      central.writeUInt16LE(FLAG_UTF8, 8);
      central.writeUInt16LE(0, 10); // stored
      central.writeUInt16LE(e.time, 12);
      central.writeUInt16LE(e.date, 14);
      central.writeUInt32LE(e.crc, 16);
      central.writeUInt32LE(sizeOverflows ? U32_MAX : e.size, 20);
      central.writeUInt32LE(sizeOverflows ? U32_MAX : e.size, 24);
      central.writeUInt16LE(e.nameBytes.length, 28);
      central.writeUInt16LE(extraLength, 30);
      central.writeUInt16LE(0, 32); // no comment
      central.writeUInt16LE(0, 34); // one disk
      central.writeUInt16LE(0, 36); // internal attributes
      central.writeUInt32LE(0, 38); // external attributes
      central.writeUInt32LE(offsetOverflows ? U32_MAX : e.offset, 42);

      await this.write(central);
      await this.write(e.nameBytes);

      if (extraLength) {
        const extra = Buffer.alloc(extraLength);
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(extraLength - 4, 2);
        extraValues.forEach((value, i) => extra.writeBigUInt64LE(BigInt(value), 4 + i * 8));
        await this.write(extra);
      }
    }

    const size = this.offset - start;
    const count = this.entries.length;

    if (count > U16_MAX || size > U32_MAX || start > U32_MAX) {
      const record = Buffer.alloc(56);
      record.writeUInt32LE(ZIP64_EOCD_SIG, 0);
      record.writeBigUInt64LE(BigInt(44), 4); // the rest of this record
      record.writeUInt16LE(45, 12); // version made by
      record.writeUInt16LE(45, 14); // version needed
      record.writeUInt32LE(0, 16); // this disk
      record.writeUInt32LE(0, 20); // the disk holding the directory
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(size), 40);
      record.writeBigUInt64LE(BigInt(start), 48);
      await this.write(record);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(start + size), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(locator);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD_SIG, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(count, U16_MAX), 8);
    end.writeUInt16LE(Math.min(count, U16_MAX), 10);
    end.writeUInt32LE(size > U32_MAX ? U32_MAX : size, 12);
    end.writeUInt32LE(start > U32_MAX ? U32_MAX : start, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
  }
}

/** A writer over any writable stream — a response, or a file. */
function create(stream) {
  return new ZipWriter(stream);
}

module.exports = { create, safeName, crc32 };
