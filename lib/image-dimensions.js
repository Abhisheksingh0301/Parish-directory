'use strict';

/**
 * Pixel dimensions of an uploaded photograph, read from the file's own bytes
 * rather than trusting the mimetype the browser declared on the way in.
 *
 * A third-party library was tried here first and dropped: at the time of
 * writing its published dimension-sniffer carries an open, unpatched
 * denial-of-service advisory in the parsers for formats this app never
 * accepts (ICNS, JXL, HEIF) — and a crafted upload can make a library that
 * auto-detects format from content reach exactly that code, regardless of
 * what mimetype it was posted with. The four formats accepted here (JPEG,
 * PNG, GIF, WebP) have short, fixed-shape headers, so reading the two
 * numbers this app actually needs — width and height, nothing else — is a
 * handful of lines against a buffer already in memory.
 *
 * Every reader below only walks forward through a buffer whose length it
 * already knows, so none of them can loop.
 */

const SIGNATURES = {
  'image/jpeg': (buf) => buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8,
  'image/png': (buf) => (
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ),
  'image/gif': (buf) => (
    buf.length > 6 &&
    (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')
  ),
  'image/webp': (buf) => (
    buf.length > 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
};

/**
 * Whether a buffer's own bytes actually start with the signature for the
 * mimetype it was posted as. The upload form's `accept` and multer's
 * `fileFilter` only look at the declared mimetype, which the browser (or a
 * hand-made request) supplies — this is the check against the file itself.
 */
function matchesDeclaredType(buffer, mimetype) {
  const check = SIGNATURES[mimetype];
  return !!check && check(buffer);
}

function pngSize(buf) {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf) {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/**
 * Scan JPEG markers for the first Start Of Frame, which carries the
 * dimensions. `offset` only ever increases, and every branch below advances
 * it by at least 1, so the loop is bounded by `buf.length` — a malformed or
 * hostile file ends the scan, it never spins.
 */
function jpegSize(buf) {
  let offset = 2;

  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }

    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) {
      offset += 1;
      marker = buf[offset + 1];
    }
    offset += 2;

    // Markers with no length field: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > buf.length) return null;

    const length = buf.readUInt16BE(offset);
    if (length < 2) return null;

    // SOFn, excluding DHT (C4), JPG (C8) and DAC (CC) which share the range.
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (offset + 7 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) };
    }

    offset += length;
  }
  return null;
}

/** The three WebP sub-formats each place width/height at a different fixed offset. */
function webpSize(buf) {
  if (buf.length < 30) return null;
  const kind = buf.toString('ascii', 12, 16);

  if (kind === 'VP8X') {
    // 3-byte little-endian fields, stored minus one.
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return { width, height };
  }

  if (kind === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff
    };
  }

  if (kind === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }

  return null;
}

const READERS = {
  'image/png': pngSize,
  'image/gif': gifSize,
  'image/jpeg': jpegSize,
  'image/webp': webpSize
};

/**
 * Width and height of an image buffer whose declared mimetype has already
 * been confirmed against its own bytes, or `null` if it cannot be read.
 */
function readDimensions(buffer, mimetype) {
  const reader = READERS[mimetype];
  if (!reader) return null;
  try {
    const size = reader(buffer);
    if (!size || !size.width || !size.height) return null;
    return size;
  } catch {
    return null;
  }
}

module.exports = { matchesDeclaredType, readDimensions };
