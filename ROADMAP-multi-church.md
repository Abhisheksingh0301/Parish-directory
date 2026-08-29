# Roadmap — three user types across many churches

Today this app is **one install per church**: a single parish owns the whole
database, and `settings` holds that parish's name, palette and page layout as
plain global rows. The feature asked for — a super admin who adds churches,
church admins who manage their own, members who fill in their own entry — turns
that into **one install serving many churches**.

That reframing matters, because the roles are the small part. The work is
tenancy: giving every row an owner and making sure no query ever crosses the
line.

## What already exists

| Requested role | Status |
|---|---|
| **Super admin** — adds churches, views/prints everything | New. Rank 5, above `admin`, belongs to no church |
| **Admin** — adds members, views/prints their own church | The existing `admin` role, now scoped to one church |
| **Members** — fill in their family's details | **Already built.** `role = 'family'`, see `routes/families.js:32` `allowOwnFamily` |

The member role needs almost no new logic — only a relabel and a tenancy check.
Budget the effort accordingly: roughly 70% schema and query scoping, 20% the
super admin console, 10% roles and labels.

---

## Where this has got to

Updated as each phase lands. `npm test` is the gate: 128 end-to-end checks across
four suites — smoke (31), console (36), tenancy (35), reports (26) — and nothing
below is marked done until they pass.

**Every phase is complete.**

| Phase | State | Landed |
|---|---|---|
| 0 — Decisions | **Done** | All six settled, recorded below |
| 1 — Schema and migration 3 | **Done** | `db/migrations.js`, verified on a copy of the live database and on a fresh one |
| 1.8 — Super administrator CLI | **Done** | `bin/superadmin.js` — create, reset, list |
| — Data layer on Sequelize | **Done** | All 63 raw SQL sites moved behind `models/`; no SQL outside `db/` |
| 2 — Roles and tenancy | **Done** | `superadmin` rank 5, escalation hole closed and tested, `lib/tenancy.js` wired into `app.js` |
| 3 — Per-church settings | **Done** | `lib/settings.js` reads church_settings → settings → code defaults; isolation covered by tests |
| 4 — Super admin console | **Done** | `routes/super.js` + `views/super/`; dioceses, zones, churches, act-as, bulk move. 44 checks in `test/console.js` |
| 5 — Scope existing routes | **Done** | Every model function takes a church; `test/tenancy.js` proves one church cannot reach another |
| 5B — Selection, print, export | **Done** | `lib/selection.js`, `routes/super-reports.js`, combined book with per-church palettes, CSV with a BOM |
| 6 — Photograph isolation | **Done** | `uploads/<churchId>/`, a guarded route, and legacy files relocated at start-up |
| 7 — Member relabel, per-church default password | **Done** | `default_member_password` is a church setting, editable on its own Settings page |
| 8 — Tests, backups, README | **Done** | `bin/backup.js` with `VACUUM INTO` and `--keep`; README rewritten around many churches |

### How the settings layers came out

Three deep, not two: `church_settings` → `settings` → `DEFAULT_SETTINGS` in
code. The consequence worth knowing is that **a new church needs no rows of its
own to work**. It gets a printable directory and a working Settings page
immediately, and writing a row only records where it differs from the house
style — so changing a default later still reaches every church that never
overrode it.

`createChurch` writes exactly two rows: `parish_name` and `directory_title`.
Everything else is inherited.

The cache is a `Map` keyed by church id. `invalidate()` with no argument
clears all of them, which is what saving a platform setting has to do, since
every church merges that layer.

### What the console came out as

Routes in `routes/super.js`, views in `views/super/`. Worth knowing:

- **A church and its first administrator are created by one form, in one
  transaction.** A church nobody can sign in to is not a useful thing to be able
  to make, and the test asserts that a rejected creation leaves neither behind.
- **The zone list on a church is filtered to its diocese**, and the route
  re-checks it. Both the single edit and the bulk move refuse a mismatch, so the
  invariant does not depend on the form being the only way in.
- **Borrowing a church** sets `session.actingChurchId`. Every page then carries
  a bar naming the parish, because a super administrator is one click from
  editing the wrong directory — not a breach, they are allowed everywhere, but a
  quiet way to corrupt real records.
- **A page that needs a church remembers where you were going.** Being sent to
  the picker and then landing back on the page you asked for is the difference
  between a working console and an annoying one.
- **Nothing destructive cascades.** Dissolving a zone unzones its churches; a
  diocese holding churches refuses to be deleted; deactivating a church signs
  its people out but keeps every family, member and photograph.

### How the scoping came out

`churchId` is the **first argument of every function** in `models/family.js`,
and it goes into the WHERE clause. That is the whole difference: a church
administrator asking for another parish's family by guessing an id gets nothing
back, so the route sees a missing row and 404s. There is no permission check to
forget, because there is no permission check.

Three details worth keeping:

