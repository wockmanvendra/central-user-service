// Imports an app's staff accounts (BU heads / admins) from that app's own users table, so the app
// can drop its separate login table. The source database is opened READ-ONLY.
//
//   npm run db:import-staff -- --source=<postgres url> --division=AESTHETICS [--division-name=AESTHETICS]
//                              [--types=bu-head,admin] [--source-division=AESTHETICS]
//
// --source may also name an env variable holding the URL (e.g. --source=BIONX_USERS_DATABASE_URL).
// The source table needs: name, usertype, mobileno, email, is_active (and division_code when
// --source-division is given). Matching is by mobile number:
//   - no active account with that mobile  -> a new staff account in --division
//   - an existing manual / staff account  -> updated to the staff role and division
//   - an active field user from Infinity  -> skipped (one person, one account: fix by hand)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { Client } = require('pg');
const { pool } = require('../src/db');
const { normalizeMobile, STAFF_TYPES } = require('../src/users');

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || null;

async function main() {
  const sourceArg = arg('source');
  const division = arg('division');
  if (!sourceArg || !division) {
    throw new Error('Usage: npm run db:import-staff -- --source=<postgres url | ENV_NAME> --division=AESTHETICS [--types=bu-head,admin] [--source-division=AESTHETICS]');
  }
  const sourceUrl = /^postgres(ql)?:\/\//.test(sourceArg) ? sourceArg : process.env[sourceArg];
  if (!sourceUrl) throw new Error(`No database URL in --source or env ${sourceArg}`);
  const types = (arg('types') || STAFF_TYPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  if (types.some((t) => !STAFF_TYPES.includes(t))) throw new Error(`--types must be from ${STAFF_TYPES.join(', ')}`);
  const target = new URL(process.env.DATABASE_URL);
  if (!LOCAL_HOSTS.includes(target.hostname) && !process.argv.includes('--production')) {
    throw new Error(`DATABASE_URL points at ${target.hostname}, not this machine. Re-run with --production if that is intended.`);
  }

  const src = new Client({ connectionString: sourceUrl, connectionTimeoutMillis: 15000, options: '-c default_transaction_read_only=on' });
  await src.connect();
  let rows;
  try {
    const params = [types];
    let where = 'usertype = ANY($1) AND is_active';
    if (arg('source-division')) { params.push(arg('source-division')); where += ' AND division_code = $2'; }
    rows = (await src.query(`SELECT name, usertype, mobileno, email FROM users WHERE ${where} ORDER BY usertype, name`, params)).rows;
  } finally {
    await src.end();
  }
  const s = new URL(sourceUrl);
  console.log(`Read ${rows.length} staff account(s) from ${s.host}${s.pathname} (read-only)\n`);

  await pool.query(
    `INSERT INTO divisions (division_code, division_name) VALUES ($1, $2) ON CONFLICT (division_code) DO NOTHING`,
    [division, arg('division-name') || division]
  );
  const counts = { created: 0, updated: 0, skipped: 0 };
  for (const r of rows) {
    const mobile = normalizeMobile(r.mobileno);
    const email = String(r.email || '').trim() || null;
    const label = `${r.usertype.padEnd(7)} ${r.name} (${r.mobileno})`;
    if (!mobile || !email) { counts.skipped++; console.log(`  skipped  ${label}: ${!mobile ? 'invalid mobile' : 'no email'}`); continue; }
    const { rows: [cur] } = await pool.query('SELECT id, usertype, source, name FROM users WHERE mobileno = $1 AND is_active', [mobile]);
    if (cur && cur.source === 'infinity') {
      counts.skipped++;
      console.log(`  skipped  ${label}: mobile belongs to field user ${cur.name} (${cur.usertype.toUpperCase()}, from Infinity)`);
    } else if (cur) {
      await pool.query(
        `UPDATE users SET name = $2, usertype = $3, division_code = $4, email = $5, updated_at = NOW() WHERE id = $1`,
        [cur.id, r.name, r.usertype, division, email]
      );
      counts.updated++;
      console.log(`  updated  ${label}`);
    } else {
      await pool.query(
        `INSERT INTO users (name, usertype, division_code, mobileno, email, source) VALUES ($1, $2, $3, $4, $5, 'manual')`,
        [r.name, r.usertype, division, mobile, email]
      );
      counts.created++;
      console.log(`  created  ${label}`);
    }
  }
  console.log(`\n${counts.created} created · ${counts.updated} updated · ${counts.skipped} skipped (division ${division})`);
}

main()
  .catch((err) => {
    console.error('Import failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
