'use strict';

/**
 * What the photograph form accepts, and what shape it thinks a photograph is.
 *
 * This sits below the HTTP tests on purpose. The rules being checked are the
 * ones in lib/image-dimensions.js and lib/upload.js, they are decided from a
 * buffer of bytes and nothing else, and a test that had to sign in and post a
 * multipart body first would be a slower way of asking the same question with
 * more that could go wrong in between.
 *
 * Three groups of check, and each answers something the Parish asked for:
 *
 *   the formats     The form says JPG, in those words, because that is what
 *                   an office has. The server takes the rest anyway. Both
 *                   halves are checked here, because a message and a rule
 *                   that quietly disagree is the whole point of the design
 *                   and is exactly the kind of thing that gets "tidied up"
 *                   into agreement by somebody reading only one of them.
 *
 *   orientation     A phone held sideways writes a portrait frame and an EXIF
 *                   tag that turns it a quarter turn on the way to the screen.
 *                   Those photographs were being refused as "not landscape"
 *                   while looking perfectly landscape to the person uploading
 *                   them. The tag has to win.
 *
 *   size            Five megabytes at four thousand pixels across, which is
 *                   an ordinary photograph off an ordinary phone, has to go
 *                   through — including the progressive JPEGs that most
 *                   phone and web pipelines now emit, whose dimensions sit
 *                   behind a different frame marker.
 */

const assert = require('assert');
const upload = require('../lib/upload');
const { matchesDeclaredType, readDimensions, exifOrientation } = require('../lib/image-dimensions');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
}

// ---------------------------------------------------------------------------
// Photographs, built here rather than encoded
// ---------------------------------------------------------------------------

/**
 * A JPEG carrying a Start Of Frame, optionally an EXIF block, and optionally
 * a wedge of padding to reach a given size.
 *
 * Not a decodable picture, deliberately: what this application reads out of a
 * JPEG is the signature, the two numbers in its frame header and one EXIF
 * tag. Encoding a real one would be testing a JPEG encoder. The padding rides
 * in a COM (comment) segment, which is a real segment the marker scan has to
 * walk past to reach the frame — so a padded file is not just a bigger file,
 * it is a longer scan, which is the thing worth checking at five megabytes.
 */
function makeJpeg(width, height, { marker = 0xc0, orientation = null, padTo = 0 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];

  if (orientation !== null) parts.push(exifSegment(orientation));

  if (padTo) {
    // COM segments carry a 16-bit length, so a large pad is several of them.
    let left = padTo;
    while (left > 0) {
      const chunk = Math.min(left, 65533);
      const seg = Buffer.alloc(4 + chunk);
      seg.writeUInt16BE(0xfffe, 0);
      seg.writeUInt16BE(chunk + 2, 2);
      parts.push(seg);
      left -= chunk;
    }
  }

  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xff00 | marker, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  parts.push(sof);

  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** An APP1 segment holding a minimal EXIF block with just the orientation. */
function exifSegment(orientation) {
  // TIFF header (8) + entry count (2) + one 12-byte entry + next-IFD (4)
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);      // the first IFD starts right after the header
  tiff.writeUInt16LE(1, 8);      // one entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12);     // SHORT
  tiff.writeUInt32LE(1, 14);     // one value
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);     // no second IFD

  const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function makeBmp(width, height) {
  const buf = Buffer.alloc(54);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54, 2);      // file size
  buf.writeUInt32LE(54, 10);     // pixel offset
  buf.writeUInt32LE(40, 14);     // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

/** A bottom-up BMP records its height as a negative number. */
function makeTopDownBmp(width, height) {
  const buf = makeBmp(width, height);
  buf.writeInt32LE(-height, 22);
  return buf;
}

/** An AVIF holding one `ispe` inside meta/iprp/ipco, which is where a real one keeps it. */
function makeAvif(width, height, thumb = null) {
  const box = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length + 8, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, body]);
  };
  const ispe = (w, h) => {
    const body = Buffer.alloc(12); // version + flags, then two 32-bit numbers
    body.writeUInt32BE(w, 4);
    body.writeUInt32BE(h, 8);
    return box('ispe', body);
  };

  const ftyp = box('ftyp', Buffer.concat([
    Buffer.from('avif', 'ascii'), Buffer.alloc(4), Buffer.from('avif', 'ascii')
  ]));

  const ipco = box('ipco', thumb
    ? Buffer.concat([ispe(thumb[0], thumb[1]), ispe(width, height)])
    : ispe(width, height));

  const meta = box('meta', Buffer.concat([Buffer.alloc(4), box('iprp', ipco)]));
  return Buffer.concat([ftyp, meta]);
}