- **`scope()` refuses to build an unscoped query.** Passing a non-number throws
  rather than quietly returning every church, and an empty array of church ids
  becomes `IN (-1)` — no rows, never all rows. The dangerous default does not
  exist.
- **`wouldOrphanAdmins` counts within one church.** Unscoped, a parish could
  delete its last administrator because a different parish still had one.
- **`Users.findInChurch`** replaced `findById` in the four `/admin/users`
  routes. Each of those used to load an account by a bare integer.

The proof is `test/tenancy.js`: two churches, each with an administrator, a
family and a member login, and thirty attempts to cross the line. It also
covers the case the schema was rebuilt for — both churches numbering a family
`0001` and both keeping it.

### How selection, the book and the export came out

The prediction in §5B.3 held: **per-church palettes were almost free.** The five
colours are CSS custom properties, and custom properties inherit, so moving the
`style` attribute from `<body>` onto a per-church `<section>` gives every entry
inside it that parish's own scheme. The only stylesheet change was the section
wrapper and its page break.

To keep the single-church book and the combined one from drifting apart, the
family entry moved into `views/directory/_entry.ejs` and both include it. That
markup reproduces the approved template and is the thing a parish has already
signed off.

Two decisions the code now records:

- **Page numbers run continuously** across the whole document. A church's own
  `starting_page` applies only when it prints alone; in a combined book every
  section would restart at its own number and the folios would collide.
  `per_page` stays each church's own, because sections break anyway.
- **An empty selection returns nothing, never everything.** `scope()` turns an
  empty list into `IN (-1)`. A resolver that fell back to "all" when given
  nothing would hand a whole installation's addresses to whoever clicked a
  stale link, and would look like it was working. There is a test for exactly
  that.

The export writes a UTF-8 byte order mark before anything else, because Excel
assumes the system codepage without one and mangles every non-ASCII name — in
an Indian parish directory, most of them.

### Loading the hierarchy

`bin/import-hierarchy.js` takes a four-column CSV — diocese, zone, church,
city — and reads each row as deeply as it is filled in, so one file builds all
three levels. Idempotent, so a file can be corrected and re-imported, and it
creates no accounts: importing a hundred parishes should not quietly mint a
hundred logins.

`data/seed/` carries the Mar Thoma Syrian Church, which is the church this
installation actually serves: **1,114 parishes and congregations in 14
dioceses**, converted from the list published at marthoma.in. It replaced the
earlier bundle of CSI, CNI and Catholic diocesan skeletons — those were
partial lists of denominations nobody here was importing, and a partial list
invites more correcting than typing.

- **`marthoma-dioceses.csv`** — the 14 diocese names alone, for an install
  running one parish that only needs somewhere to file it.
- **`marthoma-parishes.csv`** — every parish, unzoned. The usual choice.
- **`marthoma-parishes-with-country-zones.csv`** — the same rows with the
  country as the zone. Not invented structure: every diocese really does span
  more than one country, because the Gulf congregations are attached to Kerala
  dioceses rather than to a diocese of their own.

The source spreadsheet has an address but no city column, so the city is read
out of the address and lands for 1,062 of the 1,114 rows. The other 52 are left
blank. Its vicar, phone and website columns are dropped: a church row here is a
name, a city and a place in the hierarchy, and there is nowhere to put them.

**No zone list is bundled, and none can be.** Foranes, deaneries and pastorates
are decided inside each diocese, number in the low thousands nationally, and
exist in diocesan directories rather than anywhere public. Guessing them would
have been fiction dressed as data.

### The last three phases

**Photographs** moved to `uploads/<churchId>/`. The database stores only the
filename, so which folder it lives in follows from the family's church and no
row changed. `/uploads` was a bare static mount handing every image to any
signed-in user; it is now a route that checks the church in the path. Anything
still loose in the flat folder is filed at start-up, once.

The first version of that route did not work at all, and not visibly: the path
was written `'/uploads/:churchId(d+)'` in a single-quoted string, where
`d` is just `d`. It matched `/uploads/d/` and nothing else, so every
photograph 404'd — including the ones that should have been served. The test
that was meant to prove refusal would have passed on a 404 alone, which is why
it also asserts the *own-church* fetch succeeds.

**The member password** is now `default_member_password` in `church_settings`,
editable on each church's Settings page. It was one environment variable shared
by the whole installation, displayed in full on two screens — so every church's
staff could read the string that opened every other church's new accounts.

**Backups** are `bin/backup.js`: `VACUUM INTO` for a snapshot that is
consistent while the app runs, the photographs copied alongside, and `--keep`
so a nightly job does not fill the disk.

### Not in the original plan, added on the way

- **The data layer moved to Sequelize.** Asked for mid-build so the database
  engine can change without rewriting queries. Application code is now
  engine-agnostic; migrations 1–2 stay SQLite SQL, and the reason is at the
  top of `db/migrations.js`.
- **`test/smoke.js`.** The conversion needed something better than "it still
  parses". It boots the app on a throwaway directory and drives it over HTTP.
