'use strict';

/**
 * End-to-end smoke test.
 *
 * Builds a throwaway directory in a temporary folder, starts the app against
 * it, and drives it over HTTP the way a person would: sign in, read every
 * page, search, save a family, sign out.
 *
 * It exists because the data layer moved from hand-written SQL to Sequelize,
 * and "it still parses" is not the same as "it still works". Run it after any
 * change to db/, models/ or routes/:
 *
 *     npm test
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

// These must be set before config is required — it reads them once, at load.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-smoke-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'smoke-test-secret';
process.env.NODE_ENV = 'test';
// Otherwise the session cookie is Secure-only and this test speaks plain
// HTTP, so express-session would decline to set it at all and every request
// would arrive with a brand new session.
process.env.SECURE_COOKIES = '0';

const PORT = 3999;
const PASSWORD = 'test-password-1234';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
}

let cookie = '';
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        } : {})
      }
    }, (res) => {
      const set = res.headers['set-cookie'];
      if (set) cookie = set.map((c) => c.split(';')[0]).join('; ');
      let out = '';
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: out,
        location: res.headers.location
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function cleanUp() {
  // Windows holds a lock on an open SQLite file. A run that failed before
  // closing it must not turn that into an EBUSY stack that hides the real
  // error, so the temp directory is left for the operating system to sweep.
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (err) {
    /* nothing useful to do about it here */
  }
}

const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

