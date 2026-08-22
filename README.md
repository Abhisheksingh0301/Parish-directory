# Parish Directory

A printable family directory, with sign-in, for **many churches in one
installation**. The printed output is a server-rendered version of the approved
layout in `public/parish-directory-template.html`, filled from a database
instead of a hand-edited array at the bottom of an HTML file.

Nothing about a particular parish is in the code. Its name, the printed
palette, the page layout, the relation names and the password its members are
given are all settings an administrator edits in the browser — and each church
has its own.

Relations are whole words — `Head`, `Spouse`, `Son`, `Daughter` — not the codes
`HF, W, S, D` this started with. They print as typed and read without a key,
which matters when the family filling in its own entry has never seen the
directory's shorthand.

---

## Running it

### 1. Have Node.js 18 or newer

```bash
node -v      # v18.0.0 or higher
npm -v
```

If that command is not found, install Node.js from [nodejs.org](https://nodejs.org)
and open a new terminal afterwards, so the updated `PATH` is picked up.

### 2. Install the dependencies

From the project folder:

```bash
npm install
```

Once, and again only when `package.json` changes. It writes `node_modules/`,
which is not in the repository.

### 3. Create your `.env`

The app reads its configuration from a `.env` file that does not ship with the
code — copy the example and edit it:

```bash
cp .env.example .env                 # macOS, Linux, Git Bash
```

```powershell
Copy-Item .env.example .env          # Windows PowerShell
```

The defaults run as they are for local use. The one value worth setting now is
`SESSION_SECRET`, which signs the session cookie — generate one and paste it in:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Leaving it empty is fine while `NODE_ENV=development`. In production the app
**refuses to start** without it, rather than quietly inventing a throwaway
secret that logs everybody out on every restart.

### 4. Start the server

```bash
npm start
```

Then open **http://localhost:3000**. Stop it with `Ctrl+C`.

Nothing needs creating first: on start-up `bin/www` opens the database in
`DATA_DIR` (`./data` by default), creating it if it is not there, and applies
any migrations the code is ahead of. Use `npm run dev` instead while working on
the code — it restarts on every file change.

If the port is taken, change `PORT` in `.env`.

### 5. Create the first account

**A brand-new database has no users**, so visiting any page sends you to
`/setup`, which asks for the first administrator and the parish name. Fill it
in and you are signed in.

**An installation upgraded from the single-parish version already has users**,
so `/setup` is closed and the super administrator is made from the command line
instead:

```bash
node bin/superadmin.js create bishop@example.com
npm run superadmin -- create abc@xyz.com --password '1212121212'
```

**The username must be an email address** — the same rule family logins already
follow, and this is the one account with nobody above it to recover it. It then
asks for a password twice, without echoing it, and wants at least 8 characters.

`reset <address>` puts a new password on an existing super administrator,
reactivating it if it was switched off, and `list` shows them all.

That route is deliberately not on the web. `/setup` is open to anyone while the
database has no users at all, and on an upgraded directory — which has users
already — leaving an unauthenticated way to mint the most privileged account in
the system would be indefensible.

### 6. Check it works

```bash
npm test
```

259 end-to-end checks across seven suites — smoke, console, tenancy, reports,
verification, export and import-template — each booting the app over HTTP
against a throwaway database in your system temp folder. They override
`DATA_DIR`, so your own `data/` folder is left alone. The last line should read
`ALL CHECKS PASSED`. Run one suite on its own with `npm run test:tenancy`, and
the same for `test:smoke`, `test:console`, `test:reports`,
`test:verification`, `test:export` and `test:import-template`.

### Every command

| Command | |
|---|---|
| `npm start` | Run the app |
| `npm run dev` | Run it, restarting on file changes |
| `npm test` | All 259 checks |
| `npm run superadmin` | Create, reset or list super administrators |
| `npm run backup` | Snapshot the database and photographs |
| `npm run import-hierarchy -- --file <x.csv>` | Load dioceses, zones and churches from a CSV. Without `-- --file` it only prints its usage |
| `npm run import-families -- --church <slug> --file <x.csv>` | Load a parish's existing families from its own spreadsheet. Run it with `--dry-run` first |

---

## How it is arranged

```
diocese
  └── zone            a church belongs to one, or to none yet
        └── church    the tenant: owns its families and its settings
              └── family
                    └── member
```

**A family is owned by its church and by nothing else.** Diocese and zone are
grouping, used for selecting and reporting; they are not permission boundaries.
Every query about a family names its church in the `WHERE` clause, so one
parish cannot see another's by guessing an id.

Both nouns are configurable, because Indian denominations do not share them —
Eparchy and Forane, Diocese and Pastorate, Region and Centre. Set
`diocese_label` and `zone_label` once for the installation.

---

## Who can do what

| Role | Can do |
|---|---|
| **Super administrator** | Adds dioceses, zones and churches. Reaches every church, and can view, print or export any selection of them |
| **Administrator** | Everything within **their own church**, including its settings and its accounts |
| **Editor** | Add, edit and delete families in their church |
| **Viewer** | Browse and print their church's directory; change nothing |
| **Member** | Complete and correct their own family's entry, and nothing else |

A super administrator belongs to no church. To use the ordinary screens they
open one from the console, and a bar on every page says which parish they are
working in until they leave it — they are allowed everywhere, and that is
exactly why it is easy to edit the wrong directory by accident.

A member login is not a directory account. It reaches exactly one family — its
own — and never the list, the dashboard or the printed book, so giving a
household a login does not hand it everybody else's address and telephone
number.

### The sign-in screens

Every door into the application — `/login`, `/family-login` and the one-time
`/setup` — carries the **Powered & Secured By** badge for IndusDefender and
IndusNetwork, from `views/partials/indus-badge.ejs`.

It is in this directory's palette, not the navy and gold of the site it came
from: the plate is `--paper-warm` over `--line`, the same panel the rest of the
application is built from, so it belongs to the page instead of being a window
cut into it. Every colour is one of the variables at the top of `app.css`, bar
one — the warm brown `#6b4f2a` this stylesheet already gives every link, which
stands in for the brand gold. The gold itself reads at 1.5:1 on this background
and cannot be used; the substitute reads at 6.9:1.

"Protect. Prevent. Prevail." is typed rather than shown. It is baked into the
supplied artwork in near-white, which was right on a navy panel and invisible
on this one, so the shield is cropped free of it and the words are set in the
palette's own colours — which also lets "Prevail." keep its accent.

The two logos live in `public/images/` as ordinary cached files rather than
inline data URIs, at twice their display size — 42 KB and 29 KB, down from the
409 KB and 95 KB originals, which would otherwise have been re-sent as base64
on every visit to the sign-in page.

### What the top bar shows

Daily work stays in the open — Dashboard, Families, Review, Print directory.
The administration screens fold into one **Manage** menu (Settings, Users,
Import members, Download your data, Audit log), because they are visited
occasionally and nine flat links wrapped the bar onto a second line, displacing
the name and Sign out.

A super administrator sees **System**, **Churches** and **Reports** flat while
they are in their own console — that is their whole application. Once they have
borrowed a parish those three fold into a **System** menu instead, and the
parish's own navigation takes the top level.

Both menus are `<details>` elements, so they work with JavaScript off;
`public/javascripts/nav-menu.js` only adds Escape, click-away, and closing one
when the other opens. The bar itself is a three-column grid rather than a
wrapping row, so the identity holds its place however many links appear.

---

## Two shapes of date

**Date of marriage** is **day and month only** — `14 - Mar`. There is no year
field for it anywhere, in the form or in the printed book.

**Date of birth** is a **full date** — `02 - Aug - 1975` — chosen with a date
picker, so it is a real date by construction: between 1900 and today, with
29 February only in a leap year. The picker is
`public/javascripts/datepicker.js` rather than the browser's own, which only
walks a month at a time: it puts the month and the year in dropdowns above the
calendar, because a date of birth is usually decades away. It enhances a plain
`<input type="date">`, so with JavaScript off the field is still a native date
input and the server sees the same value. A son or daughter must be born after
the youngest parent in the family; the form refuses a child who would be as old
as their parents.

Both are stored as separate small integers (`dom_day` / `dom_month`,
`dob_day` / `dob_month` / `dob_year`) rather than a date string. Day and month
in their own columns keeps the birthday and anniversary list on the dashboard
sortable without caring about the year — and lets a date of marriage exist
without inventing a year nobody supplied. `dob_year` stays nullable: entries
recorded before the year was collected still print, and the form offers to keep
that day and month rather than losing it when the rest of the row is edited.

In the printed entry the DOM cell is merged across the first two member rows,
matching the approved layout — which assumes the second row is the spouse. When
it is a recognised son or daughter instead, the merge shrinks to the head's own
row (`relations.domSpan`), because a merged cell over a child reads as that
child's wedding date. An unfamiliar relation code prints exactly as before:
a parish's own codes never quietly redraw its book.

---

## Letting families complete their own entry

Collecting a directory by hand is the slow part. Any family with an email
address can be given a login instead, and fill in its own entry.

On **Families**, under *Invite families to complete their own entry*:

1. **Create member logins** — one account per family, the username being the
   family's own email address, all with the same default password.
2. **Copy all addresses** — every family email, comma separated, ready for the
   Bcc line of one message.

**The default password belongs to the church, not to the installation.** Each
one sets its own under Settings, so a parish's staff can read the string that
opens their own new accounts and nobody else's. Anyone still using it sees a
reminder on every page until they choose their own.

There is no email sending anywhere in this app, so there is no reset link. The
chain that replaces it needs no email at any step:

| Who forgets | Who fixes it |
|---|---|
| A member | Their church administrator, from the family's page |
| A church administrator | The super administrator, after opening that church |
| The super administrator | `node bin/superadmin.js reset <username>` |

---

## Family verification, and the approval queue

**Nothing a family submits changes the parish record on its own.** A family
login may edit every field of its own entry with no restriction on what it
proposes — but the submission is written to a pending store, and the master
record is left exactly as the parish office left it until Achen or an
authorised administrator has approved it.

### The workflow

    Existing parish data → Import → Family verification → Family submits changes
      → Achen or Admin review → Approval → Master record updated
      → Final verification → Print-ready PDF and CSV export

### Reviewing

**Review** shows one block per family: the field, its existing value, its
proposed value, and an action on each line.

- **Only changed fields are listed.** A reviewer reads three lines, not the
  whole record.
- **Each line is approved or rejected on its own.** A new mobile number can be
  accepted and a proposed address rejected in the same submission; the rest of
  the record is untouched.
- **Photographs are shown side by side**, the existing one against the proposed.
- **Family composition reads in plain words** — *Member added: Anu Dsouza,
  Daughter* — rather than as a comparison of table rows.
- **Dates are shown in the directory's own format**, so the reviewer is
  comparing what will actually be printed.
- **A rejection may carry a short reason**, which the family sees the next time
  it signs in, so a rejected correction is not silently lost.

Two fields are never a family's to propose: the **Family ID** and **inclusion
in the printed directory**. Both stay with the parish office and are dropped
from a submission before it is read.

### One queue, or two

Under **Settings → Which changes require approval**:

| | |
|---|---|
| **One queue** *(default)* | Every change is approved on its own line, by an administrator. Recommended for a pilot: with five or ten families the volume is small and no field can be mis-classified. |
| **Two tiers** | *Routine* changes — mobile, email, occupation, qualification, photograph by default — may be cleared by an editor and approved as a batch. Everything else is approved individually by an administrator. |

It is the same review screen either way; the tier only decides who may clear a
line and whether batch approval is offered. Which fields are routine is a
parish setting, not something fixed in the code.

### Families with no email address

No family is excluded for want of one. Three provisions, and a family may use
whichever suits:

1. **Family ID and PIN.** Issue a verification slip from the family's page, or
   for a whole batch from **Verification status**. The household signs in at
   `/family-login` with its Family ID and the six digits on the slip. No email
   address is involved at any step. The PIN is shown once and stored only as a
   hash — if a slip is lost, issue a new one.
2. **Assisted entry.** An Area Representative or the office signs in and submits
   on the family's behalf. It enters the same queue, and the audit trail records
   who submitted it, so an assisted entry is never mistaken for one the family
   made itself.
3. **Paper.** The family corrects a printed slip by hand and the office keys it
   in — same queue, same approval step.

### Verification status

The dashboard counts each step of the chain, and every count clicks through to
the families behind it:

    Not Started → Invitation Sent → Family Reviewing → Changes Submitted
      → Under Parish Review → Approved → Ready for Printing → Printed

Every status view narrows to one **Area** or **Prayer Group**, and the same
filter produces a **printable follow-up sheet** — Family ID, family head,
contact number and current status — which is the sheet the Area Representative
actually carries.

*One honest note on Invitation Sent:* this application sends no email itself, so
that status is recorded when the parish office marks a batch as sent. It is an
accurate record of the parish's action, not a delivery receipt from a mail
server, and it should not be read as one.

### The audit trail

**Audit log** is readable per parish, newest first, and filterable by event
type. The verification workflow records who submitted a change and when, who
reviewed it and when, the outcome with the reason where one was given, and the
moment the approved value reached the parish record. Every export is recorded
too. The log keeps its own copy of the operator's name, so a record survives the
account being deleted — and no screen anywhere in this application edits or
deletes a log line.

### Exporting the queue

**Export the queue** gives a CSV of Family ID, Family, Field, Existing Value,
Proposed Value, Submitted By, Submitted On, Reviewed By, Status and Reason. It
doubles as the working paper for a review meeting: the queue can be read on
paper and cleared on screen afterwards.

---

## Importing the parish's existing families

The objective is that no family keys in what the parish already holds. Every
family should find its existing record already on screen, with only the
corrections left to make.

### The template the parish fills in — **Manage → Import members**

`/admin/import` is where the parish office gets the sheet. It offers the blank
spreadsheet as a download — **with example rows** or **headings only** — beside
the columns, the accepted alternative spellings for each, this church's own
relation codes and the date rules. Administrators only, one church at a time.

The headings are generated from the importer's own column list
(`lib/import-columns.js`, shared with `bin/import-families.js`), so a heading
the template prints is a heading the import reads back; the two cannot drift.
They are also the export's headings, so a file downloaded from **Download your
data**, edited, can be handed straight back.

The load itself stays at the command line. Several hundred families arriving at
once is not a thing to do from a web form on a first attempt — the dry run and
the rejects file are what make it safe:

```bash
npm run import-families -- --church st-marys --file parish.csv --dry-run
npm run import-families -- --church st-marys --file parish.csv --rejects bad.csv
```

**One row per member**, with the Family ID grouping a family's rows together.
Column headings are matched by name in any letter case and with any punctuation,
and several spellings of each are recognised — run it with `--dry-run` and no
arguments to see the list.

- **A dry run first.** It reports everything it would create and every row it
  cannot read, without writing anything at all.
- **Safe to run more than once.** A Family ID already in the church is reported
  as skipped, never duplicated and never overwritten.
- **A rejects file** lists precisely the rows that could not be read, and why,
  in the same columns — correct them in the spreadsheet and import again. A
  family with one unreadable row is held back whole, so the corrected sheet
  brings in the complete family rather than the missing half of one.
- **Nothing is discarded silently.** A date of birth with no year keeps its day
  and month and prints correctly; a column this directory has no home for is
  reported rather than dropped.
- **No logins are created.** Accounts are a separate, deliberate step — a few
  hundred families should not quietly become a few hundred live accounts.
- **Imported families are drafts**, so half a parish cannot enter the printed
  book before anybody has looked at it.

---

## Viewing, printing and exporting across churches

Under **Reports**, a super administrator picks any churches, any zones or any
dioceses. The same selection feeds three outputs:

- **A screen** listing every family in it.
- **One printed book**, a section per church, each in its own colours, with the
  page numbers running through. A church's own starting page number applies
  only when it prints alone.
- **A spreadsheet**, one row per member, with its diocese, zone and church in
  the first three columns.

An empty selection produces nothing — never everything.

---

## Downloading the data, with the photographs

**Download** on the administrator's menu gives a parish its own records back.
The console has the same two downloads under Reports, for any selection of
churches.

- **Spreadsheet only** (`.csv`) — one row per person, the family's details
  repeated on each of their rows. That is the shape that sorts and filters in
  Excel; one row per family cannot hold the members at all.
- **Spreadsheet and photographs** (`.zip`) — the same sheet, plus every
  photograph, each named after the family it belongs to. The sheet's last
  column gives that name, so a row and a face can be matched without opening
  the application. A `README.txt` in the archive says the same thing to
  whoever receives it.

Drafts are included by default — they are the parish's own unfinished entries,
and an export that dropped them silently would be a backup with holes in it.
The tick box leaves them out for a copy going to a printer.

A photograph on record whose file has gone missing leaves an empty cell rather
than a name pointing at nothing, and the export still completes; the count of
missing files goes to the server log.

Both downloads are recorded in the audit log. Nothing is staged on disk: the
archive streams as it is built, so a whole installation costs one photograph of
memory rather than all of them. It also takes minutes and runs to hundreds of
megabytes — the page says so, because an operator who thinks it has hung will
click it again.

The archive is written by `lib/zip.js`, which stores rather than compresses
(every file in it is already a compressed image) and switches to ZIP64 per
entry when one is needed — forty thousand photographs is past what a classic
archive can describe.

---

## Loading the hierarchy from a spreadsheet

Typing two hundred churches into a form is not a reasonable way to start.

```bash
node bin/import-hierarchy.js --file mine.csv --dry-run   # look first
node bin/import-hierarchy.js --file mine.csv
```

Four columns — `diocese, zone, church, city` — and a row is read as deeply as
it is filled in, so one file builds all three levels:

```csv
diocese,zone,church,city
Diocese of Trichy,,,
Diocese of Trichy,Chalakudy Forane,,
Diocese of Trichy,Chalakudy Forane,St Mary Church,Chalakudy
Diocese of Trichy,,Sacred Heart Church,Trichy
```

Safe to run twice: anything already there is reported as skipped, so you can
correct the file and import it again. It creates no accounts — a hundred
parishes should not quietly become a hundred logins.

`data/seed/` holds starting points. **Verify them against your own directory
before trusting them**, and read the comment at the top of each:

| File | |
|---|---|
| `csi-dioceses.csv` | All 24 CSI dioceses. The one list here that is complete |
| `cni-dioceses.csv` | 26 CNI dioceses; there are around 27, so check for a missing one |
| `catholic-archdioceses-only.csv` | ~30 metropolitan sees out of roughly 174 jurisdictions — a skeleton, not a list of dioceses |
| `example-one-diocese.csv` | The shape a real import takes. Copy this one |

**No zone list is bundled, and none can be.** Foranes, deaneries and pastorates
are decided inside each diocese, number in the low thousands nationally, and
live in your diocesan directory rather than anywhere public. They are also the
level that changes — every few years, when a bishop reorganises. Put yours in
the `zone` column.

## Setting up a new church

From the console, **Churches → Add a church**. The church and the account that
will run it are created together, so it is usable the moment it exists, and its
administrator can then set its name, palette, page layout and member password
under its own Settings.

A church may be created before its zone is decided. It still belongs to a
diocese, and still appears in that diocese's reports.

---

## Backups

```bash
node bin/backup.js --out /somewhere/else --keep 14
```

The database is snapshotted with SQLite's `VACUUM INTO`, which is consistent
even while the app is running — copying a live database file is not. The
photographs are copied alongside it.

This matters more than it did. One file now holds every church, so a backup
belongs on a different machine, and `--keep` stops a nightly job filling the
disk.

---

## Layout of the code

```
bin/www              start-up: opens and migrates the database, then listens
bin/superadmin.js    create or recover the super administrator account
bin/backup.js        consistent snapshot of the database and photographs
bin/import-hierarchy.js  dioceses, zones and churches, from a CSV
bin/import-families.js   a parish's existing families, from its own sheet
app.js               middleware chain and route mounting
config/              .env loading, paths, session secret, database choice
db/
  sequelize.js       the connection; the engine is named here and nowhere else
  models.js          the shape of the data, and the associations
  migrations.js      schema history, tracked in `schema_version`
  index.js           start-up sequence and the two layers of default settings
models/
  church.js          diocese → zone → church, and the invariant between them
  family.js          families and members; every function takes a church
  pending.js         proposals: the diff, the queue, and applying an approval
  user.js            accounts; the only place that knows how to find one
lib/
  auth.js            roles, password hashing, route guards
  verification.js    the fields, the two tiers, and the status chain
  tenancy.js         which church a request is about
  audit.js           what the operator did, and to whom
  selection.js       "which churches?" for the cross-church reports
  settings.js        per-church settings over installation defaults
  slug.js            church web addresses
  upload.js          photographs, one folder per church
  csrf.js            per-session CSRF token
  daymonth.js        the two date types: parse, format, validate
  import-dates.js    reading a date out of somebody else's spreadsheet
  import-columns.js  the columns a family sheet may have, shared by the
                     importer and the template the parish downloads
  import-template.js the blank sheet, built from that list
  csv.js             reading and writing the sheets a parish actually has
  export.js          the columns, shared by every download, and the archive
  zip.js             writing a .zip straight down a response
  email.js           stricter than type=email, which passes "steve@gmail"
  relations.js       who is a parent, who is a child, and who is too old
  session-store.js   sessions in the same database
routes/              auth, dashboard, families, review, directory, admin,
                     super, reports
views/directory/     the printable directory; _entry.ejs is shared by both books
views/review/        the approval queue; _lines.ejs is shared by both screens
test/                smoke, console, tenancy, reports, verification, export,
                     import-template — run with `npm test`
```

### Changing the database engine

Every query in the application goes through Sequelize's model API, so the
engine is named in one place — `config.db` — and switching it does not mean
rewriting queries. Set `DATABASE_URL` to a `postgres://` or `mysql://` URL.

What does not travel for free is the schema history. Migrations 1 and 2 are the
SQLite SQL that shipped to a running parish and are kept verbatim, because
rewriting them risks giving new installations a subtly different schema from
existing ones. Migration 3 onward is written with `queryInterface` and standard
SQL. Pointing this at PostgreSQL therefore means writing one baseline migration
— an afternoon, once, not a rewrite.

### Schema changes

`db/migrations.js` holds a `MIGRATIONS` array applied in order and recorded in
`schema_version`. Never edit a migration that has shipped: append a new one, so
a directory already running an older copy upgrades cleanly. Opening a database
newer than the code is refused outright rather than half-working.

**Migration 3 rebuilds `families`,** because `family_id` was unique across the
whole table — right for one parish, wrong the moment two both number a family
`0001`. It counts families, members and users before and after and rolls back
if any number moves. That guard is there because the first version of it
deleted every member and reported success: `DROP TABLE` with foreign keys
enabled performs an implicit `DELETE FROM` first, and the pragma disabling them
had been set on a different pooled connection.

---

## Notes on security

- Every page except sign-in requires a session.
- **A church's data is reached only through its own church id**, put in the
  `WHERE` clause rather than checked after the row is fetched. `test/tenancy.js`
  is that promise, executed: two churches and thirty-odd attempts to cross
  between them.
- Photographs are served from `/uploads/<churchId>/…` behind a check that the
  church is yours, and stored in a folder per church.
- A church administrator cannot create a super administrator; the role is not
  offered and the route refuses it.
- All state-changing forms carry a per-session CSRF token.
- Sign-in failures are throttled per IP and username.
- Photo uploads are restricted by MIME type and size, and stored under a random
  filename.
- `SESSION_SECRET` is required in production; the app refuses to start without
  it rather than silently generating a throwaway one.

Set `TRUST_PROXY=1` and serve over HTTPS when deploying behind nginx, Caddy or
a PaaS, so the session cookie is sent with `Secure`.

---

## The original template

`public/parish-directory-template.html` is the standalone layout this was built
from. It is kept as the visual reference — `public/stylesheets/directory.css`
and `views/directory/_entry.ejs` reproduce it exactly. It is not used at runtime.
