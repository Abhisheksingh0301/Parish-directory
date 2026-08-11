# Parish Directory

A printable family directory for a parish, with sign-in. The printed output is
a server-rendered version of the approved layout in
`public/parish-directory-template.html`, filled from a database instead of a
hand-edited array at the bottom of an HTML file.

Built to be reused: **one install per church**. Nothing about a particular
parish is in the code — the name, the printed palette, the page layout and the
relation names are all settings an administrator edits in the browser.

Relations are whole words — `Head`, `Wife`, `Son`, `Daughter` — not the codes
`HF, W, S, D` this started with. They print as typed and read without a key,
which matters when the family filling in its own entry has never seen the
directory's shorthand. Migration 2 converts the ten shipped codes in place; a
parish's own codes, and its own edited list of suggestions, are left alone, and
`lib/relations.js` still recognises both spellings.

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

**Date of birth** is a **full date** — `02 - Aug - 1975` — chosen with a date
picker, so it is a real date by construction: between 1900 and today, with
29 February only in a leap year. The picker is
`public/javascripts/datepicker.js` rather than the browser's own, which only
walks a month at a time: it puts the month and the year in dropdowns above the
calendar, because a date of birth is usually decades away. It enhances a plain
`<input type="date">`, so with JavaScript off the field is still a native date
input and the server sees the same value. A son or daughter must be born after the
youngest parent in the family; the form refuses a child who would be as old as
their parents.

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
a parish's own codes never quietly redraw its book. Note this is the one place
`views/directory/print.ejs` knowingly departs from
`public/parish-directory-template.html`, whose sample data has the spouse
second and so renders identically either way.

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
   - the relations your parish uses (`Head, Wife, Son, Daughter, …`),
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
  email.js           stricter than type=email, which passes "steve@gmail"
  relations.js       who is a parent, who is a child, and who is too old
  session-store.js   sessions in the same SQLite file
  settings.js        the per-parish settings layer
  upload.js          photo uploads
routes/              auth, dashboard, families, directory, admin
views/directory/     the printable directory
public/stylesheets/  app.css (screens), directory.css (the printed book)
public/javascripts/  datepicker.js and friends — progressive enhancement only
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
