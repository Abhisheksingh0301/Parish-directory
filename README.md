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
verification, export, import-template, import-upload and import-photos — each
booting the app over HTTP
against a throwaway database in your system temp folder. They override
`DATA_DIR`, so your own `data/` folder is left alone. The last line should read
`ALL CHECKS PASSED`. Run one suite on its own with `npm run test:tenancy`, and
the same for `test:smoke`, `test:console`, `test:reports`,
`test:verification`, `test:export`, `test:import-template`, `test:import-upload`
and `test:import-photos`.

### Every command

| Command | |
|---|---|
| `npm start` | Run the app |
| `npm run dev` | Run it, restarting on file changes |
| `npm test` | All 259 checks |
| `npm run superadmin` | Create, reset or list super administrators |
| `npm run backup` | Snapshot the database and photographs |
| `npm run import-hierarchy -- --file <x.csv>` | Load dioceses, zones and churches from a CSV. Without `-- --file` it only prints its usage |
| `npm run import-families -- --church <slug> --file <x.csv>` | Load a parish's existing families from its own spreadsheet. Run it with `--dry-run` first. An administrator can also upload the sheet at **Manage → Import members** |

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
Import members, Import photographs, Download your data, Audit log), because
they are visited occasionally and nine flat links wrapped the bar onto a second
line, displacing the name and Sign out.

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

### The sheet the parish fills in and uploads — **Manage → Import members**

`/admin/import` is the whole exercise in one page. It offers the blank
spreadsheet as a download — **with example rows** or **headings only** — beside
the columns, the accepted alternative spellings for each, this church's own
relation codes and the date rules; and under that, the upload form the office
hands the filled-in sheet back through. Administrators only, one church at a
time.

The headings are generated from the importer's own column list
(`lib/import-columns.js`, shared with `bin/import-families.js`), so a heading
the template prints is a heading the import reads back; the two cannot drift.
They are also the export's headings, so a file downloaded from **Download your
data**, edited, can be handed straight back.

**The upload is all-or-nothing.** The file is read to the end and checked
against the database before a single row is written, and one problem anywhere
in it — an unreadable date, a family with no name, a Family ID this parish
already holds — stops the whole import and is reported on the page in plain
words with its row number. Nothing is written, so there is nothing to undo. A
run that says it imported is a run that imported the entire file.

That is deliberately stricter than the command line, which imports what it can
and writes the rest to a rejects file. The operator running the command has
that file, a shell and the ability to re-run; the administrator at the form has
none of the three, and "47 of your 60 families arrived" is not an outcome
anybody can act on from a web page.

The check is the import with the writing turned off — the same
`lib/import-families.js` code reaching the same tables, not a second
implementation that describes what the first would do and drifts away from it.
The file never touches the disk: it is held in memory, read once, and either
imported or reported on.

The command line remains for a sheet too broken to fix a row at a time, and the
page prints it for a super administrator only — a parish administrator has no
shell, so an instruction to use one reads as a job they have failed to do:

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

### The photographs — **Manage → Import photographs**

`/admin/photos` takes the other half of what a parish already has: a folder of
pictures, one per household. **Each file is named after the family's Family
ID** — `F-001.jpg` for family `F-001`, letter case ignored — and the folder is
zipped and uploaded once, instead of visiting two hundred family pages.

Both stored and deflated archives are read, which matters because "Send to →
Compressed (zipped) folder" and "Compress" both produce deflated ones.
`lib/unzip.js` is the reader, written out for the reason `lib/zip.js` and
`lib/csv.js` are: the format this needs is an index at the end of the file, a
header per entry, and inflate, which Node already ships. It reads by range
rather than slurping — peak memory is one photograph whether the archive holds
ten or a thousand — and it distrusts every number in the file, checking sizes
and CRCs and capping what inflate may produce.

**Every image is opened and checked before one of them is stored**, and any
problem anywhere refuses the whole archive, in plain words, naming the file:

- **The name matches a family in this parish.** A picture named for a family
  that is not here has nowhere to go, and skipping it silently is how a parish
  finds out at the printer that forty entries have no face.
- **One photograph per family.** `F-001.jpg` beside `F-001.png` is somebody's
  half-finished tidy-up; choosing between them would be a guess.
- **The bytes are what the name claims.** A PNG renamed to `.jpg` is reported
  as "a PNG image with a .jpg name", because browsers displaying it anyway have
  taught people that renaming converts.
