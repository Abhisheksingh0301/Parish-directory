# Parish Directory

A printable family directory for a parish, with sign-in. The printed output is
a server-rendered version of the approved layout in
`public/parish-directory-template.html`, filled from a database instead of a
hand-edited array at the bottom of an HTML file.

Built to be reused: **one install per church**. Nothing about a particular
parish is in the code — the name, the printed palette, the page layout and the
relation codes are all settings an administrator edits in the browser.

---

## Running it

```bash
npm install
cp .env.example .env      # then edit it
npm start                 # http://localhost:3000
```

`npm run dev` restarts on file changes.

The first time you open the app it asks you to create the administrator
account and name the parish. There is no default password to change afterwards.

---

## Two shapes of date

**Date of marriage** is **day and month only** — `14 - Mar`. There is no year
field for it anywhere, in the form or in the printed book.

**Date of birth** is a **full date** — `02 - Aug - 1975` — but the year is
optional, so an entry can be filled in before anyone has asked the family for
it. A year that *is* given must be a real one: between 1900 and this year, and
29 February only in a leap year.

Both are stored as separate small integers (`dom_day` / `dom_month`,
`dob_day` / `dob_month` / `dob_year`) rather than a date string. Day and month
in their own columns keeps the birthday and anniversary list on the dashboard
sortable without caring about the year — and lets a date of marriage exist
without inventing a year nobody supplied. `dob_year` is nullable, so entries
recorded before the year was collected keep working.

In the printed entry the DOM cell is merged across the first two member rows,
matching the approved layout.

---

## Who can do what

| Role | Can do |
|---|---|
| **Administrator** | Everything, plus parish settings and user accounts |
| **Editor** | Add, edit and delete families |
| **Viewer** | Browse and print the directory; change nothing |
| **Family** | Complete and correct their own entry, and nothing else |

Accounts are created by an administrator under **Users**. Passwords are hashed
with bcrypt. Deactivating or deleting someone signs them out everywhere
immediately.

---

## Letting families complete their own entry

Collecting a parish directory by hand is the slow part. Any family with an
email address can be given a login instead, and fill in its own entry.

On **Families**, under *Invite families to complete their own entry*:

1. **Create family logins** — one account per family, the username being the
   family's own email address, all with the same default password.
2. **Copy all addresses** — every family email, comma separated, ready for the
   Bcc line of one message. Send them the address, the password and a request
   to check their entry.

A family login is not a directory account. It reaches exactly one family — its
own — and never the list, the dashboard or the printed book, so giving a
household a login does not hand it everybody else's address and telephone
number. Within its own entry it may change anything except the family ID and
whether the entry is printed, which stay with the parish office, and it cannot
delete the entry.

The default password lives in `.env`:

```
DEFAULT_USER_PASSWORD=Churchmembers@2026
```

It is shown in full on the Families and Users pages — it has to be, since the
office has to put it in the email. Anyone still using it sees a reminder on
every page until they choose their own under **My account**; the reminder can
be dismissed for the current visit but comes back at the next sign-in. An
administrator can see who is still on the default in the **Login** column of
the families list, and reset a single family back to it from that family's page.

---

## Setting up a new parish

Copy the project, then — without touching any code:

1. `cp .env.example .env`, set `SESSION_SECRET` and `PORT`.
2. Start the app and complete the first-run setup screen.
3. Go to **Settings** and set:
   - parish name (prints in the footer of every page) and directory title,
   - families per printed page and the starting page number,
   - the relation codes your parish uses (`HF, W, S, D, …`),
   - the five colours of the printed entry.
4. Add families, then open **Print directory** and use the browser's print
   dialog to send it to a printer or save it as a PDF.

Each install keeps everything it owns in one folder (`DATA_DIR`, `./data` by
default): the SQLite database and the uploaded photographs. Backing up a parish
is copying that folder.

---

## Layout of the code

```
bin/www              start-up: opens and migrates the database, then listens
app.js               middleware chain and route mounting
config/              .env loading, paths, session secret
db/index.js          SQLite connection, promise wrappers, migrations
models/family.js     families + members, always read and written together
lib/
  auth.js            roles, password hashing, route guards
  csrf.js            per-session CSRF token
  daymonth.js        the two date types: parse, format, validate
  session-store.js   sessions in the same SQLite file
  settings.js        the per-parish settings layer
  upload.js          photo uploads
routes/              auth, dashboard, families, directory, admin
views/directory/     the printable directory
public/stylesheets/  app.css (screens), directory.css (the printed book)
```

### Schema changes

`db/index.js` holds a `MIGRATIONS` array applied in order and tracked with
`PRAGMA user_version`. Migration 1 is the whole schema as plain `CREATE TABLE`
statements — every column is declared on the table that owns it, rather than
bolted on afterwards.

Once this has gone out to a church that stops being editable: append a new
entry and never touch one that has shipped, so parishes already running an
older copy upgrade cleanly. Opening a database newer than the code is refused
outright rather than half-working.

---

## Notes on security

- Every page except sign-in requires a session; uploaded photographs are served
  behind that check too.
- All state-changing forms carry a per-session CSRF token.
- Sign-in failures are throttled per IP and username.
- Photo uploads are restricted by MIME type and size, stored under a random
  filename, and only accepted from a signed-in editor.
- `SESSION_SECRET` is required in production; the app refuses to start without
  it rather than silently generating a throwaway one.

Set `TRUST_PROXY=1` and serve over HTTPS when deploying behind nginx, Caddy or
a PaaS, so the session cookie is sent with `Secure`.

---

## The original template

`public/parish-directory-template.html` is the standalone layout this was built
from. It is kept as the visual reference — `public/stylesheets/directory.css`
and `views/directory/print.ejs` reproduce it exactly. It is not used at runtime.
