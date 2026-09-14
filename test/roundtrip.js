'use strict';

/**
 * Download, edit, upload — the same file, all the way round.
 *
 * The Parish's actual request, in its own words: "the import family and export
 * family csv file format should be same, so that i can download, update and
 * then upload the same csv file." That is not a property you can read off
 * either module on its own. lib/export.js can look right, lib/import-columns.js
 * can look right, and the round trip can still fail on a heading spelt one way
 * on the way out and another on the way in — which is exactly what it used to
 * do, with `Area / Unit` and three church columns the importer had never heard
 * of.
 *
 * So this test does the whole loop against the running application:
 *
 *   1. create a parish with families and members in it
 *   2. GET /admin/export.csv
 *   3. check the headings are, byte for byte, the headings the blank template
 *      offers on the Import families page
 *   4. edit one cell of the downloaded file, the way an office would in Excel
 *   5. POST it back to /admin/import with "update those already here"
 *   6. check the edit landed, nothing else moved, and the page reported no
 *      column it did not recognise
 *
 * Step 6's last clause is the one that would have caught the old behaviour: the
 * import used to accept its own export and quietly report four columns it was
 * ignoring, which is a working import and a broken promise.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-roundtrip-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'roundtrip-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const PORT = 4009;
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

/** A client that keeps its cookie and can post a file. */
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

  client.upload = async (urlPath, { field = 'sheet', filename, content, csrf, fields = {} }) => {
    const boundary = `----parishtest${Date.now().toString(16)}`;
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

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');
  const csv = require('../lib/csv');
  const columns = require('../lib/import-columns');
  const template = require('../lib/import-template');
  const Family = require('../models/family');

  await db.init();

  const diocese = await db.Diocese.create({ name: 'Trichy', created_at: db.now() });
  const church = await db.Church.create({
    diocese_id: diocese.id, zone_id: null,
    name: 'Alpha Church', slug: 'alpha', city: 'Town', created_at: db.now()
  });
  await db.User.create({
    username: 'alpha-admin', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Alpha Admin', role: 'admin', church_id: church.id, created_at: db.now()
  });

  /*
   * Two households shaped like the Parish's own sheet: one with a single
   * member and almost every cell blank, one filled in completely with several
   * members. The second is the one that proves the family's columns survive
   * being written once and read back off the first row.
   */
  await Family.create(church.id, {
    family_id: 'P026', head_name: 'Mr. Ashlin Sam Mohan',
    address: '', hometown: '', home_parish: '',
    prayer_group: 'Camp', email: '', sort_order: 1, is_published: true,
    members: [{
      name: 'Mr. Ashlin Sam Mohan', relation: 'Head',
      dob_day: null, dob_month: null, dom_day: null, dom_month: null,
      mobile: '8593937702', blood_group: '', qualification: '', occupation: '', emails: ''
    }]
  });

  await Family.create(church.id, {
    family_id: 'P036', head_name: 'Mr. Babu John',
    address: 'Maruti Residency, A-Wing\nFlat No. 04, Sai Park',
    hometown: 'Thenguvila Kizhakkathil, Villakupara',
    home_parish: 'St. Thomas MTC, Aylara.',
    prayer_group: 'Ghorpadi', email: 'bjohn7676@example.com',
    sort_order: 22, is_published: true,
    members: [
      {
        name: 'Mr. Babu John', relation: 'Head', dob_day: 25, dob_month: 5,
        dom_day: 30, dom_month: 5, mobile: '9850408389', blood_group: 'B +ve',
        qualification: '', occupation: 'Business', emails: 'bjohn7676@example.com'
      },
      {
        name: 'Mini Babu John', relation: 'Spouse', dob_day: 3, dob_month: 4,
        dom_day: 30, dom_month: 5, mobile: '9765275144', blood_group: 'A +ve',
        qualification: '', occupation: 'Housewife', emails: 'minijohn013@example.com'
      },
      {
        name: 'Navia Babu John', relation: 'Daughter', dob_day: 21, dob_month: 9,
        dom_day: null, dom_month: null, mobile: '8805188550', blood_group: 'B +ve',
        qualification: '', occupation: 'Student', emails: 'johnnavia01@example.com'
      }
    ]
  });

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const admin = makeClient();
  await signIn(admin, 'alpha-admin');

  // ---------------------------------------------------------------------
  console.log('');
  console.log('--- the file that comes out ---');

  let res = await admin('GET', '/admin/export.csv');
  check('the export downloads', res.status === 200, `status ${res.status}`);

  const sheet = res.body;
  check('and opens in Excel as UTF-8', sheet.charCodeAt(0) === 0xFEFF,
    `first char ${sheet.charCodeAt(0).toString(16)}`);

  const rows = csv.parse(sheet);
  const header = rows[0];

  check('its headings are exactly the importer’s own, in the importer’s order',
    header.join('|') === columns.headerRow().join('|'),
    `got     ${header.join(',')}\n        wanted  ${columns.headerRow().join(',')}`);

  /*
   * The same headings the blank template offers, which is the other half of
   * "one format": a parish that starts from the template and a parish that
   * starts from an export are filling in the same file.
   */
  const templateHeader = csv.parse(template.build({ relations: [], withExamples: false }))[0];
  check('and the blank template offers that same header row',
    templateHeader.join('|') === header.join('|'),
    templateHeader.join(','));

  check('the Area / Unit column is gone from it',
    !header.some((h) => /area/i.test(h)), header.join(','));

  check('no diocese, zone or church column is in a single parish’s own sheet',
    !header.some((h) => /diocese|zone|^church$/i.test(h)), header.join(','));

  // ---------------------------------------------------------------------
  console.log('');
  console.log('--- the shape of the rows, which is the shape the importer reads ---');

  const at = (row, field) => row[columns.FIELDS.indexOf(field)];
  const body = rows.slice(1);

  check('one row per person, not per family', body.length === 4, `${body.length} rows`);

  const babu = body.filter((r) => at(r, 'family_id') === 'P036');
  check('the household’s three people are three rows', babu.length === 3, `${babu.length}`);

  check('every row of a household carries its Family ID',
    babu.every((r) => at(r, 'family_id') === 'P036'),
    babu.map((r) => at(r, 'family_id')).join(','));

  check('the family’s own columns are written once, on its first row',
    at(babu[0], 'head_name') === 'Mr. Babu John'
    && at(babu[0], 'prayer_group') === 'Ghorpadi'
    && babu.slice(1).every((r) => at(r, 'head_name') === '' && at(r, 'prayer_group') === ''),
    babu.map((r) => `${at(r, 'head_name')}/${at(r, 'prayer_group')}`).join(' | '));

  check('and each row carries its own person',
    babu.map((r) => at(r, 'member_name')).join(',')
      === 'Mr. Babu John,Mini Babu John,Navia Babu John',
    babu.map((r) => at(r, 'member_name')).join(','));

  check('a multi-line address survives the trip out',
    at(babu[0], 'address').includes('\n'), JSON.stringify(at(babu[0], 'address')));

  check('the Sort Order the parish set is in the file',
    at(babu[0], 'sort_order') === '22', at(babu[0], 'sort_order'));

  // ---------------------------------------------------------------------
  console.log('');
  console.log('--- and back in again, edited, as the office would ---');

  const token = csrfFrom((await admin('GET', '/admin/import')).body);

  /*
   * One cell changed, the way somebody would in Excel: a corrected occupation
   * on the third person of the second household. Everything else is posted
   * back byte for byte as it was downloaded.
   */
  const edited = sheet.replace('"Student"', '"Architect"');
  check('the edit was actually made to the file', edited !== sheet, 'nothing was replaced');

  res = await admin.upload('/admin/import', {
    filename: 'families.csv', content: edited, csrf: token,
    fields: { on_existing: 'update' }
  });

  check('the parish’s own export is accepted back',
    res.status === 200 && !res.body.includes('Nothing was imported'),
    `status ${res.status}`);

  /*
   * The clause the old format failed. A column the importer has to skip is
   * reported on the page as one it did not recognise — accurate, and exactly
   * what a parish should never see after downloading a file from the same
   * application ten seconds earlier.
   */
  check('with no column it did not recognise',
    !/did not recognise|not recognised|ignored/i.test(res.body),
    (res.body.match(/<li>[^<]*column[^<]*<\/li>/gi) || []).join(' '));

  check('and nothing was created, because both families were already here',
    res.body.includes('2') && !/3 famil/.test(res.body),
    'the round trip duplicated a family');

  const after = await db.Family.count({ where: { church_id: church.id } });
  check('the parish still holds two families, not four', after === 2, `${after} families`);

  const found = await Family.findByRef(church.id, 'P036');
  const reread = await Family.findById(church.id, found.id);
  check('the one edited cell landed',
    reread.members[2].occupation === 'Architect', reread.members[2].occupation);

  check('and nothing else in the household moved',
    reread.head_name === 'Mr. Babu John'
    && reread.prayer_group === 'Ghorpadi'
    && reread.home_parish === 'St. Thomas MTC, Aylara.'
    && reread.members.length === 3
    && reread.members[0].mobile === '9850408389',
    JSON.stringify({
      head: reread.head_name, group: reread.prayer_group,
      parish: reread.home_parish, members: reread.members.length
    }));

  check('a multi-line address survives the trip back too',
    reread.address.includes('\n'), JSON.stringify(reread.address));

  const single = await Family.findById(church.id,
    (await Family.findByRef(church.id, 'P026')).id);
  check('the one-member household is untouched as well',
    single.head_name === 'Mr. Ashlin Sam Mohan' && single.members.length === 1,
    JSON.stringify({ head: single.head_name, members: single.members.length }));

  // ---------------------------------------------------------------------
  console.log('');
  console.log('--- a sheet that still calls the grouping an Area ---');

  /*
   * The Area was dropped, but a parish's own older spreadsheet still has that
   * heading on it, and refusing the column outright would be a worse answer
   * than reading it into the field that survived.
   */
  res = await admin.upload('/admin/import', {
    filename: 'old.csv',
    content: 'Family ID,Head of family,Area / Unit,Member,Relation\r\n'
      + 'P099,Mr. Old Sheet,Wanowrie,Mr. Old Sheet,Head\r\n',
    csrf: token,
    fields: { on_existing: 'skip' }
  });
  check('an old sheet’s Area column is read as the Prayer Group',
    res.status === 200 && !res.body.includes('Nothing was imported'),
    `status ${res.status}`);

  const older = await Family.findByRef(church.id, 'P099');
  check('and the value landed in Prayer Group',
    older && older.prayer_group === 'Wanowrie',
    older ? older.prayer_group : 'the family was not imported');

  // ---------------------------------------------------------------------
  console.log('');
  console.log('--- the sheet Excel hands back ---');

  /*
   * The one that sent the Parish round in circles.
   *
   * Download the export, open it in Excel, correct one cell, press Save — and
   * Excel writes back whatever its Save As box was last set to, which is
   * often "Text (Tab delimited)". The file is still called .csv, every cell in
   * it is still correctly quoted, and only the character between the cells has
   * changed. Read as commas it is one enormous column, and the report that
   * came back — "No Family ID column was found" — named a symptom nobody
   * could trace to the cause.
   */
  /*
   * Re-serialised from the parsed rows, not by splitting the text on newlines.
   *
   * Worth spelling out, because doing it the easy way produced a check that
   * passed while proving nothing: the Residence cell holds a two-line address,
   * so splitting the file on line endings tears that cell in half and shifts
   * every row after it. The sheet that reached the importer was then broken by
   * this test rather than by Excel, and "it imported" was measuring the wrong
   * failure. Excel quotes a multi-line cell properly; so does this.
   */
  const asTabs = csv.parse(sheet)
    .map((cells) => cells
      .map((c) => (/[\t\r\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
      .join('\t'))
    .join('\r\n') + '\r\n';

  check('a tab-separated sheet is recognised as one',
    csv.sniff(asTabs) === '\t', JSON.stringify(csv.sniff(asTabs)));
  check('and reads back the same columns a comma one does',
    csv.parse(asTabs)[0].join('|') === columns.headerRow().join('|'),
    csv.parse(asTabs)[0].join('|'));
  check('with its two-line address still whole inside one cell',
    csv.parse(asTabs).some((r) => r.some((c) => c.includes('\n'))),
    'the multi-line cell did not survive being written with tabs');

  res = await admin.upload('/admin/import', {
    filename: 'from-excel.csv', content: asTabs, csrf: token,
    fields: { on_existing: 'update' }
  });
  check('so Excel’s tab-delimited save imports like any other sheet',
    res.status === 200 && !res.body.includes('Nothing was imported'),
    (res.body.match(/<li>[\s\S]*?<\/li>/g) || []).slice(0, 3)
      .map((l) => l.replace(/<[^>]+>/g, '').trim()).join(' / ') || 'refused');

  /*
   * And a member's own Emails column survives the trip, which nothing on this
   * page was checking: the edit above lands in Occupation, so a sheet that
   * dropped every member address would have passed every other check here.
   */
  const backIn = await Family.findById(church.id,
    (await Family.findByRef(church.id, 'P036')).id);
  check('and a member’s Emails column comes back with its address',
    backIn.members[0].emails === 'bjohn7676@example.com', backIn.members[0].emails);

  /* A semicolon file, which is what Excel writes where the Windows list
     separator is one — the same accident wearing a different character. */
  const asSemis = asTabs.split('\t').join(';');
  check('and so does a semicolon-separated one', csv.sniff(asSemis) === ';', csv.sniff(asSemis));

  /* The guarantee that keeps all of the above safe: a comma file is still a
     comma file, whatever commas its quoted cells happen to contain. */
  check('while an ordinary comma sheet is unaffected',
    csv.sniff(sheet) === ',', csv.sniff(sheet));
  check('even when its cells are full of commas',
    csv.sniff('"a,b,c","d,e,f"\r\n1,2') === ',',
    csv.sniff('"a,b,c","d,e,f"\r\n1,2'));

  // ---------------------------------------------------------------------
  console.log('');
  console.log('--- and two answers that used to name the wrong thing ---');

  const emails = require('../lib/email');
  const phones = require('../lib/phone');

  /* A second address typed into the family's Email, which is the column that
     cannot hold one — it is the household's sign-in name. */
  const twoInOne = emails.problem('thomas.daniel@example.com, abc@yy.com');
  check('a second address in the family Email says which column it belongs in',
    /Emails column/.test(twoInOne || ''), twoInOne);
  check('and one good address is still simply good',
    emails.problem('thomas.daniel@example.com') === null);

  /* A number a spreadsheet has put lakh-crore separators into, which used to
     be counted as ten numbers. */
  const grouped = phones.listProblem('9,48,93,25,28,89,00,00,00,000', 'Roy Joseph');
  check('a digit-grouped mobile is named as one, not counted as ten',
    /thousands separators/.test(grouped || '') && !/10 mobile numbers/.test(grouped || ''),
    grouped);
  check('while two real numbers separated by a comma still pass',
    phones.listProblem('9489325288, 9000000000') === null,
    phones.listProblem('9489325288, 9000000000'));

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
