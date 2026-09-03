'use strict';

/**
 * Importing a family sheet from the browser.
 *
 * The promise this form makes is narrow and worth checking directly, because
 * it is the opposite of what the command line does: the whole file is read and
 * checked before anything is written, and one problem anywhere means nothing
 * at all is imported. A test that only proved "a good sheet imports" would
 * miss the half that matters. So the checks below are mostly about the sheets
 * that must be refused, and every one of them then asserts that the directory
 * is still empty afterwards — a refusal that has quietly created forty
 * families is the failure this design exists to prevent.
 *
 * The rest is who may post at all, and that the reported problems name the row
 * the person has to go and look at.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-upload-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'upload-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const PORT = 4007;
const PASSWORD = 'test-password-1234';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
}

function cleanUp() {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (err) {
    /* Windows may still hold the SQLite file; the OS will sweep it. */
  }
}

/**
 * A client that keeps its cookie and can post a file.
 *
 * The multipart body is built by hand rather than with a library: it is twenty
 * lines, and the point of the test is the server's half of the exchange.
 */
function makeClient() {
  let cookie = '';

  function send(method, urlPath, { headers = {}, payload = null } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: urlPath, method,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }
      }, (res) => {
        const set = res.headers['set-cookie'];
        if (set) cookie = set.map((c) => c.split(';')[0]).join('; ');

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          location: res.headers.location,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const client = (method, urlPath, form) => {
    if (!form) return send(method, urlPath);
    const data = new URLSearchParams(form).toString();
    return send(method, urlPath, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      },
      payload: data
    });
  };

  /** POST a file to `urlPath` as multipart/form-data. */
  client.upload = async (urlPath, { field = 'sheet', filename, content, csrf, fields = {} }) => {
    const boundary = `----parishtest${Date.now().toString(16)}`;
    // The plain fields the form posts beside the file: the CSRF token, and
    // whatever the office chose on the page.
    const plain = Object.entries({ _csrf: csrf, ...fields })
      .map(([name, value]) => `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
        + `${value}\r\n`)
      .join('');

    const body = Buffer.concat([
      Buffer.from(
        plain
        + `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
        + 'Content-Type: text/csv\r\n\r\n', 'utf8'
      ),
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);

    return send('POST', urlPath, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      payload: body
    });
  };

  return client;
}

const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

async function signIn(request, username) {
  const page = await request('GET', '/login');
  return request('POST', '/login', {
    _csrf: csrfFrom(page.body), username, password: PASSWORD
  });
}

// Two email columns, because a sheet has two and they mean different things:
// the family's own address is its login, a member's is their own.
const HEAD = 'Family ID,Head of family,Address,Prayer group,Email,'
  + 'Date of marriage,Member,Relation,Date of birth,Mobile,Emails\r\n';

/** A sheet with two families in it, five people, nothing wrong. */
const GOOD = HEAD
  + 'F-001,Thomas Mathew,"12 Church Road\nTown",St Peter,thomas@example.com,'
    + '14-Feb-1990,Thomas Mathew,HF,02-Aug-1965,9000000001,"thomas@example.com, thomas@work.in"\r\n'
  + 'F-001,,,,,,Mary Thomas,W,11-Mar-1968,9000000002,mary@example.com\r\n'
  + 'F-001,,,,,,Anil Thomas,S,2001-06-30,,\r\n'
  + 'F-002,George Kurian,45 Hill View,St Paul,george@example.com,'
    + ',George Kurian,HF,19-Sep-1972,9000000003,george@example.com\r\n'
  + 'F-002,,,,,,Sara George,W,04-Apr-1975,9000000004,\r\n';