- **It is landscape.** The same rule the single-photo form enforces, for the
  same reason: the printed frame is landscape, and the proof copy is not the
  place to discover a portrait picture.
- **It is within the size cap**, the same one a single upload has.

`Thumbs.db`, `.DS_Store` and `__MACOSX` are passed over without comment — the
parish did not create them and cannot see them, so asking them to delete a file
they cannot find would be worse than useless.

A family that already has a photograph gets the new one, the old file is
removed once the new one is safely stored, and every replacement is listed by
Family ID in the summary — so re-uploading a corrected folder is a normal thing
to do and never a silent one. **Nothing else about a family changes**: no entry
is published, unpublished or edited, and no logins are created.

The archive is the one upload that reaches the disk, because it is read by
seeking to the index at its end and can be hundreds of megabytes. It lands in
`data/tmp`, and it is deleted when the response ends — tied to the response
rather than to the route, because multer must run before the CSRF check (which
cannot read `_csrf` until the body it is inside has been parsed), so an expired
form is rejected *after* the file is on disk and the route never runs. Anything
a killed process left behind is swept at start-up.

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
The console has the spreadsheet and the full archive under Reports too, for any
selection of churches.

- **Spreadsheet only** (`.csv`) — one row per person, the family's details
  repeated on each of their rows. That is the shape that sorts and filters in
  Excel; one row per family cannot hold the members at all.
- **Spreadsheet and photographs** (`.zip`) — the same sheet, plus every
  photograph, each named after the family it belongs to. The sheet's last
  column gives that name, so a row and a face can be matched without opening
  the application. A `README.txt` in the archive says the same thing to
  whoever receives it.
- **Photographs only** (`.zip`) — the pictures with nothing else, each file
  named for its **Family ID alone**: `F-001.jpg`.

That last naming is deliberately not the bundle's `F-001-kandathil.jpg`, and
the two must not be tidied into one. The bundle sits beside a spreadsheet and a
person matching faces to rows by eye, so the head of family in the name earns
its place. The photographs-only archive is the one **Import photographs** reads
back — the parish downloads the folder, replaces the half-dozen pictures that
are wrong, and uploads the same folder again without renaming a file. A name
carrying the head of family would not survive that trip.

For the same reason there is no `README.txt` in the photographs-only archive:
it would come back on the next upload as a file that is not a photograph. The
button is disabled, with a sentence saying why, when no family has a
photograph yet.

The round trip is tested end to end — `test/import-photos.js` downloads the
archive and posts it straight back, unedited — so if the two namings are ever
merged, that check is the one that objects.

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
node bin/import-hierarchy.js --file data/seed/marthoma-parishes.csv
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

### What is bundled

`data/seed/` holds the Mar Thoma Syrian Church: **1,114 parishes and
congregations across 14 dioceses**, converted from the parish list published at
marthoma.in. **Verify it against your own diocesan directory before trusting
it**, and read the comment at the top of each file:

| File | Creates | |
|---|---|---|
| `marthoma-dioceses.csv` | 14 dioceses | The diocesan tier alone. Start here if you run one parish and just need somewhere to file it |
| `marthoma-parishes.csv` | 14 dioceses, 1,114 churches | Every parish, unzoned. **The one most people want** |
| `marthoma-parishes-with-country-zones.csv` | 14 dioceses, 32 zones, 1,114 churches | The same rows, with the country as the zone |

Pick one of the last two, not both — they hold the same parishes.

```bash
# look first: this writes nothing
node bin/import-hierarchy.js --file data/seed/marthoma-parishes.csv --dry-run

# then, for real
node bin/import-hierarchy.js --file data/seed/marthoma-parishes.csv
```

That takes a minute or so and prints what it made. Every church it creates is
still without an administrator — importing a list of parishes does not mint a
thousand logins. Add accounts from the console, for the parishes that are
actually going to use this, as they come on board.

**Two things about the data to know before you rely on it.**

*The zone column is empty in `marthoma-parishes.csv`, on purpose.* The published
list has no tier between the diocese and the parish, and inventing one would
fill your console with names nobody in the church would recognise. A church
with no zone is normal and fully supported here. If your diocese does use a
tier below itself, put your own names in the `zone` column, or add them later
from **Manage → Churches**.

