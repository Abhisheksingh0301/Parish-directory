#!/usr/bin/env node
'use strict';

/**
 * The super administrator account, from the command line.
 *
 * Two jobs, and the second is why this exists at all: there is no email in
 * this app, so there is no "forgot my password" link. If the only super
 * administrator locks themselves out, somebody with shell access has to let
 * them back in, and this is that door.
 *
 * It is also how an install that predates multiple churches gets its first
 * super administrator. The web setup screen deliberately does not do it: that
 * route is open to anyone while the database has no users, and on an upgraded
 * directory — which has users already — leaving an unauthenticated way to mint
 * the most privileged account in the system would be indefensible.
 *
 *   node bin/superadmin.js create <username> [--name "Full Name"]
 *   node bin/superadmin.js reset  <username>
 *   node bin/superadmin.js list
 *
 * The password is asked for and not echoed. `--password <value>` is accepted
 * for scripted use, at the cost of putting it in your shell history.
 */

const readline = require('readline');
const db = require('../db');
const auth = require('../lib/auth');
const Users = require('../models/user');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

/** Read a line without echoing it, so the password does not stay on screen. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      return reject(new Error(
        'No terminal to ask for a password on. Pass --password <value> instead.'
      ));
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      // Re-write the prompt with nothing after it, swallowing the keystrokes.
      if (!['\n', '\r', ''].includes(String(char))) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(prompt);
      }
    };

    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function choosePassword(flags) {
  if (typeof flags.password === 'string') {
    const problem = auth.validatePassword(flags.password);
    if (problem) throw new Error(problem);
    return flags.password;
  }

  const password = await askHidden('New password: ');
  const confirm = await askHidden('Again: ');
  const problem = auth.validatePassword(password, confirm);
  if (problem) throw new Error(problem);
  return password;
}

async function create(username, flags) {
  if (!/^[a-zA-Z0-9._@-]{3,60}$/.test(username || '')) {
    throw new Error('Username may use letters, numbers, dot, dash, underscore and @ (3–60 characters).');
  }
  if (await Users.usernameTaken(username)) {
    throw new Error(`The username "${username}" is already taken.`);
  }

  const password = await choosePassword(flags);

  await Users.create({
    username,
    password_hash: await auth.hashPassword(password),
    full_name: typeof flags.name === 'string' ? flags.name : '',
    role: 'superadmin',
    // A super administrator belongs to no church. That is the whole point of
    // the role, and lib/tenancy.js reads the null as "acting as nobody yet".
    church_id: null
  });

  console.log(`\nSuper administrator "${username}" created.`);
  console.log('Sign in and add your dioceses, zones and churches.\n');
}

async function reset(username, flags) {
  const user = await Users.findByUsername(username);
  if (!user) throw new Error(`No account called "${username}".`);
  if (user.role !== 'superadmin') {
    const label = auth.ROLES[user.role] ? auth.ROLES[user.role].label : user.role;
    throw new Error(
      `"${username}" has the role ${label}, not Super administrator. ` +
      'Reset that account from the Users page instead.'
    );
  }

  const password = await choosePassword(flags);
  await Users.setPassword(user.id, await auth.hashPassword(password));

  // Being locked out and being deactivated look the same from outside, and
  // whoever ran this wants the account usable when it finishes.
  if (!user.is_active) {
    await Users.setActive(user.id, true);
    console.log('(the account was deactivated, and has been switched back on)');
  }
  await Users.signOutEverywhere(user.id);

  console.log(`\nPassword changed for "${username}". Any existing sessions were ended.\n`);
}

async function list() {
  const users = await Users.listWithFamilies();
  const supers = users.filter((u) => u.role === 'superadmin');

  if (!supers.length) {
    console.log('\nThere are no super administrators.');
    console.log('Create one with:  node bin/superadmin.js create <username>\n');
    return;
  }

  console.log('\nSuper administrators:');
  for (const u of supers) {
    const state = u.is_active ? 'active' : 'DEACTIVATED';
    const seen = u.last_login_at || 'never signed in';
    console.log(`  ${u.username.padEnd(24)} ${state.padEnd(12)} last seen: ${seen}`);
  }
  console.log('');
}

const USAGE = `
Usage:
  node bin/superadmin.js create <username> [--name "Full Name"] [--password <value>]
  node bin/superadmin.js reset  <username> [--password <value>]
  node bin/superadmin.js list
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, username] = positional;

  if (!command || flags.help) {
    console.log(USAGE);
    return 0;
  }

  await db.init();

  switch (command) {
    case 'create': await create(username, flags); break;
    case 'reset': await reset(username, flags); break;
    case 'list': await list(); break;
    default:
      console.log(USAGE);
      throw new Error(`Unknown command "${command}".`);
  }
  return 0;
}

main()
  .then(async (code) => {
    await db.close();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`\n${err.message}\n`);
    await db.close().catch(() => {});
    process.exit(1);
  });