- **A row-loss guard in migration 3.** Earned: see below.

### The bug worth remembering

The first run of migration 3 deleted every member and the household login,
and reported success. `DROP TABLE` with foreign keys enabled performs an
implicit `DELETE FROM` first, which cascades. The `PRAGMA foreign_keys = OFF`
guarding against that was set on the wrong connection: `sequelize.transaction()`
takes a fresh one from the pool, and the SQLite driver re-enables the pragma
on every connection it opens.

Fixed by issuing BEGIN and COMMIT by hand for SQLite, so the whole migration
stays on the one connection where the pragma holds. Migration 3 now also
counts families, members and users before and after, and rolls back if any
number moves — nothing in it is meant to remove a row.

---
## The size this has to work at

**Up to 200 churches**, across several dioceses and their zones. At roughly 200
families each that is ~40,000 families and ~160,000 members — and perhaps a
handful of dioceses holding a few dozen zones between them.

SQLite is the right choice at that size and needs no replacing — it is a
read-heavy app with short write bursts during a directory drive, and WAL is
already on (`db/index.js:226`). The number does change four specific things,
each noted in the phase it belongs to: the super admin's aggregate queries
(4), finding a church among 200 (4), photographs in one flat directory (6),
and the backup story (8).

The one query that would not have survived is `Family.upcoming`
(`models/family.js:234`) — it reads every member and every family with a date
into memory and filters in JavaScript. That is 800 rows for one parish and
160,000 unscoped. Phase 5 scopes it per church, which puts it back to 800.
Worth knowing it was the weak point, in case a later screen is tempted to call
it unscoped.

## Phase 0 — Decisions to make first

These change the shape of everything after them.

### 0.1 One database, or one database per church? — **Recommend: one**

Per-church databases would keep the existing code almost untouched, but the
super admin's "view/print everything" then means opening N connections and
merging in memory, and there is nowhere to put a cross-church query. One
database with a `church_id` column is more upfront work and is the right shape
for what was asked.

### 0.2 Are usernames globally unique, or unique per church? — **Recommend: globally**

`users.username` is `UNIQUE COLLATE NOCASE` today. Family logins use the
household's email address as the username (`routes/families.js:196`). Keeping
it global means the sign-in form stays one username and one password with no
church picker — the right call. The cost: if the same email belongs to
households in two churches, the second one is skipped. `createLogins` already
reports that case in its `skipped` list; make the message say which church holds
it.

### 0.3 Do photographs need to be physically separated per church? — **Recommend: yes, Phase 6**

Filenames are random 16-hex (`lib/upload.js:24`), so guessing one is not
realistic. But `app.js:93` serves `/uploads` to *any* signed-in user, and once
churches are unrelated organisations "not realistically guessable" is a weaker
promise than "checked". Small phase, do it — just not first.

### 0.4 What does a super admin's "print everything" mean? — **Settled**

Not "one church" and not "all churches". The super admin picks **any set of
churches, or one or more zones**, and gets that selection as a view, a printed
book or an export. This is core, not optional — it is Phase 5B.

The unifying idea that keeps it from becoming three features: **every selection
resolves to a list of church ids.** A zone is a shortcut that expands to the
churches inside it; "all" is a shortcut for every active church. View, print and
export then share one resolver and one query path.

```
?churches=1,5,9   ?zones=3,4   ?all=1   →   [1, 5, 9, …]
```

### 0.5 What is a zone, exactly? — **Confirmed**

**Two levels above the church: diocese → zone → church.** The install serves
several dioceses, each divided into zones, each zone holding parishes.

```
dioceses
  └── zones          (zones.diocese_id)
        └── churches (churches.zone_id, churches.diocese_id)
              └── families
                    └── members
```

Worth stating because the word is ambiguous in Indian church usage. "Zone" also
commonly means a *ward or family unit inside a single congregation* — Kerala
Catholic parishes call those `kudumbakoottayma`, and Pentecostal churches
usually do say "zone" for them. That meaning would put the column on `families`,
not on `churches`, and would be a different feature entirely. It is **not** what
is being built here. If intra-parish wards are wanted later they are a separate,
independent table, and the two must not be merged.

**Grouping, not administration.** A zone is an attribute of a church used for
selecting and reporting. It is *not* a tenancy boundary — ownership of a family
stays `church_id`, exactly as in Phase 1.

This distinction is what keeps the hierarchy cheap even at two levels. Phases
1–3 and 5 are untouched by it; dioceses and zones add two tables, two columns,
some console UI and the selection layer, and nothing else has to know they
exist. **A family is owned by a church and only by a church** — everything above
that is grouping.

If a **zone administrator** — someone who oversees their zone's churches but not
the whole system — is wanted later, `churches.zone_id` is already the join that
makes it a rank-4.5 role and a scope helper. Not building it now, because you
specified three roles. Just leaving the door on its hinges.