*The city is derived, not published.* The spreadsheet has a postal address but
no city field, so the city is read out of the address — the post-office
locality for Indian parishes, the town for the 152 parishes abroad. It resolved
for 1,062 of the 1,114 rows; the remaining 52 are blank rather than guessed. A
post office is not always the place a parish is named after, so
`ANTHICHIRA ST JOHNS MAR THOMA CHURCH` lands in `Adoor` — correct, postally,
and still not what a local would say. Treat the column as a starting point.

The vicar, phone, email and website columns in the source spreadsheet are
**not** imported: a church here stores a name, a city and its place in the
hierarchy, and there is nowhere to put them.

### Re-importing, and using your own list

Safe to run twice: anything already there is reported as skipped, so you can
correct the file and import it again. Matching is on diocese plus church name,
so a **renamed** parish imports as a second church rather than updating the
first — rename it in the console instead.

To load a different denomination, write the same four columns. The seed files
are ordinary CSVs; copy one, empty it, and keep the header.

**No zone list is bundled for anyone, and none can be.** Foranes, deaneries and
pastorates are decided inside each diocese, number in the low thousands
nationally, and live in your diocesan directory rather than anywhere public.
They are also the level that changes — every few years, when a bishop
reorganises. Put yours in the `zone` column.

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
                         (the reading itself lives in lib/import-families.js,
                          shared with the upload form on /admin/import)
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
  import-families.js reading a sheet into families: the command line and the
                     upload form are one implementation
  import-upload.js   accepting the sheet and the photograph archive from the
                     browser: one in memory, one to scratch space it clears up
  import-photos.js   a folder of photographs named after their families
  unzip.js           reading a .zip, by range; the other half of zip.js
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

**Raise the proxy's upload limit to match the app's.** This one is not
optional, and it fails in a way that looks like an application bug:

```nginx
client_max_body_size 8m;    # nginx defaults to 1m
```

The app accepts photographs up to 5 MB (`MAX_PHOTO_MB`) and, when one is too
big, says so on the form beside the field. nginx caps request bodies at 1 MB
unless told otherwise, so without this line every photograph between 1 MB and
5 MB — which is most photographs taken on a phone — is refused by the proxy
with a bare **413 Request Entity Too Large** before the request reaches the
application at all. Nothing appears in the app's log, because nothing arrived.

It reads as intermittent, because it depends on the size of the photograph
somebody happened to attach. If you raise `MAX_PHOTO_MB`, raise this with it:
the proxy should never be the stricter of the two.

---

## Two printed layouts, one piece of markup

**Families per printed page** on the Settings page chooses between them, and it
defaults to **one**.

- **One family to a sheet** — the photograph across the top at 62% of the page
  width, with the details and the members beneath it. The head of family reads
  as the title of the page: name on the left, Family ID on the right in a quiet
  pill, one rule under both, rather than the two banded across the top.

  `_entry.ejs` writes the id before the name, which is the order the compact
  entry wants. Here the two are swapped with CSS `order` rather than by editing
  the markup — grid auto-placement follows it — because that markup is shared,
  and a second copy of it to reorder two elements is exactly the drift the
  sharing exists to prevent.
- **Two or more** — the original compact entry, with a smaller photograph
  beside the details rather than above them, so that several fit on a sheet.

`views/directory/_entry.ejs` is the same markup for both, and deliberately so:
it is shared by the single-church book and the combined one precisely to stop
the two drifting, and a second copy of it for a second layout would be the
drift. The routes put `page-single` on the page and the stylesheet does the
rest — the whole one-per-page layout is a block of CSS reached only through
that class.

### The photograph is sized as a proportion, not in pixels

The screen page and the printed sheet are not to the same scale. On screen a
page is 960px wide for what will be 210mm of paper; in print the padding drops
away and the content is 186mm — 703px at the 96dpi a browser prints at —
against 1032px of usable height. A photograph fixed in pixels is therefore a
different share of the two, and the size that looks right on screen runs the
printed sheet over by a hundred pixels, pushing the footer onto a second page.
`--single-photo` is a percentage for that reason, and the height budget it has
to live inside is written out above the rules in `directory.css`.

That budget has one deliberate limit: a family of about eight members fills the
sheet, and a larger one runs it long. Sizing the photograph for the largest
family in the parish would mean a small photograph on every other page.

---

## The original template

`public/parish-directory-template.html` is the standalone layout this was built
from. It is the visual reference for the **two-or-more** entry, which
`views/directory/_entry.ejs` and the unprefixed rules in
`public/stylesheets/directory.css` still reproduce exactly. It is not used at
runtime, and it does not describe the one-family-to-a-sheet layout, which
postdates it.
