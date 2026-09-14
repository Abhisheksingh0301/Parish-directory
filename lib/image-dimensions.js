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
 * what mimetype it was posted with. The formats accepted here have short,
 * fixed-shape headers, so reading the two numbers this app actually needs —
 * width and height, nothing else — is a handful of lines against a buffer
 * already in memory.
 *
 * Every reader below only walks forward through a buffer whose length it
 * already knows, so none of them can loop. `avifSize` is the only one that
 * recurses, and it carries its own depth and box-count ceilings.
 *
 * ── On orientation ─────────────────────────────────────────────────────────
 * A JPEG's width and height are not necessarily the width and height anybody
 * sees. A phone held sideways writes the sensor's own portrait frame and adds
 * one EXIF tag saying "turn this a quarter turn on the way to the screen";
 * every viewer, browser and printer obeys it, and the photograph is landscape
 * to everyone who looks at it. Reading the numbers straight off the frame and
 * calling it portrait was rejecting perfectly good landscape photographs —
 * and rejecting them with the one message guaranteed not to help, because the
 * person is looking at a landscape photograph while being told it is not one.
 * So the tag is read, and a quarter turn swaps the two numbers.
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
  ),
  // "BM", then the file size as recorded in the header. Checking the second
  // is what separates a bitmap from any other file that happens to start
  // with those two letters.
  'image/bmp': (buf) => (
    buf.length > 14 && buf[0] === 0x42 && buf[1] === 0x4d &&
    buf.readUInt32LE(2) >= 26
  ),
  // ISO base media: a `ftyp` box whose brand says AVIF. The same container
  // holds HEIC, which is why the brand and not just the box is checked.
  'image/avif': (buf) => (
    buf.length > 12 &&
    buf.toString('ascii', 4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(buf.toString('ascii', 8, 12))
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

/**
 * The EXIF orientation of a JPEG, or 1 ("as stored") when it says nothing.
 *
 * EXIF is a TIFF file posted inside a JPEG APP1 segment: a byte-order mark,
 * an offset to the first image file directory, and then a count followed by
 * that many twelve-byte entries. Tag 0x0112 is the orientation. Only the
 * first directory is read — the second holds the thumbnail, whose orientation
 * is not the photograph's.
 *
 * Bounded throughout: the segment length caps the scan, the entry count is
 * capped at what the segment can physically hold, and nothing is followed
 * backwards.
 */
function exifOrientation(buf) {
  let offset = 2;

  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }

    const marker = buf[offset + 1];
    offset += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    // Start of scan: the compressed data begins, and EXIF is behind us.
    if (marker === 0xda) return 1;
    if (offset + 2 > buf.length) return 1;

    const length = buf.readUInt16BE(offset);
    if (length < 2) return 1;

    if (marker === 0xe1 && offset + 10 <= buf.length &&
        buf.toString('ascii', offset + 2, offset + 8) === 'Exif\u0000\u0000') {
      const tiff = offset + 8;
      const end = Math.min(offset + length, buf.length);
      const found = orientationInTiff(buf, tiff, end);
      if (found) return found;
    }

    offset += length;
  }
  return 1;
}