### 0.6 Both level names are configurable — **Confirmed**

Indian denominations each have their own term for both tiers:

| Body | Upper tier | Level above a parish |
|---|---|---|
| Syro-Malabar / Syro-Malankara Catholic | **Eparchy** / Archeparchy | **Forane** |
| Latin Catholic | **Diocese** / Archdiocese | **Deanery** (*vicariate forane*) |
| CSI / CNI | **Diocese** | **Pastorate** |
| Mar Thoma / Malankara Orthodox | **Diocese** | Parish grouping varies |
| IPC | **Region** | **Centre** |
| Many independent churches | **Region** | **Zone** |

So two platform settings — `diocese_label` (default `Diocese`) and `zone_label`
(default `Zone`) — as rows in the global `settings` table, not
`church_settings`, since a deployment serves one denomination's structure. Every
screen naming either concept reads them: the console, the selection form, export
column headers, printed section titles.

Cheap now, tedious to retrofit once a dozen views have the words baked in. Table
and column names stay `dioceses` / `zones` / `diocese_id` / `zone_id`
regardless — these are display labels, not schema renames.

---

## Phase 1 — Schema and tenancy

**Files:** `db/index.js`, new `models/church.js`

Append **migration 3**. Never edit migrations 1 and 2 — they have shipped
(`db/index.js:63-73` says so, and the rule is right).

### 1.1 The dioceses, zones and churches tables

```sql
CREATE TABLE dioceses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE zones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  diocese_id INTEGER NOT NULL REFERENCES dioceses(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Two dioceses may each have a "St Thomas" zone; one diocese may not.
  UNIQUE (diocese_id, name COLLATE NOCASE)
);

CREATE TABLE churches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  diocese_id INTEGER NOT NULL REFERENCES dioceses(id),
  zone_id    INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  city       TEXT NOT NULL DEFAULT '',
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_zones_diocese    ON zones(diocese_id, name COLLATE NOCASE);
CREATE INDEX idx_churches_diocese ON churches(diocese_id, name COLLATE NOCASE);
CREATE INDEX idx_churches_zone    ON churches(zone_id, name COLLATE NOCASE);
```

`is_active` rather than deleting: a deactivated church signs its people out and
disappears from the lists, but its families and photographs survive a mistake.

Seed `diocese_label` and `zone_label` into the global `settings` table in the
same migration — `DEFAULT_SETTINGS` at `db/index.js:177` gains two entries, and
an install that says "Eparchy" and "Forane" changes both in one place.

### Four deliberate choices about the hierarchy

**`churches.diocese_id` is stored, not derived through the zone.** The obvious
design is diocese-via-zone only, and it breaks on the first church that has no
zone yet — it would belong to no diocese either. Storing it also turns
"every church in this diocese" into one indexed predicate rather than a join
through `zones`, which matters for the selection resolver in Phase 5B.

The cost is a denormalisation that can disagree with itself: a church could
point at diocese A while its zone belongs to diocese B. Enforce the rule in the
one place that sets it — **when assigning a zone to a church, the zone must
belong to that church's diocese** — and offer only that diocese's zones in the
form. A `CHECK` constraint cannot express this in SQLite, so it is an
application-layer invariant and belongs in `models/church.js` with a comment
saying why.

**Zone is nullable, diocese is not.** A parish always has a diocese; its zone
may not be decided yet, or may be being reorganised. An unzoned church still
appears under "all" and under its diocese, and is invisible only to a
zone-based pick — which is correct.

**`ON DELETE SET NULL` on the zone, nothing on the diocese.** Deleting a zone
must never cascade into deleting parishes; its churches simply become unzoned.
A diocese with churches should refuse to delete outright — deactivate it
instead. This is why `dioceses` gets `is_active` too.

**Zone names are unique per diocese, not globally.** Two dioceses may each have
a "St Thomas" zone. Church slugs stay globally unique because they are URL
identifiers.

### 1.2 Rebuild `families`

`families.family_id` is `UNIQUE` globally (`db/index.js:79`). It must become
unique *within a church* — two parishes both numbering from `0001` is the normal
case, not an error. SQLite cannot alter a constraint in place, so this is the
standard rebuild: create `families_new` with `church_id INTEGER NOT NULL
REFERENCES churches(id)` and `UNIQUE (church_id, family_id)`, copy every row
with `church_id = 1`, drop, rename, recreate `idx_families_head`.

Also add `CREATE INDEX idx_families_church ON families(church_id, family_id)` —
every list query will filter on it.

`members` needs no change; it reaches its church through `family_id`.

### 1.3 Add `church_id` to `users`

Plain `ALTER TABLE users ADD COLUMN church_id INTEGER REFERENCES churches(id)`.
Deliberately **nullable**: `NULL` means a super admin, who belongs to no church.
Enforce "every non-super-admin has a church" in the application layer, since
SQLite cannot express a conditional NOT NULL on an added column.