/** The header again, with one family under it, for the checks that need one. */
const oneFamily = (email, memberEmails) => HEAD
  + `F-101,Anil Varkey,Road,,${email},,Anil Varkey,HF,,9000000009,${memberEmails}\r\n`;

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');

  await db.init();

  const diocese = await db.Diocese.create({ name: 'Trichy', created_at: db.now() });
  const church = await db.Church.create({
    diocese_id: diocese.id, zone_id: null,
    name: 'Alpha Church', slug: 'alpha', city: 'Town', created_at: db.now()
  });
  await db.ChurchSetting.create({
    church_id: church.id, key: 'relation_options', value: 'HF, W, S, D'
  });

  await db.User.create({
    username: 'alpha-admin', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Alpha Admin', role: 'admin', church_id: church.id, created_at: db.now()
  });
  await db.User.create({
    username: 'alpha-editor', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Alpha Editor', role: 'editor', church_id: church.id, created_at: db.now()
  });

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const admin = makeClient();
  await signIn(admin, 'alpha-admin');

  const token = csrfFrom((await admin('GET', '/admin/import')).body);
  const post = (filename, content, fields) =>
    admin.upload('/admin/import', { filename, content, csrf: token, fields });

  console.log('');
  console.log('--- a sheet with something wrong in it imports nothing at all ---');

  let res = await post('parish.csv', HEAD + 'F-001,Thomas,Road,,,,Thomas,HF,31-Feb-1965,,\r\n');
  check('an impossible date is refused',
    res.status === 200 && res.body.includes('Nothing was imported'),
    `status ${res.status}`);
  check('and the row is named, so the office knows where to look',
    res.body.includes('Row 2'), 'no row number in the report');
  check('and not one family was written',
    (await db.Family.count({ where: { church_id: church.id } })) === 0,
    'a refused sheet still created families');

  // The rule that costs the most to get wrong: one bad row must take its own
  // family down, and with this form, the whole file with it.
  res = await post('parish.csv', GOOD + 'F-003,Bad Family,Road,,,,Somebody,HF,not-a-date,,\r\n');
  check('one bad row at the end refuses the five good rows in front of it',
    res.body.includes('Nothing was imported')
    && (await db.Family.count({ where: { church_id: church.id } })) === 0,
    'a partial import happened');

  res = await post('parish.csv', 'Name,Address\r\nThomas,Road\r\n');
  check('a sheet with no Family ID column is refused by name',
    res.body.includes('No Family ID column was found'), 'wrong message');

  res = await post('parish.csv', HEAD);
  check('a sheet with headings and nothing under them is refused',
    res.body.includes('header row and nothing else'), 'wrong message');

  res = await post('parish.xlsx', 'anything');
  check('an .xlsx workbook is refused with what to do about it',
    res.body.includes('Save As') && res.body.includes('CSV (comma delimited)'),
    'the message did not say how to save it as CSV');

  res = await post('parish.csv', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  check('and a workbook renamed to .csv is caught by its own bytes',
    res.body.includes('renamed'), 'a zip was read as a spreadsheet');

  console.log('');
  console.log('--- the email columns are checked before a single row is written ---');

  res = await post('parish.csv', oneFamily('anil-at-example.com', 'anil@example.com'));
  check('a family Email that is not an address is refused',
    res.body.includes('Nothing was imported'), 'it was imported anyway');
  check('and the report names the column, because a sheet has two of them',
    /Email \(the family(&#39;|')s own\)/.test(res.body), 'the column was not named');

  res = await post('parish.csv', oneFamily('anil@example.com', 'not-an-address'));
  check("a member's Emails cell that is not an address is refused",
    res.body.includes('Nothing was imported'), 'it was imported anyway');
  check('and that report names its column too', res.body.includes('Emails:'), 'not named');

  // The one the browser's own type=email would wave through. lib/email.js is
  // deliberately stricter, and the importer has to be as strict as the form.
  res = await post('parish.csv', oneFamily('anil@gmail', 'anil@example.com'));
  check('a bare hostname is caught, which type=email would have accepted',
    res.body.includes('missing the end of the domain'), 'it was accepted');

  res = await post('parish.csv',
    oneFamily('anil@example.com', '"a@x.com, b@x.com, c@x.com, d@x.com"'));
  check('more addresses than the printed cell holds is refused',
    res.body.includes('Nothing was imported'), 'it was imported anyway');

  check('and not one of those four sheets wrote anything',
    (await db.Family.count({ where: { church_id: church.id } })) === 0,
    'a refused sheet still created a family');

  console.log('');
  console.log('--- a clean sheet imports, whole ---');

  res = await post('parish.csv', GOOD);
  check('the page says what arrived',
    res.status === 200 && res.body.includes('Imported 2 families'),
    `status ${res.status}`);

  const families = await db.Family.findAll({ where: { church_id: church.id }, raw: true });
  check('both families were created', families.length === 2, `${families.length} created`);
  check('and every one of them is a draft, not in the printed book',
    families.every((f) => !f.is_published), 'an import published a family');

  const members = await db.Member.count();
  check('with all five people', members === 5, `${members} members`);

  const first = families.find((f) => f.family_id === 'F-001');
  check('the family details came off the first row of the family',
    first && first.address.includes('12 Church Road'), JSON.stringify(first && first.address));
  check('and a two-line address survived the upload intact',
    first && first.address.includes('\n'), JSON.stringify(first && first.address));
  const head = await db.Member.findOne({ where: { family_id: first.id, relation: 'HF' } });
  check('the date of marriage was read onto the member it belongs to',
    head && head.dom_day === 14 && head.dom_month === 2,
    `${head && head.dom_day}/${head && head.dom_month}`);
  check('and the year in the sheet was dropped rather than refused',
    head && head.dob_day === 2 && head.dob_month === 8,
    `${head && head.dob_day}/${head && head.dob_month}`);
  check("the family's own email went to the family",
    first && first.email === 'thomas@example.com', JSON.stringify(first && first.email));
  check('and a member carrying two addresses kept both',
    head && head.emails === 'thomas@example.com,thomas@work.in',
    JSON.stringify(head && head.emails));

  console.log('');
  console.log('--- and the same sheet again does not duplicate anything ---');

  res = await post('parish.csv', GOOD);
  check('the second upload is refused',
    res.body.includes('Nothing was imported'), 'a re-upload was accepted');
  check('naming the Family ID that is already there',
    res.body.includes('F-001') && res.body.includes('already in the directory'),
    'the report did not say which family clashed');
  check('and the directory still holds exactly two families',
    (await db.Family.count({ where: { church_id: church.id } })) === 2,
    'a re-upload changed the directory');

  console.log('');
  console.log('--- unless the office asks for those families to be updated ---');

  /*
   * The second sheet a parish uploads is the first one with the addresses put
   * right, and every Family ID on it is already here. Asked for, that is an
   * update rather than a clash — and the checks below are mostly about what an
   * update must leave alone.
   */

  // The office has since published F-001 and given it a photograph. Neither is
  // the sheet's business: there is no column for either.
  const before = await db.Family.findOne({
    where: { church_id: church.id, family_id: 'F-001' }
  });
  await before.update({ is_published: true, photo: 'kept.jpg' });

  const CORRECTED = HEAD
    + 'F-001,Thomas Mathew,"13 New Road\nTown",,thomas@example.com,'
      + '14-Feb-1990,Thomas Mathew,HF,02-Aug-1965,9000000001,thomas@example.com\r\n'
    + 'F-001,,,,,,Susan Thomas,D,05-May-2003,9000000005,\r\n'
    + 'F-003,Peter Jacob,9 Market Street,St Peter,peter@example.com,'
      + ',Peter Jacob,HF,01-Jan-1980,9000000006,\r\n';

  res = await post('corrected.csv', CORRECTED, { on_existing: 'update' });
  check('the sheet is accepted rather than refused as a clash',
    res.status === 200 && !res.body.includes('Nothing was imported'), `status ${res.status}`);
  check('and the page separates what arrived from what was updated',
    res.body.includes('Imported 1 family and 1 person') &&
    res.body.includes('updated 1 family already in the directory'),
    'the report did not say what it did');

  const updated = await db.Family.findOne({
    where: { church_id: church.id, family_id: 'F-001' }, raw: true
  });
  check('a corrected cell is written', updated.address.includes('13 New Road'), updated.address);
  check('a blank cell changes nothing',
    updated.prayer_group === 'St Peter', JSON.stringify(updated.prayer_group));
  check('the photograph is not wiped by a sheet that has no column for it',
    updated.photo === 'kept.jpg', JSON.stringify(updated.photo));
  check("and neither is the office's decision to print the family",
    !!updated.is_published, 'an import took a family out of the printed book');

  const household = await db.Member.findAll({
    where: { family_id: updated.id }, order: [['position', 'ASC']], raw: true
  });
  check('the member list is the sheet, whole',
    household.length === 2 && household.map((m) => m.name).join(', ')
      === 'Thomas Mathew, Susan Thomas',
    household.map((m) => m.name).join(', '));

  check('a family not on the sheet is left alone',
    (await db.Member.count({
      where: {
        family_id: (await db.Family.findOne({
          where: { church_id: church.id, family_id: 'F-002' }, raw: true
        })).id
      }
    })) === 2, 'F-002 lost members to a sheet it was not on');

  const arrived = await db.Family.findOne({
    where: { church_id: church.id, family_id: 'F-003' }, raw: true
  });
  check('a family that is genuinely new still arrives in the same pass', !!arrived);
  check('and arrives as a draft like any other import',
    arrived && !arrived.is_published, 'an updating import published a new family');

  // A sheet correcting only the family's own columns, with no member rows on
  // it at all, is not an instruction to empty the household.
  const FAMILY_ONLY = HEAD + 'F-001,,,St Jude,,,,,,,\r\n';
  res = await post('areas.csv', FAMILY_ONLY, { on_existing: 'update' });
  check('a sheet with no member rows is accepted',
    !res.body.includes('Nothing was imported'), 'a family-only sheet was refused');
  check('and leaves the household exactly as it was',
    (await db.Member.count({ where: { family_id: updated.id } })) === 2,
    'a family-only sheet emptied a household');
  check('while still correcting the family column it carried',
    (await db.Family.findOne({
      where: { church_id: church.id, family_id: 'F-001' }, raw: true
    })).prayer_group === 'St Jude', 'the corrected cell was not written');

  // And the default is still to refuse: the option has to be asked for.
  res = await post('corrected.csv', CORRECTED);
  check('without asking, a Family ID already here still stops the import',
    res.body.includes('Nothing was imported'), 'a clash was accepted by default');

  console.log('');
  console.log('--- nothing to upload ---');
  res = await admin('POST', '/admin/import', { _csrf: token });
  check('posting the form with no file chosen says so',
    res.status === 200 && res.body.includes('No file was chosen'),
    `status ${res.status}`);

  console.log('');
  console.log('--- who may do it ---');

  const settledCount = await db.Family.count({ where: { church_id: church.id } });

  const editor = makeClient();
  await signIn(editor, 'alpha-editor');
  res = await editor.upload('/admin/import', {
    filename: 'parish.csv', content: GOOD, csrf: 'whatever'
  });
  check('an editor may not import',
    res.status === 403, `status ${res.status}`);

  const anonymous = makeClient();
  res = await anonymous.upload('/admin/import', {
    filename: 'parish.csv', content: GOOD, csrf: 'whatever'
  });
  check('and a signed-out request certainly may not',
    res.status === 403, `status ${res.status}`);

  check('neither of them changed anything',
    (await db.Family.count({ where: { church_id: church.id } })) === settledCount,
    'an unauthorised upload reached the database');

  // The file is parsed before the CSRF check can see `_csrf`, so the check has
  // to still happen afterwards — otherwise a form on another site could post a
  // parish's whole membership into it.
  res = await admin.upload('/admin/import', {
    filename: 'parish.csv', content: GOOD, csrf: 'not-the-token'
  });
  check('an administrator posting a stale form is refused',
    res.status === 403, `status ${res.status}`);

  server.close();
  await db.close();

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  console.log('');
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => { cleanUp(); process.exit(code); })
  .catch((err) => {
    console.error(err);
    cleanUp();
    process.exit(1);
  });
