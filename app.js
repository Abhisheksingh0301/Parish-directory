'use strict';

const path = require('path');
const createError = require('http-errors');
const express = require('express');
const session = require('express-session');
const logger = require('morgan');

const config = require('./config');
const auth = require('./lib/auth');
const tenancy = require('./lib/tenancy');
const csrf = require('./lib/csrf');
const html = require('./lib/html');
const settings = require('./lib/settings');
const wrap = require('./lib/async');
const Pending = require('./models/pending');
const createSqliteStore = require('./lib/session-store');
const { acceptPhoto } = require('./lib/upload');
const { acceptSheet, acceptArchive } = require('./lib/import-upload');

const authRouter = require('./routes/auth');
const indexRouter = require('./routes/index');
const familiesRouter = require('./routes/families');
const directoryRouter = require('./routes/directory');
const reviewRouter = require('./routes/review');
const adminRouter = require('./routes/admin');
const superRouter = require('./routes/super');
const superReportsRouter = require('./routes/super-reports');

const app = express();

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.set('trust proxy', config.trustProxy ? 1 : false);
app.disable('x-powered-by');

/**
 * The public URL prefix, in front of every link and asset a page writes.
 *
 * Set here rather than beside the other view helpers below because the error
 * page needs it too, and an error can be raised before those helpers run — a
 * rejected upload or an expired form both render a page from above this line.
 */
app.use((req, res, next) => {
  res.locals.base = config.basePath;
  next();
});

app.use(logger(config.isProduction ? 'combined' : 'dev'));
/*
 * Body limits.
 *
 * The defaults are 100 KB and 1000 parameters, and the parameter count is the
 * one that bites first: a family posts nine fields per member, so a household
 * entered with a long list of members climbs towards the limit while the body
 * is still only tens of kilobytes. Both then fail the same way — a bare 413
 * from body-parser, on a form the person had just spent ten minutes filling in.
 *
 * Photographs do not pass through here. They are multipart, which these skip
 * entirely and multer handles with its own 5 MB limit and a message that lands
 * on the form rather than an error page.
 */
app.use(express.json({ limit: '1mb' }));
// extended: true so the family form can post members[0][name] as a nested object.
app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 5000 }));

app.use(express.static(path.join(__dirname, 'public')));

const SqliteStore = createSqliteStore(session);

app.use(session({
  name: 'parish.sid',
  secret: config.sessionSecret,
  store: new SqliteStore({}),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: 14 * 24 * 60 * 60 * 1000
  }
}));

app.use(auth.loadUser);
// Which church this request is about, before anything reads or writes a row.
app.use(tenancy.resolveChurch);
app.use(settings.middleware);

/**
 * The family form posts multipart/form-data when it carries a photo, and the
 * two import pages do when they carry a spreadsheet or an archive of
 * photographs. The CSRF check below cannot read `_csrf` until that body is
 * parsed — so multer has to run first, and the role check has to be made here
 * rather than left to the route, because by the time the route runs the file
 * has already been accepted.
 *
 * Which handler runs is decided by the path, and it has to be: the photograph
 * handler refuses anything that is not an image and answers to a different
 * field name, so a sheet or an archive sent through it would be dropped and
 * the import would report an empty upload it never received.
 *
 * `req.path` is the whole path here — the app is mounted at the root, and
 * config.basePath is a prefix for the links a page writes, stripped by the
 * proxy in front of this.
 */
app.use((req, res, next) => {
  if (!req.is('multipart/form-data')) return next();

  if (req.path === '/admin/import' || req.path === '/admin/photos') {
    if (!auth.atLeast(req.user, 'admin')) {
      return next(createError(403, 'You do not have permission to import files.'));
    }
    /*
     * And it has to be for a church, checked here rather than left to
     * `tenancy.requireChurch` on the router below.
     *
     * That guard redirects a super administrator who has not borrowed a church
     * to go and pick one — which is right, and which means the route never
     * runs. The archive route deletes its upload in a `finally`, so a route
     * that never runs is an uploaded file, of up to two hundred megabytes,
     * left in the scratch folder for ever. Refusing before multer starts means
     * there is nothing to leave behind.
     */
    if (!req.churchId) {
      return next(createError(403, 'Choose which church you are importing into first.'));
    }
    return req.path === '/admin/photos'
      ? acceptArchive(req, res, next)
      : acceptSheet(req, res, next);
  }

  // Editors upwards, plus a family login sending the photograph for its own
  // entry — the route it posts to checks that it is in fact their own, and
  // deletes the uploaded file if it is not.
  if (!auth.atLeast(req.user, 'editor') && !auth.isFamilyLogin(req.user)) {
    return next(createError(403, 'You do not have permission to upload files.'));
  }
  return acceptPhoto(req, res, next);
});