### 1.4 Per-church settings

`settings` is `PRIMARY KEY (key)` with a process-wide cache. Rather than rebuild
it, add a second table and leave the original as platform-wide defaults:

```sql
CREATE TABLE church_settings (
  church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (church_id, key)
);
```

Lookup order becomes: `church_settings` → `settings` → `DEFAULT_SETTINGS`. No
risky rebuild, and a genuine platform-level default gets somewhere to live.

### 1.5 Backfill the existing parish

In the same migration:

0. Insert diocese 1, named from `DIOCESE_NAME` in `.env` or a placeholder the
   super admin renames on first sign-in. No zone is invented — one unzoned
   church in one diocese is an honest representation of what the data actually
   says, and guessing a zone name would be fiction.
1. Insert church 1 from the current `settings.parish_name`, with
   `diocese_id = 1` and `zone_id = NULL`.
2. `UPDATE families SET church_id = 1` (handled by the rebuild copy).
3. `UPDATE users SET church_id = 1` — everyone currently in the database belongs
   to the church that database was for.
4. Copy the parish-scoped keys (`parish_name`, `directory_title`,
   `starting_page`, `per_page`, `relation_options`, the five `color_*`) into
   `church_settings` for church 1.

An install that upgrades keeps working, with its parish as church 1 and its
administrator as that church's admin.

### 1.6 Creating the first super admin

`routes/auth.js:56` currently opens `/setup` to anyone whenever `countUsers()`
is 0. Do **not** loosen that to "whenever no super admin exists" — on an
upgraded install with users already present, that would leave an unauthenticated
route that mints the most privileged account in the system.

Split it:

- **Fresh install** (`countUsers() === 0`) — `/setup` creates the super admin,
  unchanged flow, new role.
- **Upgrade** — a CLI script, `npm run create-superadmin`, run by whoever has
  shell access. Add it under `bin/`.

---

## Phase 2 — The auth and tenancy layer

**Files:** `lib/auth.js`, new `lib/tenancy.js`, `app.js`

### 2.1 The new role

Add to `ROLES` in `lib/auth.js:17`:

```js
superadmin: {
  rank: 5,
  label: 'Super administrator',
  blurb: 'Adds churches and reaches every church in the system.',
  global: true
}
```

Rank 5 means `atLeast(user, 'admin')` already passes for a super admin, so every
existing guard keeps working. Two follow-ups:

- `STAFF_ROLE_LIST` (`lib/auth.js:44`) filters out `familyLogin` roles. It also
  has to filter out `global: true`, or a church admin could create a super admin
  from `/admin/users`. **This is the privilege-escalation hole to close first.**
- Relabel `family` to **"Member"** in `ROLES` — the word you used. Change the
  `label` and `blurb` only; leave the stored value `'family'` alone so no data
  migration is needed.

### 2.2 Church context — `lib/tenancy.js`

The one new idea in this whole change. A super admin has no church of their own,
so they need to be *acting as* one to use the ordinary screens.

```
resolveChurch(req, res, next)
  - member / editor / viewer / admin → req.churchId = req.user.church_id
  - superadmin                       → req.churchId = req.session.actingChurchId ?? null
  - loads the church row onto req.church and res.locals.church

requireChurch(req, res, next)
  - 403 unless req.churchId is set; for a super admin, redirect to /super/churches
    to pick one instead

requireSuperAdmin(req, res, next)
```

Mount `resolveChurch` in `app.js` right after `auth.loadUser` (`app.js:54`) and
before `settings.middleware`, which now depends on it.

Also refuse a sign-in to a deactivated church — a check in `loadUser` alongside
the existing `!user.is_active` test at `lib/auth.js:100`.

### 2.3 Scope in SQL, never after the fact

The rule that keeps this safe: **`church_id` goes in the `WHERE` clause, not in
an `if` after the row comes back.** A church A admin asking for church B's
family gets a 404 from the query itself, not a 403 from a check somebody might
forget to add to the next route.

Concretely, `models/family.js` gets `churchId` as the first argument of every
exported function — `list`, `emails`, `withoutLogins`, `listWithMembers`,
`findById`, `familyIdTaken`, `nextFamilyId`, `create`, `remove`, `stats`,
`upcoming`. Eleven signatures. `update` reaches its family by primary key, so it
is safe once `findById` is, but pass it anyway for consistency.

---

## Phase 3 — Per-church settings

**File:** `lib/settings.js`

The module holds one process-wide `cache` object (`lib/settings.js:12`). It
becomes a `Map` keyed by church id:

- `load(churchId)` — merge `DEFAULT_SETTINGS` ← `settings` ← `church_settings`
- `save(churchId, updates)` — writes to `church_settings`
- `invalidate(churchId)` — one church, or all when called bare
- `middleware` — uses `req.churchId`; when it is null (a super admin who has not
  picked a church) fall back to platform defaults so the header still renders

