'use strict';

/**
 * Family self-verification, end to end.
 *
 * The whole exercise rests on one promise made to the Parish: nothing a family
 * submits changes the parish master record on its own. This file is that
 * promise, executed — a family signs in, corrects its entry, and the master
 * record is checked to be exactly as it was until an administrator has
 * approved the change line by line.
 *
 * It also covers the things that would quietly undermine it:
 *
 *   - a family cannot renumber itself or put itself into the printed book
 *   - a rejection carries its reason back to the family
 *   - approving one line and rejecting another leaves the rest untouched
 *   - a family with no email address signs in with its Family ID and a PIN
 *   - the queue exports in the columns the Parish asked for
 *   - the status chain moves, and the audit trail records each step
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-verify-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'verification-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const PORT = 4003;
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

function makeClient() {
  let cookie = '';
  return function request(method, urlPath, body) {
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
          status: res.statusCode, body: out, location: res.headers.location
        }));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

async function signIn(request, username, password = PASSWORD) {
  const page = await request('GET', '/login');
  return request('POST', '/login', {
    _csrf: csrfFrom(page.body), username, password
  });
}

async function post(request, from, action, body = {}) {
  const page = await request('GET', from);
  return request('POST', action, { _csrf: csrfFrom(page.body), ...body });
}

/** Every pending-change id offered on a page, in the order it appears. */
function changeIds(html) {
  return [...html.matchAll(/name="change_ids" value="(\d+)"/g)].map((m) => Number(m[1]));
}