app.use(csrf);

// View helpers: current path for nav highlighting, role checks, and the
// escape-then-linebreak helper used for multi-line addresses.
app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.atLeast = (role) => auth.atLeast(req.user, role);
  res.locals.isFamilyLogin = auth.isFamilyLogin(req.user);
  res.locals.roleLabel = (role) => (auth.ROLES[role] ? auth.ROLES[role].label : role);
  res.locals.nl2br = html.nl2br;
  next();
});

/**
 * How many proposals are waiting, for the badge on the Review tab.
 *
 * One indexed COUNT per page for staff who can actually act on it, and nothing
 * at all for a household login or for a super administrator who has not
 * borrowed a church. A queue nobody can see the size of is a queue that grows.
 */
app.use(wrap(async (req, res, next) => {
  res.locals.pendingCount = 0;
  if (req.churchId && auth.atLeast(req.user, 'editor')) {
    res.locals.pendingCount = await Pending.openCount(req.churchId);
  }
  next();
}));

// Sign-in, first-run setup and the account page manage their own access.
app.use('/', authRouter);

// Everything past this point requires a signed-in user.
app.use(auth.requireAuth);

/**
 * Photographs, served only to the church they belong to.
 *
 * This used to be a bare static mount, which handed every image in the
 * installation to any signed-in user who knew a filename. Now the path names
 * the church and the request has to be for that one — a super administrator
 * excepted, since they may look at any of them.
 */
app.use('/uploads/:churchId(\\d+)', (req, res, next) => {
  const wanted = Number(req.params.churchId);
  const allowed = auth.isSuperAdmin(req.user) || Number(req.churchId) === wanted;
  if (!allowed) return next(createError(403, 'That photograph is not yours to view.'));

  express.static(path.join(config.uploadDir, String(wanted)), { maxAge: '7d' })(req, res, next);
});
app.use('/', indexRouter);
app.use('/families', familiesRouter);
app.use('/directory', directoryRouter);
app.use('/review', reviewRouter);
app.use('/admin', adminRouter);
app.use('/super', superReportsRouter);
app.use('/super', superRouter);

app.use((req, res, next) => next(createError(404, 'That page does not exist.')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);

  /*
   * A download that fails halfway cannot be turned into an error page — the
   * status line and half a spreadsheet have already gone. Rendering over it
   * would throw inside the handler that exists to catch throws, so the
   * connection is cut instead: a truncated file the browser reports as failed,
   * rather than a zip with an HTML page pasted into the middle of it.
   */
  if (res.headersSent) {
    return req.socket.destroy();
  }

  /*
   * "request entity too large" is body-parser's wording, and it tells a parish
   * administrator nothing about what to do. Say what was too big and what to
   * do about it instead.
   *
   * Note that a 413 raised by a reverse proxy — nginx caps uploads at 1 MB
   * unless client_max_body_size says otherwise — never reaches this handler at
   * all: the proxy answers it and the app never sees the request. If people
   * report this on a photograph and not on a long form, the cap is in front of
   * this application, not in it.
   */
  const message = status === 413
    ? 'That was too much to send at once. If you were attaching a photograph, '
      + 'use a smaller image; otherwise the entry has more in it than one save can carry.'
    : err.message;

  res.status(status).render('error', {
    title: status === 404 ? 'Page not found' : 'Something went wrong',
    message,
    error: config.isProduction ? {} : err
  });
});

module.exports = app;