function makePng(width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr
  ]);
}

// ---------------------------------------------------------------------------

function main() {
  console.log('');
  console.log('--- the message says JPG; the server takes what it is given ---');

  check('a JPG is accepted, which is what the form asks for',
    !!upload.ALLOWED['image/jpeg'], 'the one format the message names');

  for (const type of ['image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']) {
    check(`a ${type.replace('image/', '').toUpperCase()} is taken anyway, not sent back to be converted`,
      !!upload.ALLOWED[type], `${type} was refused`);
  }

  check('an SVG is refused, and not as a format oversight',
    !upload.ALLOWED['image/svg+xml'] && /drawing file/.test(upload.REFUSED['image/svg+xml'] || ''),
    'an SVG can carry script and would be served from this app’s own origin');

  check('a HEIC is refused with the one thing that helps',
    !upload.ALLOWED['image/heic'] && /Most Compatible/.test(upload.REFUSED['image/heic'] || ''),
    upload.REFUSED['image/heic']);

  check('and a TIFF is told how to become something the book can print',
    /save it as a JPG/i.test(upload.REFUSED['image/tiff'] || ''), upload.REFUSED['image/tiff']);

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- a photograph taken sideways on a phone ---');

  const upright = makeJpeg(4000, 3000);
  check('an ordinary landscape photograph reads as landscape',
    readDimensions(upright, 'image/jpeg').width === 4000, 'plain SOF0');

  /*
   * The bug the Parish would have met: the sensor wrote 3000x4000 and tagged
   * it "turn a quarter", so every viewer shows a 4000x3000 landscape picture.
   * Reading the frame alone called it portrait and refused it.
   */
  for (const turn of [5, 6, 7, 8]) {
    const sideways = makeJpeg(3000, 4000, { orientation: turn });
    const size = readDimensions(sideways, 'image/jpeg');
    check(`orientation ${turn} is a quarter turn, so it reads as landscape`,
      size.width === 4000 && size.height === 3000, JSON.stringify(size));
  }

  for (const turn of [1, 2, 3, 4]) {
    const flat = makeJpeg(4000, 3000, { orientation: turn });
    const size = readDimensions(flat, 'image/jpeg');
    check(`orientation ${turn} is not a turn, so the numbers stand`,
      size.width === 4000 && size.height === 3000, JSON.stringify(size));
  }

  const stillPortrait = makeJpeg(1200, 1600, { orientation: 1 });
  const portraitSize = readDimensions(stillPortrait, 'image/jpeg');
  check('a genuinely portrait photograph is still portrait, and still refused',
    portraitSize.width < portraitSize.height, JSON.stringify(portraitSize));

  check('a JPEG with no EXIF at all is read as upright rather than failing',
    exifOrientation(makeJpeg(100, 50)) === 1, 'no APP1 segment');

  check('and a nonsense orientation is ignored rather than trusted',
    readDimensions(makeJpeg(400, 300, { orientation: 99 }), 'image/jpeg').width === 400,
    'an out-of-range tag value');

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- five megabytes, four thousand pixels across ---');

  /*
   * The size the Parish asked to be checked. The file is padded to just under
   * the ceiling with real segments, so the marker scan has five megabytes to
   * walk before it reaches the frame — which is the part that would be slow
   * or wrong if the scan were.
   */
  const big = makeJpeg(4000, 3000, { padTo: (5 * 1024 * 1024) - 4096 });
  check('the padded photograph really is about five megabytes',
    big.length > 4.9 * 1024 * 1024 && big.length <= upload.maxBytes,
    `${(big.length / (1024 * 1024)).toFixed(2)} MB, ceiling ${(upload.maxBytes / (1024 * 1024))} MB`);

  const started = Date.now();
  const bigSize = readDimensions(big, 'image/jpeg');
  const took = Date.now() - started;
  check('its dimensions are read correctly through all of it',
    bigSize && bigSize.width === 4000 && bigSize.height === 3000, JSON.stringify(bigSize));
  check('and reading them is not slow enough for anybody to notice',
    took < 500, `${took}ms`);

  const bigSideways = makeJpeg(3000, 4000, {
    orientation: 6, padTo: (5 * 1024 * 1024) - 4096
  });
  const sidewaysSize = readDimensions(bigSideways, 'image/jpeg');
  check('a five-megabyte photograph taken sideways is landscape too',
    sidewaysSize.width === 4000 && sidewaysSize.height === 3000, JSON.stringify(sidewaysSize));

  /*
   * Progressive JPEGs put their dimensions in an SOF2 rather than an SOF0.
   * Most phone and web pipelines now emit them, so a scan that only knew the
   * one marker would refuse a large slice of what a parish uploads.
   */
  const progressive = makeJpeg(4000, 3000, { marker: 0xc2 });
  check('a progressive JPEG is read as well as a baseline one',
    readDimensions(progressive, 'image/jpeg').width === 4000, 'SOF2');

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- the formats added beside JPEG ---');

  const bmp = makeBmp(1600, 1200);
  check('a BMP is recognised by its own bytes', matchesDeclaredType(bmp, 'image/bmp'));
  check('and measured', JSON.stringify(readDimensions(bmp, 'image/bmp')) === '{"width":1600,"height":1200}',
    JSON.stringify(readDimensions(bmp, 'image/bmp')));
  check('a top-down BMP is the same size, not a negative one',
    readDimensions(makeTopDownBmp(1600, 1200), 'image/bmp').height === 1200,
    JSON.stringify(readDimensions(makeTopDownBmp(1600, 1200), 'image/bmp')));

  const avif = makeAvif(1600, 1200);
  check('an AVIF is recognised by its brand', matchesDeclaredType(avif, 'image/avif'));
  check('and measured from its ispe box',
    JSON.stringify(readDimensions(avif, 'image/avif')) === '{"width":1600,"height":1200}',
    JSON.stringify(readDimensions(avif, 'image/avif')));
  check('an AVIF carrying a thumbnail is measured by the photograph, not the thumbnail',
    readDimensions(makeAvif(1600, 1200, [160, 120]), 'image/avif').width === 1600,
    JSON.stringify(readDimensions(makeAvif(1600, 1200, [160, 120]), 'image/avif')));

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- and the bytes still have to be what they claim ---');

  check('a PNG posted as a JPEG is caught',
    !matchesDeclaredType(makePng(100, 100), 'image/jpeg'));
  check('a JPEG posted as a PNG is caught',
    !matchesDeclaredType(makeJpeg(100, 100), 'image/png'));
  check('a BMP posted as an AVIF is caught',
    !matchesDeclaredType(makeBmp(100, 100), 'image/avif'));
  check('an empty file is not any of them',
    !matchesDeclaredType(Buffer.alloc(0), 'image/jpeg')
    && !matchesDeclaredType(Buffer.alloc(0), 'image/bmp')
    && !matchesDeclaredType(Buffer.alloc(0), 'image/avif'));

  /*
   * Nothing here may hang. Every reader walks forward through a buffer whose
   * length it knows, and these are the shapes that would find it out: a
   * truncated file, a length field pointing past the end, and a box that
   * claims to contain itself.
   */
  const hostile = [
    ['a truncated JPEG', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
    ['a JPEG whose segment runs off the end',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), 'image/jpeg'],
    ['a JPEG claiming an EXIF block it does not have',
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66]), 'image/jpeg'],
    ['a run of 0xff with no marker after it',
      Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4096, 0xff)]), 'image/jpeg'],
    ['a BMP header that stops halfway', Buffer.from('BM', 'ascii'), 'image/bmp'],
    ['an AVIF box that claims zero length',
      Buffer.concat([
        Buffer.from([0, 0, 0, 0]), Buffer.from('ftyp', 'ascii'),
        Buffer.from('avif', 'ascii')
      ]), 'image/avif'],
    ['an AVIF box longer than the file',
      Buffer.concat([
        Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('meta', 'ascii')
      ]), 'image/avif']
  ];

  for (const [label, buffer, type] of hostile) {
    const started2 = Date.now();
    let threw = null;
    try {
      readDimensions(buffer, type);
    } catch (err) {
      threw = err;
    }
    check(`${label} is answered, not thrown at and not spun on`,
      !threw && Date.now() - started2 < 500,
      threw ? threw.message : `${Date.now() - started2}ms`);
  }

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  console.log('');
  return failures === 0 ? 0 : 1;
}

assert.ok(upload.maxBytes === 5 * 1024 * 1024,
  'these checks are written against a 5 MB ceiling');

process.exit(main());