Every view reads `settings.parish_name` and `settings.directory_title`
(`views/partials/header.ejs:5`, `:13-14`). Once this phase lands they show the
acting church, which is exactly what a super admin needs to see.

---

## Phase 4 — The super admin console

**Files:** new `routes/super.js`, new `views/super/*`, `app.js`

Mounted at `/super` behind `requireSuperAdmin`.

| Route | Does |
|---|---|
| `GET /super` | Overview: churches, families and members per church |
| `GET /super/churches` | Every church, with counts and active state |
| `POST /super/churches` | **Add a church — and its first admin account in the same transaction** |
| `GET /super/churches/:id` | One church: stats, its admins, its families |
| `POST /super/churches/:id/active` | Deactivate/reactivate; deactivating clears that church's sessions |
| `POST /super/churches/:id/act` | Set `session.actingChurchId`, redirect to `/` |
| `POST /super/stop-acting` | Clear it |
| `GET /super/directory/:id` | That church's printable directory |
| `GET /super/dioceses` | Dioceses, each with its zone and church counts |
| `POST /super/dioceses` | Add a diocese |
| `POST /super/dioceses/:id` | Rename |
| `POST /super/dioceses/:id/active` | Deactivate; refuse deletion while it holds churches |
| `GET /super/zones` | Zones grouped by diocese, each with its church count |
| `POST /super/zones` | Add a zone to a diocese |
| `POST /super/zones/:id` | Rename; reassigning a church's zone is done on the church |
| `POST /super/zones/:id/delete` | Delete; its churches fall back to unzoned, never cascade |

The church form must pick a diocese **first**, then filter the zone list to that
diocese — this is the UI half of the invariant in Phase 1. Do it by reloading
the form on diocese change rather than shipping the whole zone table to the
browser; the app is server-rendered throughout and there is no reason to break
that here.

**Two things 200 churches force here.**

*Aggregate in SQL, once.* The overview must be a single `GROUP BY church_id`
query, not `Family.stats()` called 200 times — `models/family.js:220` runs three
subqueries per call, so the loop is 600 queries for one page. Same for the
church list and its per-church counts.

*Make a church findable.* A 200-row list and a 200-option dropdown are both
unusable. `/super/churches` needs a name/city search box, and the "act as"
control needs to be a search rather than a `<select>`. Reuse the `?q=` pattern
already in `routes/families.js:157`.

The create-a-church form is the centre of this phase. A church with no admin is
useless, so one form takes the church's name and city plus the first admin's
username and password, and writes both inside `db.tx`. Seed that church's
`church_settings` from `DEFAULT_SETTINGS` at the same time so the admin lands on
a working Settings page.

In `views/partials/header.ejs`, when a super admin is acting as a church, show a
persistent bar naming it with a "stop acting" button — the same shape as the
existing default-password banner (`:42-52`). Being one click from editing the
wrong parish's data is the failure mode worth designing against.

---

## Phase 5 — Scope every existing route

Mechanical, and the phase where a missed line becomes a data leak. Work through
it as a checklist.

### `routes/families.js`
- Every `Family.*` call takes `req.churchId`
- `familyLoginsGoHome` (`:22`) unchanged — a member's own entry is already the tightest scope
- `createLogins` (`:190`) inserts `church_id` on the new user; skip message names the owning church on a username clash
- `POST /logins` (`:218`) only invites the acting church's families
- `nextFamilyId` (`models/family.js:148`) counts within the church, so each parish numbers from `0001`

### `routes/admin.js`
- `listUsers` (`:98`) — `WHERE u.church_id = ?`
- `POST /users` (`:126`) — stamp `church_id`; reject `global: true` roles
- `/users/:id/role`, `/active`, `/password`, `/delete` (`:172`–`:258`) — **each loads the target by id alone today.** Every one needs `AND church_id = ?`, or a church A admin can reset a church B admin's password by guessing an integer. Four routes, four one-line fixes, all four required.
- `wouldOrphanAdmins` (`:164`) — scope the count to the church, otherwise church A's last admin can be removed because church B still has one
- Settings routes (`:20`, `:30`, `:86`) — `settings.load/save(req.churchId)`

### `routes/directory.js`
- `listWithMembers` scoped; a super admin acting as a church gets that church

### `routes/index.js`
- `Family.stats` and `Family.upcoming` scoped
- A super admin who is not acting as a church goes to `/super`, mirroring how a
  member goes to their own entry (`:12`)

### `views/partials/header.ejs`
- A **Churches** link for super admins
- The acting-church bar from Phase 4

---

## Phase 5B — Selection, multi-church print, export

**Files:** new `lib/selection.js`, new `routes/super-reports.js`, new
`views/super/select.ejs`, `views/directory/print.ejs`,
`public/stylesheets/directory.css`, `models/family.js`

The super admin picks churches or zones and gets a view, a book or a
spreadsheet. One selection layer feeding three outputs.

### 5B.1 The resolver

`lib/selection.js` turns query parameters into a validated list of church ids:

```
resolve(query) → { churchIds, label }
  ?churches=1,5,9   the ids given
  ?zones=3,4        every church in those zones
  ?dioceses=2       every church in those dioceses, zoned or not
  ?all=1            every active church
```

Because `churches.diocese_id` is stored (Phase 1), a diocese selection is one
indexed `WHERE diocese_id IN (…)` — no join through `zones`, and unzoned
churches are included automatically, which is the whole reason that column
exists.

The forms combine: `?dioceses=2&churches=17` means that diocese plus one extra
parish. Union the results and de-duplicate.

`label` is the human description that prints on the cover and names the
download — "Trichy Zone", "3 churches", "All churches". Ignore ids that do not
exist rather than erroring; a stale bookmark should degrade, not 500.

### 5B.2 Models take a list, not one id

Phase 5 gives every `models/family.js` function a `churchId`. Here the reporting
ones — `listWithMembers`, `stats`, `list` — take `churchIds` as an array and use
`WHERE f.church_id IN (…)`. Keep the single-church signature working by wrapping
it, so nothing from Phase 5 has to be rewritten.

`listWithMembers` already builds an `IN` clause for members
(`models/family.js:117`); the same placeholder-generating pattern extends
straight to churches. Note SQLite's default limit of 999 bound parameters — 200
churches is well inside it, but the member `IN` on a large selection is not, so
that query should batch or join instead.

### 5B.3 Per-church palettes are almost free

The best news in this phase. The palette is applied as CSS custom properties on
one element — `views/directory/print.ejs:18`:

```html
<body class="directory directory-body" style="--band: …; --rule: …">
```

Custom properties inherit and can be re-declared on any descendant. So a
combined book does not need a compromise palette or a rewrite of
`directory.css`: move that `style` attribute off `<body>` and onto a
per-church wrapper.

```html
<section class="church-section" style="--band: …; --rule: …">
```

Every entry inside then draws in its own parish's colours, and each church's
section of the book looks exactly like the book that church prints for itself.
No stylesheet changes beyond a class for the wrapper and its page break.

### 5B.4 What else the combined document needs

- **Sections start on a new page.** `page-break-before: always` on
  `.church-section`, and a section title page or header naming the church, its
  city and its zone.
- **Page numbering runs continuously** across the whole document. A church's own
  `starting_page` applies only when that church is printed alone — in a
  combined book it is ignored, or the folios collide.
- **The page footer must follow the section.** `print.ejs:129` prints
  `settings.parish_name` from one global settings object; in a combined document
  each page carries its own church's name, so the page objects built in
  `routes/directory.js:29-32` gain a `churchName` and the pagination loop runs
  per church rather than once over a flat list.
- **`per_page` stays per church** — since sections break anyway, each church can
  keep its own families-per-page.

### 5B.5 Export

There is no export anywhere in the app today; this is new.

**Shape: one row per member**, denormalised with its family and church columns
repeated. It is the shape that pivots in Excel, which is what a spreadsheet is
for. A family-per-row export cannot represent members at all without numbered
columns.

```
diocese, zone, church, family_id, head_name, address, hometown,
home_parish, spouse_home, email, dom, member_name, relation, dob,
mobile, links
```

The first three columns are what make the file pivot usefully — diocese and
zone are why somebody exports rather than printing. Header text comes from
`diocese_label` and `zone_label`, so a Syro-Malabar export says
`Eparchy, Forane, Church`. An unzoned church exports an empty zone cell, not
the word "None".

Three practical points:

- **Write a UTF-8 BOM first.** Excel assumes the system codepage for a BOM-less
  CSV and mangles every non-ASCII name — which, in an Indian parish directory,
  is most of them. Three bytes, and the difference between a usable file and a
  support call.
- **Stream the response.** A whole-system export is ~160,000 rows; build it row
  by row into the response rather than assembling one string in memory.
- **`Content-Disposition` with the selection label and the date**, so a folder
  of these files is still legible in a month.

Offer the same selection as a screen view too — a plain searchable table of the
chosen churches' families, which is what "view everything" usually means in
practice.

## Phase 6 — Photograph isolation

**Files:** `lib/upload.js`, `app.js`

Store under `uploads/<churchId>/` — `destination` at `lib/upload.js:17` reads
`req.churchId`, and `removePhoto` takes the church id so its path-traversal
guard (`:61`) still resolves correctly.

At 200 churches this stops being only about isolation. A flat directory would
hold ~40,000 photographs, and directory enumeration on NTFS gets slow well
before that — backups, antivirus scans and any `readdir` all pay for it. The
per-church split turns it into 200 folders of ~200 files, which is a size every
tool is happy with. Two reasons for the same small change.

Replace the bare static mount at `app.js:93` with a handler that compares the
church id in the path against `req.churchId`, letting a super admin through.