/** The form a family posts back: its whole entry, with the corrections in it. */
function familyForm(overrides = {}) {
  return {
    head_name: 'Alpha Dsouza',
    address: '12 Old Street',
    hometown: '',
    home_parish: '',
    prayer_group: 'St Thomas',
    area: 'North',
    email: 'alpha@example.com',
    'members[0][id]': '',
    'members[0][name]': 'Alpha Dsouza',
    'members[0][relation]': 'Head',
    'members[0][dob_day]': '',
    'members[0][dob_month]': '',
    'members[0][dom_day]': '',
    'members[0][dom_month]': '',
    'members[0][mobile]': '9000000000',
    'members[0][blood_group]': '',
    'members[0][qualification]': '',
    'members[0][occupation]': '',
    'members[0][emails]': '',
    ...overrides
  };
}

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');

  await db.init();
  await db.Diocese.create({ name: 'Test Diocese', created_at: db.now() });

  const church = await db.Church.create({
    diocese_id: 1, zone_id: null, name: 'St Mary Church', slug: 'st-mary', created_at: db.now()
  });

  await db.User.create({
    username: 'parish-admin',
    password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Parish Administrator',
    role: 'admin',
    church_id: church.id,
    created_at: db.now()
  });

  const Family = require('../models/family');
  const Pending = require('../models/pending');

  const familyId = await Family.create(church.id, {
    family_id: '0001',
    head_name: 'Alpha Dsouza',
    address: '12 Old Street',
    hometown: '', home_parish: '',
    prayer_group: 'St Thomas', area: 'North',
    email: 'alpha@example.com',
    is_published: true,
    members: [
      { name: 'Alpha Dsouza', relation: 'Head', dob_day: null, dob_month: null, dom_day: null, dom_month: null,
        mobile: '9000000000', blood_group: '', qualification: '', occupation: '', emails: '' },
      { name: 'Beta Dsouza', relation: 'Spouse', dob_day: 2, dob_month: 8, dom_day: null, dom_month: null,
        mobile: '9111111111', blood_group: '', qualification: '', occupation: '', emails: '' }
    ]
  });

  // A second family, with no email address at all — the Family ID and PIN case.
  const noEmailId = await Family.create(church.id, {
    family_id: '0002',
    head_name: 'Gamma Pereira',
    address: '7 New Road',
    hometown: '', home_parish: '',
    prayer_group: 'St Thomas', area: 'South',
    email: '',
    is_published: true,
    members: [
      { name: 'Gamma Pereira', relation: 'Head', dob_day: null, dob_month: null, dom_day: null, dom_month: null,
        mobile: '9222222222', blood_group: '', qualification: '', occupation: '', emails: '' }
    ]
  });

  await db.User.create({
    username: 'alpha@example.com',
    password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Alpha Dsouza',
    role: 'family',
    church_id: church.id,
    family_id: familyId,
    created_at: db.now()
  });

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const before = await Family.findById(church.id, familyId);
  const memberIds = before.members.map((m) => m.id);

  const office = makeClient();
  await signIn(office, 'parish-admin');

  const family = makeClient();
  await signIn(family, 'alpha@example.com');

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- a family submits corrections, and the master record does not move ---');

  let res = await family('GET', `/families/${familyId}/edit`);
  check('the family can open its own entry', res.status === 200, `status ${res.status}`);

  const reviewing = await Family.findById(church.id, familyId);
  check('opening it records "Family Reviewing"',
    reviewing.verify_status === 'family_reviewing', reviewing.verify_status);

  res = await post(family, `/families/${familyId}/edit`, `/families/${familyId}`, familyForm({
    address: '99 New Street',
    'members[0][id]': String(memberIds[0]),
    'members[0][mobile]': '9333333333',
    'members[1][id]': String(memberIds[1]),
    'members[1][name]': 'Beta Dsouza',
    'members[1][relation]': 'Spouse',
    'members[1][dob_day]': '2',
    'members[1][dob_month]': '8',
    'members[1][dom_day]': '',
    'members[1][dom_month]': '',
    'members[1][mobile]': '9111111111',
    'members[1][blood_group]': '',
    'members[1][qualification]': '',
    'members[1][occupation]': '',
    'members[1][emails]': '',
    // A third member, added by the family — family composition.
    'members[2][id]': '',
    'members[2][name]': 'Anu Dsouza',
    'members[2][relation]': 'Daughter',
    'members[2][dob_day]': '',
    'members[2][dob_month]': '',
    'members[2][dom_day]': '',
    'members[2][dom_month]': '',
    'members[2][mobile]': '',
    'members[2][blood_group]': '',
    'members[2][qualification]': '',
    'members[2][occupation]': '',
    'members[2][emails]': ''
  }));
  check('the submission is accepted', res.status === 302, `status ${res.status}`);

  const master = await Family.findById(church.id, familyId);
  check('the master address is untouched', master.address === '12 Old Street', master.address);
  check('the master mobile is untouched',
    master.members[0].mobile === '9000000000', master.members[0].mobile);
  check('no member was added to the master record',
    master.members.length === 2, `${master.members.length} members`);
  check('the family is now at "Changes Submitted"',
    master.verify_status === 'changes_submitted', master.verify_status);

  const queued = await Pending.listQueue(church.id, { status: 'pending' });
  check('three lines are waiting', queued.length === 3, `${queued.length} lines`);
  check('one of them reads as a composition change in plain words',
    queued.some((c) => c.label === 'Member added: Anu Dsouza, Daughter'),
    queued.map((c) => c.label).join(' | '));
  check('the existing and proposed values are both recorded',
    queued.some((c) => c.existing_value === '12 Old Street' && c.proposed_value === '99 New Street'));

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- a family cannot renumber itself or put itself into the book ---');

  // Both members are sent back unchanged: a form that dropped one would be
  // proposing a removal, and this check is about the two fields a family may
  // never touch, not about composition.
  await post(family, `/families/${familyId}/edit`, `/families/${familyId}`, familyForm({
    family_id: '9999',
    is_published: '',
    'members[0][id]': String(memberIds[0]),
    'members[1][id]': String(memberIds[1]),
    'members[1][name]': 'Beta Dsouza',
    'members[1][relation]': 'Spouse',
    'members[1][dob_day]': '2',
    'members[1][dob_month]': '8',
    'members[1][dom_day]': '',
    'members[1][dom_month]': '',
    'members[1][mobile]': '9111111111',
    'members[1][blood_group]': '',
    'members[1][qualification]': '',
    'members[1][occupation]': '',
    'members[1][emails]': ''
  }));

  const stillNumbered = await Family.findById(church.id, familyId);
  check('the Family ID is unchanged', stillNumbered.family_id === '0001', stillNumbered.family_id);
  check('it is still in the printed book', stillNumbered.is_published === true);
  check('neither appears in the queue',
    !(await Pending.listQueue(church.id, { status: 'pending' }))
      .some((c) => c.field === 'family_id' || c.field === 'is_published'));

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- a household login cannot reach the review queue ---');

  res = await family('GET', '/review');
  check('/review is refused', res.status === 403, `status ${res.status}`);

  res = await family('GET', '/review/export.csv');
  check('so is the export', res.status === 403, `status ${res.status}`);

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- the reviewer sees old against proposed, and acts line by line ---');

  res = await office('GET', '/review');
  check('the queue renders', res.status === 200, `status ${res.status}`);
  check('it shows the existing value', res.body.includes('12 Old Street'));
  check('and the proposed value', res.body.includes('99 New Street'));
  check('and the composition change in plain words',
    res.body.includes('Member added: Anu Dsouza, Daughter'));

  const underReview = await Family.findById(church.id, familyId);
  check('opening the queue records "Under Parish Review"',
    underReview.verify_status === 'under_parish_review', underReview.verify_status);

  const open = await Pending.listQueue(church.id, { status: 'pending' });
  const addressLine = open.find((c) => c.field === 'address');
  const mobileLine = open.find((c) => c.field === 'mobile');
  const memberLine = open.find((c) => c.kind === 'member_add');

  res = await post(office, '/review', '/review/decide', {
    outcome: 'approve',
    back: '/review',
    change_ids: String(mobileLine.id)
  });
  check('approving one line redirects back', res.status === 302, `status ${res.status}`);

  let now = await Family.findById(church.id, familyId);
  check('the approved mobile number reached the parish record',
    now.members[0].mobile === '9333333333', now.members[0].mobile);
  check('the address it did not approve is still the old one',
    now.address === '12 Old Street', now.address);
  check('and no member has been added yet', now.members.length === 2);

  res = await post(office, '/review', '/review/decide', {
    outcome: 'reject',
    back: '/review',
    change_ids: String(addressLine.id),
    reason: 'Please confirm the new pin code with the office.'
  });
  check('rejecting a line redirects back', res.status === 302, `status ${res.status}`);

  now = await Family.findById(church.id, familyId);
  check('a rejected address never reaches the record',
    now.address === '12 Old Street', now.address);

  res = await family('GET', `/families/${familyId}`);
  check('the family is shown the reason it was rejected',
    res.body.includes('Please confirm the new pin code with the office.'));

  res = await post(office, '/review', '/review/decide', {
    outcome: 'approve',
    back: '/review',
    change_ids: String(memberLine.id)
  });

  now = await Family.findById(church.id, familyId);
  check('the approved member was added to the family',
    now.members.length === 3 && now.members.some((m) => m.name === 'Anu Dsouza'),
    now.members.map((m) => m.name).join(', '));
  check('the existing members kept their ids across the change',
    now.members.filter((m) => memberIds.includes(m.id)).length === 2);
  check('with nothing left waiting, the family reads as Ready for Printing',
    now.verify_status === 'ready_for_printing', now.verify_status);

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- a rejection with no reason given is still shown to the family ---');

  /*
   * The reason box on the review screen is optional — it reads "Reason, if
   * rejecting" — so a reviewer clearing a queue quickly rejects without
   * typing one. Those rejections have to reach the family all the same. The
   * family's page used to list only the ones that carried a reason, so a
   * household that had five corrections turned down saw whichever one the
   * reviewer had happened to explain, and no sign the other four existed.
   */
  await post(family, `/families/${familyId}/edit`, `/families/${familyId}`, familyForm({
    prayer_group: 'St Mary',
    'members[0][id]': String(memberIds[0]),
    'members[0][occupation]': 'Teacher'
  }));

  // The form sends the whole entry back, so this proposes several lines at
  // once — how many is not the point; that every one of them comes back is.
  const silent = await Pending.listQueue(church.id, { status: 'pending' });
  check('more corrections are waiting', silent.length >= 2, `${silent.length} waiting`);

  for (const line of silent) {
    await post(office, '/review', '/review/decide', {
      outcome: 'reject',
      back: '/review',
      change_ids: String(line.id)
      // deliberately no reason
    });
  }

  const afterSilent = await Pending.forFamily(church.id, familyId);
  const noReason = afterSilent.rejected.filter((c) => !c.reason);
  check('every one of them was rejected without a reason',
    noReason.length === silent.length, `${noReason.length} of ${silent.length}`);

  /*
   * Read only the "Not applied" list. The same label appears in the members
   * table further up the page, and again in the "Applied to the directory"
   * line of the very same card, so anything wider passes on a rejection that
   * was never listed as one.
   */
  res = await family('GET', `/families/${familyId}`);
  const from = res.body.indexOf('Not applied:');
  const decided = from === -1 ? '' : res.body.slice(from, res.body.indexOf('</ul>', from));
  check('the "Not applied" list is on the page', from !== -1);

  for (const line of noReason) {
    check(`"${line.label}" is listed there`, decided.includes(line.label));
  }
  check('the earlier rejection that had a reason is still listed too',
    decided.includes('Please confirm the new pin code with the office.'));

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- the audit trail carries the whole workflow ---');

  const auditLib = require('../lib/audit');
  const log = await auditLib.list({ churchId: church.id });
  const actions = log.map((l) => l.action);

  check('the submission was recorded', actions.includes('family.submitted'));
  check('the approval was recorded', actions.includes('family.approved'));
  check('the rejection was recorded', actions.includes('family.rejected'));
  check('an approval line says the master record was updated',
    log.some((l) => l.action === 'family.approved' && l.detail.includes('master record updated')));
  check('each line records who did it',
    log.every((l) => l.username && l.username.length > 0));

  res = await office('GET', '/admin/audit');
  check('the parish can read its own log', res.status === 200, `status ${res.status}`);
  check('and it carries the submission', res.body.includes('family.submitted'));

  const settled = await Pending.forFamily(church.id, familyId);
  check('the approved lines record when they reached the record',
    settled.approved.every((c) => !!c.applied_at));

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- the status chain and the dashboard ---');

  res = await office('GET', '/');
  check('the dashboard shows the chain', res.body.includes('Verification status'));
  check('every step is named',
    ['Not Started', 'Invitation Sent', 'Family Reviewing', 'Changes Submitted',
      'Under Parish Review', 'Approved', 'Ready for Printing', 'Printed']
      .every((label) => res.body.includes(label)));
  check('a count clicks through to those families',
    res.body.includes('/families/status?status=not_started'));

  res = await office('GET', '/families/status?status=not_started');
  check('the status list renders', res.status === 200, `status ${res.status}`);
  check('and holds only the family at that status',
    res.body.includes('Gamma Pereira') && !res.body.includes('>Alpha Dsouza<'));

  res = await office('GET', '/families/status?area=South');
  check('it narrows to one Area', res.body.includes('Gamma Pereira') && !res.body.includes('0001'));

  res = await office('GET', '/families/status/print?area=South');
  check('the follow-up sheet prints for that Area', res.status === 200, `status ${res.status}`);
  check('with the contact number on it', res.body.includes('9222222222'));

  res = await post(office, '/families/status', '/families/invitations');
  check('a batch can be marked as invited', res.status === 302, `status ${res.status}`);
  const invited = await Family.statusCounts(church.id);
  check('and the count moved',
    invited.counts.invitation_sent >= 1, JSON.stringify(invited.counts));


  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- the office approves a batch itself ---');

  // A household not yet in the printed book, so approval leaves it at Approved
  // rather than carrying it straight on to Ready for Printing.
  const unpublishedId = await Family.create(church.id, {
    family_id: '0004',
    head_name: 'Epsilon Rodrigues',
    address: '4 West Lane',
    hometown: '', home_parish: '',
    prayer_group: 'St Thomas', area: 'West',
    email: '',
    is_published: false,
    members: [
      { name: 'Epsilon Rodrigues', relation: 'Head', dob_day: null, dob_month: null,
        dom_day: null, dom_month: null, mobile: '9333333333', blood_group: '', qualification: '',
        occupation: '', emails: '' }
    ]
  });

  // A household that has actually sent something in must not be swept up by a
  // batch approval — its correction is still waiting for a reviewer to read it.
  await Pending.submit(church.id, familyId, [{
    kind: 'family', field: 'address', label: 'Address', tier: 'significant',
    existing_value: '12 Old Street', proposed_value: '13 New Street',
    payload: { kind: 'family', key: 'address', value: '13 New Street' }
  }], { id: null, username: 'test' });

  const statusOf = async (id) => (await Family.findById(church.id, id)).verify_status;
  const beforeBatch = await statusOf(familyId);

  res = await office('GET', '/families/status');
  check('the list offers a tick-box against every family',
    res.body.includes('name="family_ids"'));
  check('and a select-all in the header', res.body.includes('data-batch-all'));

  // Everything unticked. This is not "act on all of them" — the `selection`
  // marker is what tells the two apart.
  res = await post(office, '/families/status', '/families/approved', { selection: '1' });
  check('an empty tick-list is refused',
    res.status === 302 && /error=/.test(res.location || ''), res.location);
  check('and nothing was approved by it',
    !['approved', 'ready_for_printing'].includes(await statusOf(noEmailId)),
    await statusOf(noEmailId));

  // One family ticked, the rest left out.
  res = await post(office, '/families/status', '/families/approved',
    { selection: '1', family_ids: String(noEmailId) });
  check('a ticked family is approved, and being in the book, is ready to print',
    (await statusOf(noEmailId)) === 'ready_for_printing', await statusOf(noEmailId));
  check('an unticked family is left exactly where it was',
    (await statusOf(unpublishedId)) === 'not_started', await statusOf(unpublishedId));

  // No tick-list at all — a bare POST still means the whole filtered view, so
  // the screen's batch buttons keep working with scripting off.
  res = await post(office, '/families/status', '/families/approved');
  check('a batch with no tick-list acts on the whole view', res.status === 302, `status ${res.status}`);
  check('a family with a correction waiting is left alone however it was ticked',
    (await statusOf(familyId)) === beforeBatch, await statusOf(familyId));
  check('and its correction is still open for a reviewer',
    await Pending.familyHasOpen(church.id, familyId));
  check('one outside the printed book stops at Approved',
    (await statusOf(unpublishedId)) === 'approved', await statusOf(unpublishedId));

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- and marks the approved ones ready for printing ---');

  const publishedOf = async (id) => !!(await Family.findById(church.id, id)).is_published;

  // An approved family that is only a draft is not part of the run, so the
  // button has nothing it may move — and says so rather than moving it anyway.
  res = await post(office, '/families/status', '/families/ready',
    { selection: '1', family_ids: String(unpublishedId) });
  check('a draft entry is not carried into the book by it',
    (await statusOf(unpublishedId)) === 'approved', await statusOf(unpublishedId));
  check('and the notice says why',
    /not in the printed directory/.test(decodeURIComponent(res.location || '')), res.location);

  // The office puts it in the book. This is what an import leaves undone: every
  // imported family arrives as a draft, so the whole parish starts outside it.
  res = await post(office, '/families/status', '/families/published',
    { selection: '1', family_ids: String(unpublishedId), include: '1' });
  check('the office can put a batch into the printed book', res.status === 302, `status ${res.status}`);
  check('and the family is in it', await publishedOf(unpublishedId));

  res = await post(office, '/families/status', '/families/ready',
    { selection: '1', family_ids: String(unpublishedId) });
  check('the batch runs', res.status === 302, `status ${res.status}`);
  check('an approved family now in the book is ready to print',
    (await statusOf(unpublishedId)) === 'ready_for_printing', await statusOf(unpublishedId));

  res = await post(office, '/families/status', '/families/ready');
  check('an unapproved family is not carried into the book with it',
    (await statusOf(familyId)) === beforeBatch, await statusOf(familyId));

  // And the same button takes a family back out of the run.
  res = await post(office, '/families/status', '/families/published',
    { selection: '1', family_ids: String(unpublishedId), include: '0' });
  check('a family can be taken out of the printed book again',
    !(await publishedOf(unpublishedId)));
  check('which is a decision about the book, not a step back down the chain',
    (await statusOf(unpublishedId)) === 'ready_for_printing', await statusOf(unpublishedId));

  await post(office, '/families/status', '/families/published',
    { selection: '1', family_ids: String(unpublishedId), include: '1' });

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- a family with no email address: Family ID and PIN ---');

  res = await post(office, `/families/${noEmailId}`, `/families/${noEmailId}/pin`);
  check('a verification slip is issued', res.status === 200, `status ${res.status}`);
  check('the slip carries the Family ID', res.body.includes('0002'));

  const pin = (res.body.match(/<p class="pin">(\d{6})<\/p>/) || [])[1];
  check('and a six-digit PIN', !!pin, 'no PIN found on the slip');

  const household = makeClient();
  let page = await household('GET', '/family-login');
  check('the Family ID sign-in page renders', page.status === 200, `status ${page.status}`);

  res = await household('POST', '/family-login', {
    _csrf: csrfFrom(page.body),
    church_id: String(church.id),
    family_ref: '0002',
    pin
  });
  check('the family signs in with its Family ID and PIN',
    res.status === 302 && res.location === `/families/${noEmailId}`,
    `status ${res.status} to ${res.location}`);

  res = await household('GET', `/families/${noEmailId}`);
  check('and reaches its own entry', res.status === 200 && res.body.includes('Gamma Pereira'));

  res = await household('GET', `/families/${familyId}`);
  check("but not another family's", res.status === 403, `status ${res.status}`);

  const wrong = makeClient();
  page = await wrong('GET', '/family-login');
  res = await wrong('POST', '/family-login', {
    _csrf: csrfFrom(page.body),
    church_id: String(church.id),
    family_ref: '0002',
    pin: '000000'
  });
  check('a wrong PIN is refused', res.status === 401, `status ${res.status}`);
  check('and the message does not say which half was wrong',
    res.body.includes('That Family ID and PIN did not match'));

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- the Pending Changes export ---');

  res = await office('GET', '/review/export.csv');
  check('it is served as a CSV download',
    (res.body || '').length > 0 && res.status === 200, `status ${res.status}`);
  check('it begins with a UTF-8 byte order mark', res.body.charCodeAt(0) === 0xFEFF);
  check('the header is the one the Parish asked for',
    res.body.includes('"Family ID","Family","Field","Existing Value","Proposed Value",' +
      '"Submitted By","Submitted On","Reviewed By","Status","Reason"'));
  check('a decided line carries its reviewer', res.body.includes('Parish Administrator'));
  check('a rejected line carries its reason',
    res.body.includes('Please confirm the new pin code with the office.'));
  check('the export was itself recorded',
    (await auditLib.list({ churchId: church.id })).some((l) => l.action === 'export.pending'));

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- the two tiers, when a parish switches them on ---');

  const settingsLib = require('../lib/settings');
  await settingsLib.save(church.id, { approval_tiers: '2', routine_fields: 'mobile, email' });

  const verification = require('../lib/verification');
  const twoTier = await settingsLib.load(church.id);
  check('a routine field is routine', verification.tierOf('mobile', twoTier) === 'routine');
  check('everything else is significant', verification.tierOf('address', twoTier) === 'significant');

  await settingsLib.save(church.id, { approval_tiers: '1' });
  const oneQueue = await settingsLib.load(church.id);
  check('with one queue, every line is significant and approved on its own',
    verification.tierOf('mobile', oneQueue) === 'significant');

  // -------------------------------------------------------------------------
  console.log('');
  console.log('--- deleting a family takes its proposals with it ---');

  /*
   * `members` lost its ON DELETE CASCADE when migration 5 rebuilt the table,
   * so deleting a family failed outright on a foreign key. It is deleted with
   * its children explicitly now — and a proposal left waiting on a family that
   * no longer exists could never be reviewed, so it has to go the same way.
   */
  const doomed = await Family.create(church.id, {
    family_id: '0009',
    head_name: 'Delta Fernandes',
    address: '', hometown: '', home_parish: '',
    prayer_group: '', area: '', email: '',
    is_published: false,
    members: [{ name: 'Delta Fernandes', relation: 'Head', dob_day: null, dob_month: null,
      dom_day: null, dom_month: null, mobile: '', blood_group: '', qualification: '', occupation: '', emails: '' }]
  });

  await Pending.submit(church.id, doomed, [{
    kind: 'family', field: 'address', label: 'Address', tier: 'significant',
    existing_value: '', proposed_value: '1 Somewhere',
    payload: { kind: 'family', key: 'address', value: '1 Somewhere' }
  }], { id: null, username: 'test' });

  check('it can actually be deleted', (await Family.remove(church.id, doomed)) === true);
  check('its members went with it',
    (await db.Member.count({ where: { family_id: doomed } })) === 0);
  check('and so did its proposals',
    (await db.PendingChange.count({ where: { family_id: doomed } })) === 0 &&
    (await db.Submission.count({ where: { family_id: doomed } })) === 0);

  server.close();
  await db.close();

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  console.log('');
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    cleanUp();
    process.exit(code);
  })
  .catch((err) => {
    console.error('\nThe verification test threw:\n', err);
    cleanUp();
    process.exit(1);
  });