async function seed(db, auth) {
  const diocese = await db.Diocese.create({ name: 'Test Diocese', created_at: db.now() });
  const zone = await db.Zone.create({
    diocese_id: diocese.id,
    name: 'Test Zone',
    created_at: db.now()
  });
  const church = await db.Church.create({
    diocese_id: diocese.id,
    zone_id: zone.id,
    name: 'Test Church',
    slug: 'test-church',
    created_at: db.now()
  });

  await db.User.create({
    username: 'tester',
    password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Test Administrator',
    role: 'admin',
    church_id: church.id,
    created_at: db.now()
  });

  const Family = require('../models/family');
  await Family.create(church.id, {
    family_id: '0001',
    head_name: 'Steve Smith',
    address: '1 Old Road',
    hometown: '',
    home_parish: '',
    email: 'steve@example.com',
    dom_day: 14,
    dom_month: 3,
    is_published: true,
    members: [
      {
        name: 'Mr. Steve Smith',
        relation: 'Head',
        dob_day: 2, dob_month: 8,
        mobile: '9876500111', emails: ''
      },
      {
        name: 'Mrs. Riva Smith',
        relation: 'Spouse',
        dob_day: 11, dob_month: 5,
        mobile: '', emails: ''
      }
    ]
  });
}

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');

  await db.init();
  await seed(db, auth);

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  console.log('\n--- before signing in ---');
  let res = await request('GET', '/login');
  check('the sign-in page renders', res.status === 200, `status ${res.status}`);

  const loginToken = csrfFrom(res.body);
  check('it carries a CSRF token', !!loginToken);

  res = await request('GET', '/families');
  check('an anonymous visitor is sent to sign in',
    res.status === 302 && res.location === '/login',
    `${res.status} -> ${res.location}`);

  console.log('\n--- the IndusNetwork banner, on every door into the application ---');
  /*
   * Attribution that appears on one of the two sign-in screens and not the
   * other is worse than none: a member who signs in with a Family ID would
   * see a different application from one who signs in with an email address.
   * The banner on both doors, and the image actually served.
   *
   * Its intrinsic size is asserted with it. The artwork is the whole mark now
   * rather than one chip inside a built plate, so a file swapped for one of
   * another shape would be stretched in silence by the `height: auto` that
   * holds its ratio — the attributes are what make that visible here.
   */
  for (const door of ['/login', '/family-login']) {
    const page = await request('GET', door);
    check(`${door} carries the banner`,
      page.status === 200
      && page.body.includes('/images/indus-network-banner.jpg')
      && page.body.includes('width="520" height="235"'),
      `status ${page.status}`);
  }

  for (const asset of ['/images/indus-network-banner.jpg']) {
    const file = await request('GET', asset);
    check(`${asset} is served`,
      file.status === 200 && file.body.length > 1000,
      `status ${file.status}, ${file.body.length} bytes`);
  }

  console.log('\n--- signing in ---');
  res = await request('POST', '/login', {
    _csrf: loginToken, username: 'tester', password: PASSWORD
  });
  check('a correct password signs in', res.status === 302, `status ${res.status}`);

  console.log('\n--- every page an administrator uses ---');
  const pages = [
    ['/', 'Dashboard', ['Coming up']],
    ['/families', 'Families', ['Steve Smith', '0001']],
    ['/families/1', 'One family', ['Steve Smith', 'Mrs. Riva Smith']],
    ['/families/1/edit', 'Edit a family', ['Steve Smith']],
    ['/families/new', 'Add a family', []],
    // The head's name, the Family ID in its pill, and the masthead's edition
    // mark — one thing from each of the three bands the sheet is built from.
    ['/directory', 'Printed directory',
      ['Steve Smith', 'fam-id', `${new Date().getFullYear()} Edition`]],
    ['/admin/users', 'User accounts', ['tester']],
    ['/admin/settings', 'Settings', []],
    ['/account', 'My account', []]
  ];

  for (const [urlPath, label, needles] of pages) {
    const page = await request('GET', urlPath);
    const missing = needles.filter((needle) => !page.body.includes(needle));
    check(`${label} (${urlPath})`,
      page.status === 200 && !missing.length,
      page.status !== 200 ? `status ${page.status}` : `missing: ${missing.join(', ')}`);
  }

  console.log('\n--- the top bar, which has to hold as screens are added ---');
  /*
   * The bar was one wrapping row, and the ninth link pushed the name and Sign
   * out onto a line of their own. The fix was to fold the administration
   * screens into one menu and pin the identity to its own column, so the guard
   * is a count: the top level stays small, and everything folded away is still
   * reachable from the markup rather than having quietly disappeared.
   */
  res = await request('GET', '/admin/settings');
  const bar = res.body.slice(res.body.indexOf('<nav class="nav">'), res.body.indexOf('</nav>'));
  // What is on the bar itself: the folded-away panels do not take up room.
  const openBar = bar.replace(/<div class="nav-menu-items">[\s\S]*?<\/div>/g, '');
  const topLevel = (openBar.match(/<(a|summary)\b/g) || []).length;

  check('an administrator sees a handful of top-level items, not a wrapping row',
    topLevel > 0 && topLevel <= 6, `${topLevel} items at the top level`);

  check('the administration screens are folded into one menu',
    bar.includes('<summary class="active">Manage</summary>'),
    'no Manage menu, or it is not marked as the section in use');

  /*
   * The prefix the links carry when the app is served under a sub-path. The
   * request paths above stay bare either way — a proxy strips the prefix
   * before forwarding, so only the URLs written into the page wear it.
   */
  const base = require('../config').basePath;

  for (const href of ['/admin/settings', '/admin/users', '/admin/import', '/admin/export', '/admin/audit']) {
    check(`${href} is still reachable from the bar`, bar.includes(`href="${base}${href}"`));
  }

  check('and the identity is not inside the navigation that wraps',
    res.body.indexOf('</nav>') < res.body.indexOf('class="whoami"')
    && res.body.includes('Sign out'),
    'Sign out was not found after the navigation');

  console.log('\n--- search, which reaches across to the members table ---');
  res = await request('GET', '/families?q=Riva');
  check('a member name finds their family',
    res.status === 200 && res.body.includes('Steve Smith'), `status ${res.status}`);

  res = await request('GET', '/families?q=nothingmatchesthis');
  check('a search matching nothing still renders', res.status === 200);

  console.log('\n--- the comma-separated boxes are wired for the chip editor ---');
  res = await request('GET', '/families/1/edit');
  check('the mobile box asks to be one', res.body.includes('data-tags'));
  check('and a limit that matches the one the server enforces',
    res.body.includes('data-tag-max="3"'), 'no limit on the field');
  // A number from outside India does not look like an Indian one, so the
  // mobile box no longer judges a chip by its shape the way it used to.
  check('the mobile box no longer judges a chip by an Indian-only shape',
    !res.body.includes('data-tag-pattern="0?[6-9][0-9]{9}"'));
  check('the page loads the script that reads all that',
    res.body.includes('javascripts/tag-input.js'), 'tag-input.js not included');
  check('and the boxes keep their names, so the form posts what it always did',
    res.body.includes('name="members[0][mobile]"') && res.body.includes('name="members[0][emails]"'),
    'a field lost its name');

  console.log('\n--- saving a family ---');
  res = await request('GET', '/families/1/edit');
  res = await request('POST', '/families/1', {
    _csrf: csrfFrom(res.body),
    family_id: '0001',
    head_name: 'Steve Smith',
    address: '12 New Lane',
    hometown: '',
    home_parish: '',
    email: 'steve@example.com',
    dom_day: '14',
    dom_month: '3',
    is_published: '1',
    'members[0][name]': 'Mr. Steve Smith',
    'members[0][relation]': 'Head',
    'members[0][dob]': '1975-08-02',
    // Typed with a space in it, the way a person writes a phone number down;
    // the space is stored out, the digits are not otherwise touched. See
    // lib/phone.js.
    'members[0][mobile]': '98765 43210',
    'members[0][qualification]': 'B.Sc. Nursing',
    'members[0][occupation]': 'Staff Nurse',
    'members[0][emails]': '',
    'members[1][name]': 'Mrs. Riva Smith',
    'members[1][relation]': 'Spouse',
    'members[1][dob]': '1978-05-11',
    'members[1][mobile]': '',
    'members[1][emails]': ''
  });
  check('saving redirects', res.status === 302, `status ${res.status}`);

  res = await request('GET', '/families/1');
  check('the change was written', res.body.includes('12 New Lane'));
  check('members were replaced rather than duplicated',
    (res.body.match(/Mrs\. Riva Smith/g) || []).length === 1);
  check('the member count is still 2', (await db.Member.count()) === 2);
  check('the mobile number was stored without its space',
    (await db.Member.findOne({ where: { name: 'Mr. Steve Smith' } })).mobile === '9876543210');

  console.log('\n--- a member row the browser would have refused ---');
  // The browser objects to all of these first. The point of the check is that
  // a form which never went through a browser is refused just the same, and
  // that the complaint names the member rather than the field alone. A mobile
  // number is no longer among them — see lib/phone.js — except for how many
  // of them there are, which is a question of what the printed cell holds
  // rather than which country the numbers are from.
  const badRows = [
    ['a qualification of only symbols', { qualification: '###$$$' }],
    ['an occupation longer than the cell', { occupation: 'x'.repeat(61) }],
    ['an email address with no domain ending', { emails: 'steve@gmail' }],
    ['more email addresses than the cell holds',
      { emails: 'a@x.com, b@x.com, c@x.com, d@x.com' }],
    ['more mobile numbers than the cell holds',
      { mobile: '9876543210, 9876543211, 9876543212, 9876543213' }]
  ];

  for (const [what, overrides] of badRows) {
    res = await request('GET', '/families/1/edit');
    const row = {
      'members[0][name]': 'Mr. Steve Smith',
      'members[0][relation]': 'Head',
      'members[0][dob]': '1975-08-02',
      'members[0][mobile]': '9876543210',
      'members[0][qualification]': '',
      'members[0][occupation]': '',
      'members[0][emails]': ''
    };
    for (const [key, value] of Object.entries(overrides)) {
      row[`members[0][${key}]`] = value;
    }

    res = await request('POST', '/families/1', {
      _csrf: csrfFrom(res.body),
      family_id: '0001',
      head_name: 'Steve Smith',
      address: '12 New Lane',
      email: 'steve@example.com',
      is_published: '1',
      ...row
    });
    check(`${what} is refused`, res.status === 400, `status ${res.status}`);
    check(`${what} is complained about by member name`,
      res.body.includes('Steve Smith'));
  }

  res = await request('GET', '/families/1');
  check('and none of that was written', res.body.includes('9876543210'));

  // A parish with families abroad reaches them on a number with a country
  // code, a length that is not ten, and no reason to start 6-9 — none of
  // that is refused any more. Only the visual separators are taken out.
  res = await request('GET', '/families/1/edit');
  res = await request('POST', '/families/1', {
    _csrf: csrfFrom(res.body),
    family_id: '0001',
    head_name: 'Steve Smith',
    address: '12 New Lane',
    email: 'steve@example.com',
    is_published: '1',
    'members[0][name]': 'Mr. Steve Smith',
    'members[0][relation]': 'Head',
    'members[0][dob]': '1975-08-02',
    'members[0][mobile]': '+1 (416) 555-0199'
  });
  check('a number with a country code is accepted',
    res.status === 302, `status ${res.status}`);
  check('and stored with its "+" and digits, only the visual separators gone',
    (await db.Member.findOne({ where: { name: 'Mr. Steve Smith' } })).mobile === '+14165550199');

  // A trunk 0, a short number, and a number the same field lists twice all
  // used to be refused as well; none of them is now.
  res = await request('GET', '/families/1/edit');
  res = await request('POST', '/families/1', {
    _csrf: csrfFrom(res.body),
    family_id: '0001',
    head_name: 'Steve Smith',
    address: '12 New Lane',
    email: 'steve@example.com',
    is_published: '1',
    'members[0][name]': 'Mr. Steve Smith',
    'members[0][relation]': 'Head',
    'members[0][dob]': '1975-08-02',
    'members[0][mobile]': '09000003251, 09000003251'
  });
  check('a trunk 0 and a repeated number are both accepted',
    res.status === 302, `status ${res.status}`);
  check('and stored exactly as given, unstraightened',
    (await db.Member.findOne({ where: { name: 'Mr. Steve Smith' } })).mobile
      === '09000003251,09000003251');

  // A spreadsheet column left as a number turns a long digit string into
  // scientific notation on export — not a phone number in any country, and
  // the only shape still refused. The browser has no opinion on this any
  // more than the server does on a real number, so this is a server-only
  // check, unlike the rows above.
  res = await request('GET', '/families/1/edit');
  res = await request('POST', '/families/1', {
    _csrf: csrfFrom(res.body),
    family_id: '0001',
    head_name: 'Steve Smith',
    address: '12 New Lane',
    email: 'steve@example.com',
    is_published: '1',
    'members[0][name]': 'Mr. Steve Smith',
    'members[0][relation]': 'Head',
    'members[0][dob]': '1975-08-02',
    'members[0][mobile]': '9.18594E+11'
  });
  check('a spreadsheet\'s scientific notation is refused',
    res.status === 400, `status ${res.status}`);
  check('and named as what it is, not as a bad phone number',
    res.body.includes('scientific notation'));
  check('and the member it belongs to',
    res.body.includes('Steve Smith'));

  console.log('\n--- a family reference is unique per church, not across them ---');
  const second = await db.Church.create({
    diocese_id: 1,
    zone_id: null,
    name: 'Second Church',
    slug: 'second-church',
    created_at: db.now()
  });

  const reused = await db.Family.create({
    church_id: second.id,
    family_id: '0001',
    head_name: 'Another Head',
    created_at: db.now(),
    updated_at: db.now()
  }).then(() => true).catch(() => false);
  check('another church may also number a family 0001', reused);

  const clashed = await db.Family.create({
    church_id: 1,
    family_id: '0001',
    head_name: 'Duplicate',
    created_at: db.now(),
    updated_at: db.now()
  }).then(() => false).catch(() => true);
  check('the same church may not use 0001 twice', clashed);

  console.log('');
  console.log('');
  console.log('--- settings belong to one church, with the house defaults behind them ---');
  const settingsLib = require('../lib/settings');

  await settingsLib.save(second.id, {
    parish_name: 'Second Church Name',
    color_band: '#123456'
  });

  const first = await settingsLib.load(1);
  const other = await settingsLib.load(second.id);

  check('a church sees the name it chose', other.parish_name === 'Second Church Name');
  check('the other church is untouched by that',
    first.parish_name !== 'Second Church Name',
    'church 1 parish_name is ' + first.parish_name);
  check('a key it never set falls back to the house default',
    other.per_page === first.per_page);
  check('the installation vocabulary is shared, not per church',
    other.zone_label === first.zone_label && !!other.zone_label);

  await settingsLib.save(second.id, { parish_name: 'Renamed Again' });
  check('saving again is seen immediately, so the cache invalidates',
    (await settingsLib.load(second.id)).parish_name === 'Renamed Again');

  console.log('--- a church administrator cannot make a super administrator ---');
  res = await request('GET', '/admin/users');
  check('the role menu does not offer it',
    !res.body.includes('value="superadmin"'),
    'the Users page is offering the superadmin role');

  res = await request('POST', '/admin/users', {
    _csrf: csrfFrom(res.body),
    username: 'sneaky',
    full_name: 'Escalation Attempt',
    role: 'superadmin',
    password: 'another-password-99',
    password_confirm: 'another-password-99'
  });
  check('posting the role directly is refused', res.status === 400, `status ${res.status}`);
  check('and no such account was created',
    (await db.User.count({ where: { role: 'superadmin' } })) === 0);

  // -------------------------------------------------------------------------
  console.log('\n--- typing the parish name to confirm a deletion ---');

  /*
   * The confirmation that could not be satisfied.
   *
   * This parish is on record as "St. Peter’s Mar Thoma Church", with the
   * typographic apostrophe U+2019. The check on both ends was an exact string
   * comparison, so the straight apostrophe a keyboard produces never matched
   * — and nothing on screen said so. The button simply stayed dead.
   *
   * Nothing covered this route at all, which is how it shipped. So: the name
   * is renamed to carry the same character, and both ends are asked.
   */
  const nameMatch = require('../public/javascripts/name-match');
  const settingsLib2 = require('../lib/settings');
  const church = await db.Church.findOne({ where: { slug: 'test-church' } });

  await db.Church.update(
    { name: 'St. Peter\u2019s Mar Thoma Church' },
    { where: { id: church.id } }
  );
  settingsLib2.invalidate();
  const onRecord = 'St. Peter\u2019s Mar Thoma Church';

  check('the exact name matches, apostrophe and all',
    nameMatch.same(onRecord, onRecord));
  check('and so does the apostrophe a keyboard actually types',
    nameMatch.same("St. Peter's Mar Thoma Church", onRecord),
    'the straight apostrophe was refused, which is the bug');
  check('case does not matter',
    nameMatch.same("st. peter's mar thoma church", onRecord));
  check('nor do doubled or stray spaces',
    nameMatch.same("  St. Peter's   Mar Thoma Church ", onRecord));
  check('nor a non-breaking space pasted out of a web page',
    nameMatch.same('St. Peter\u2019s\u00A0Mar Thoma Church', onRecord));
  check('nor an acute accent from a dead key',
    nameMatch.same('St. Peter\u00B4s Mar Thoma Church', onRecord));

  /* What it still refuses, which is the point of asking at all. */
  check('an empty box never matches', !nameMatch.same('', onRecord));
  check('neither does a different parish',
    !nameMatch.same('Pune St Peters Mar Thoma Church', onRecord));
  check('nor the name with its punctuation dropped',
    !nameMatch.same('St Peters Mar Thoma Church', onRecord));
  check('nor the name one letter short',
    !nameMatch.same('St. Peter\u2019s Mar Thoma Churc', onRecord));

  /*
   * And the same answers through the route, because a browser that enables the
   * button on a value the server refuses is worse than no button state at all.
   * Checked here against a parish with families in it, so a wrong answer would
   * show up as an empty directory.
   */
  const familyCount = async () => db.Family.count({ where: { church_id: church.id } });
  const standing = await familyCount();
  check('the parish has families to lose', standing > 0, `${standing} families`);

  res = await request('GET', '/admin/settings');
  check('the settings page shows the name to type',
    res.body.includes('St. Peter\u2019s Mar Thoma Church'),
    'the page did not offer the name to copy');
  check('and loads the rule the button shares with the server',
    res.body.includes('/javascripts/name-match.js'), 'the shared rule was not loaded');

  let token = csrfFrom(res.body);
  res = await request('POST', '/admin/settings/delete-database', {
    _csrf: token, confirm_name: 'Some Other Church'
  });
  check('the wrong name deletes nothing',
    (await familyCount()) === standing && /error=/.test(res.location || ''),
    res.location);

  res = await request('POST', '/admin/settings/delete-database', {
    _csrf: token, confirm_name: ''
  });
  check('and an empty box deletes nothing',
    (await familyCount()) === standing, 'an empty confirmation went through');

  /* The straight apostrophe, which is what an administrator can actually
     type, and which used to be refused here. */
  res = await request('GET', '/admin/settings');
  token = csrfFrom(res.body);
  res = await request('POST', '/admin/settings/delete-database', {
    _csrf: token, confirm_name: "  st. peter's mar thoma church  "
  });
  check('the name as a keyboard types it is accepted',
    (await familyCount()) === 0 && /notice=/.test(res.location || ''),
    res.location);

  console.log('\n--- signing out ---');
  res = await request('GET', '/');
  res = await request('POST', '/logout', { _csrf: csrfFrom(res.body) });
  check('signing out redirects', res.status === 302 && res.location === '/login');

  res = await request('GET', '/families');
  check('access is gone afterwards', res.status === 302 && res.location === '/login');

  server.close();
  await db.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    cleanUp();
    process.exit(code);
  })
  .catch((err) => {
    console.error('\nThe smoke test threw:\n', err);
    cleanUp();
    process.exit(1);
  });