Legacy files sit flat in `uploads/`. Move them into `uploads/1/` in the same
migration that creates church 1, or keep a fallback read path for a release.
Moving them is cleaner; do it while there is only one church's worth.

---

## Phase 7 — Members

Mostly relabelling, because the behaviour is already there.

- `role = 'family'` keeps its stored value; UI says **Member**
- Its tenancy is inherited through `family_id`, but `loadUser` should still
  confirm the member's church is active
- Consider a per-church `DEFAULT_USER_PASSWORD`. It is one global env var today
  (`config/index.js:67`) and shown in full on two screens
  (`views/families/list.ejs`, `views/admin/users.ejs`) — meaning every church's
  staff sees the string that opens every other church's new member accounts.
  A `default_member_password` row in `church_settings` fixes it. **Do this**;
  it is small and the current shape is genuinely wrong once churches are
  strangers to each other.

---

## Phase 8 — Hardening, and the optional extras

### Cross-tenant tests — the one thing worth adding

`package.json` has no test script. Do not build a full suite; build one file
that signs in as church A's admin and asserts a 404 or 403 on each of:

- `GET /families/:id` for a church B family
- `POST /families/:id` and `/delete` for a church B family
- `POST /admin/users/:id/password` for a church B admin
- `GET /directory` — contains no church B name
- `GET /super/churches`
- `POST /admin/users` with `role=superadmin`

That list is the security model. If it passes, tenancy holds; if a future change
breaks it, you find out then rather than from a parish.

### Backups stop being a copy-and-paste job

The README's advice — *"Backing up a parish is copying that folder"* — was true
when the folder was one parish. At 200 churches it is one file that all of them
depend on, and copying it while the app is running can capture a torn WAL.

Replace it with a scheduled `VACUUM INTO` (SQLite's own consistent snapshot,
safe against a live database) plus the uploads tree, kept off the machine that
serves the app. This is small, it is not optional, and it is the difference
between one bad disk and 200 parishes rebuilding their directories by hand.

### Also in this phase
- Deactivating a church clears its sessions, the way deactivating a user does (`routes/admin.js:215`)
- Bump the "database is newer than the code" guard — it already handles this correctly (`db/index.js:197`)
- Rewrite the README: it opens with "one install per church", which stops being true here
- Add a cross-tenant test for the selection layer: a church admin must not be
  able to reach `/super/reports?churches=…` at all, and the resolver must never
  be callable with a church the requester does not own
- **Optional:** a super admin audit log — who created which church, who acted as whom
- **Optional:** zone administrators (decision 0.5)

---

## Deliberately not in scope

### Email, and therefore self-service password reset — deferred

There is no email sending anywhere in this app and none is being added here.
`lib/email.js` validates an address; it does not send to one. There is no
password-reset route in `routes/auth.js`.

This is workable at 200 churches because the reset chain is already built and
needs no email at any step:

| Who forgets | Who fixes it | How |
|---|---|---|
| A member | Their church admin | `POST /families/:id/login` (`routes/families.js:315`) already puts a login back to the default password |
| A church admin | The super admin | Act as that church, then `POST /admin/users/:id/password` |
| The super admin | Themselves, with shell access | The Phase 1.6 CLI script |

Two consequences to accept knowingly. Every reset is a phone call or a message
to a human, so at 200 churches this is a real trickle of support work landing
on whoever holds the super admin account. And the Phase 1.6 script should
therefore do two jobs, not one — create a super admin *and* reset an existing
one's password — because it is the only way back in if that account is locked
out.

When email does arrive it slots in cleanly: a `password_resets` table, a token,
and one route. Nothing in phases 1–8 has to be undone to make room for it.

## Order and rough size

| Phase | Size | Blocks | State |
|---|---|---|---|
| 0 — Decisions | — | everything | Done |
| 1 — Schema + migration 3 | L | 2–7 | Done |
| 2 — Roles + tenancy layer | M | 3–7 | Done |
| 3 — Per-church settings | M | 4, 5 | Done |
| 4 — Super admin console | L | 5 | Done |
| 5 — Scope existing routes | L | 8 | Done |
| 5B — Selection, multi-church print, export | M | — | Done |
| 6 — Photo isolation | S | — | Done |
| 7 — Member relabel + per-church default password | S | — | Done |
| 8 — Cross-tenant tests, docs | M | — | Done |

Phases 1–3 have no user-visible effect: at the end of them the app looks
identical and runs as a one-church install that happens to know it is church 1.
That is the right checkpoint to stop and verify before the console appears.

## The three failure modes to watch

1. **A missed `WHERE church_id`** — one parish sees another's addresses and
   telephone numbers. Phase 5's checklist and Phase 8's tests exist for this.
2. **`STAFF_ROLE_LIST` still offering `superadmin`** — any church admin becomes
   a super admin from a form the app already renders. One line, Phase 2.1.
3. **A super admin editing the wrong church** — not a breach, but it corrupts
   real data quietly. The acting-church bar in Phase 4 is the mitigation.