/** Tag 0x0112 in the first IFD of a TIFF header at `tiff`, or 0. */
function orientationInTiff(buf, tiff, end) {
  if (tiff + 8 > end) return 0;

  const order = buf.toString('ascii', tiff, tiff + 2);
  if (order !== 'II' && order !== 'MM') return 0;
  const little = order === 'II';
  const u16 = (at) => (little ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  const u32 = (at) => (little ? buf.readUInt32LE(at) : buf.readUInt32BE(at));

  if (u16(tiff + 2) !== 42) return 0;

  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end || ifd < tiff) return 0;

  // Capped by what the segment can actually hold, so a claimed count of
  // 65535 in a short segment cannot walk off the end of it.
  const count = Math.min(u16(ifd), Math.floor((end - ifd - 2) / 12));

  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + (i * 12);
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

/** Orientations 5–8 are the quarter turns: the photograph is on its side. */
const QUARTER_TURN = new Set([5, 6, 7, 8]);

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

/**
 * Windows bitmap. Two header shapes are in the wild: the 12-byte BITMAPCORE
 * with 16-bit dimensions, and everything since with 32-bit ones. The height
 * is signed — a negative height means the rows are stored top-down, which
 * says nothing about how big the picture is.
 */
function bmpSize(buf) {
  if (buf.length < 26) return null;
  const headerSize = buf.readUInt32LE(14);

  if (headerSize === 12) {
    return { width: buf.readUInt16LE(18), height: buf.readUInt16LE(20) };
  }
  return {
    width: Math.abs(buf.readInt32LE(18)),
    height: Math.abs(buf.readInt32LE(22))
  };
}

/**
 * AVIF, from the `ispe` box that records an item's pixel dimensions.
 *
 * A file can hold several — the photograph, and often a thumbnail beside it —
 * and the box does not say which item it belongs to without following the
 * property-association table. Rather than walk that, the largest `ispe` wins:
 * the thumbnail is by definition the smaller of the two, and the photograph is
 * what this is being asked about.
 *
 * The walk is bounded three ways: a depth limit, a ceiling on how many boxes
 * are visited at all, and a size field that must move the cursor forward or
 * the walk stops. Nothing here can spin on a crafted file.
 */
function avifSize(buf) {
  let best = null;
  let visited = 0;

  const walk = (start, end, depth) => {
    let at = start;
    while (at + 8 <= end && visited < 512 && depth <= 6) {
      visited += 1;

      let size = buf.readUInt32BE(at);
      const type = buf.toString('ascii', at + 4, at + 8);
      let body = at + 8;

      if (size === 1) {
        // 64-bit size. The high word must be zero for any file we could hold
        // in memory, and reading only the low word keeps this in Number range.
        if (body + 8 > end || buf.readUInt32BE(body) !== 0) return;
        size = buf.readUInt32BE(body + 4);
        body += 8;
      } else if (size === 0) {
        size = end - at; // "to the end of the file"
      }

      if (size < 8 || at + size > end) return;
      const stop = at + size;

      if (type === 'ispe' && body + 12 <= stop) {
        // A full box: one version byte and three of flags before the numbers.
        const width = buf.readUInt32BE(body + 4);
        const height = buf.readUInt32BE(body + 8);
        if (width && height && (!best || width * height > best.width * best.height)) {
          best = { width, height };
        }
      } else if (type === 'meta') {
        walk(body + 4, stop, depth + 1); // full box: skip version and flags
      } else if (['iprp', 'ipco', 'moov', 'trak', 'mdia'].includes(type)) {
        walk(body, stop, depth + 1);
      }

      at = stop;
    }
  };

  walk(0, buf.length, 0);
  return best;
}

const READERS = {
  'image/png': pngSize,
  'image/gif': gifSize,
  'image/jpeg': jpegSize,
  'image/webp': webpSize,
  'image/bmp': bmpSize,
  'image/avif': avifSize
};

/**
 * Width and height of an image buffer whose declared mimetype has already
 * been confirmed against its own bytes, or `null` if it cannot be read.
 *
 * These are the dimensions as displayed, not as stored: a JPEG carrying a
 * quarter-turn in its EXIF orientation reports the two swapped, because that
 * is the shape of the photograph everybody except this function's caller can
 * see. Everything downstream — the landscape check, and any decision about
 * how a photograph fits its frame in the printed book — is asking about the
 * picture, not about the file.
 */
function readDimensions(buffer, mimetype) {
  const reader = READERS[mimetype];
  if (!reader) return null;
  try {
    const size = reader(buffer);
    if (!size || !size.width || !size.height) return null;

    if (mimetype === 'image/jpeg' && QUARTER_TURN.has(exifOrientation(buffer))) {
      return { width: size.height, height: size.width };
    }
    return size;
  } catch {
    return null;
  }
}

module.exports = { matchesDeclaredType, readDimensions, exifOrientation };
