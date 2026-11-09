// Creates the database (if missing), its tables and views, and the first admin account.
//   npm run db:init                     local database (DATABASE_URL on localhost / 127.0.0.1)
//   npm run db:init -- --production     any other host (e.g. the production server) — deliberate opt-in
// Safe to re-run.
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { Client } = require('pg');

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!dbName) throw new Error('DATABASE_URL must include a database name');
  if (!LOCAL_HOSTS.includes(url.hostname) && !process.argv.includes('--production')) {
    throw new Error(`DATABASE_URL points at ${url.hostname}, not this machine. Re-run with --production if that is intended.`);
  }

  // 1. Create the database if it does not exist (connecting to the server's maintenance DB).
  const probe = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000 });
  try {
    await probe.connect();
    console.log(`Database ${dbName} found on ${url.host}`);
    await probe.end();
  } catch (e) {
    if (e.code !== '3D000') throw e; // 3D000 = database does not exist
    const admin = new URL(url.toString());
    admin.pathname = '/postgres';
    const a = new Client({ connectionString: admin.toString(), connectionTimeoutMillis: 10000 });
    await a.connect();
    await a.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`Created database ${dbName} on ${url.host}`);
    await a.end();
  }

  // 2. Schema.
  const c = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000 });
  await c.connect();
  await c.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  console.log('Tables ready: divisions, users, user_roles, clients, login_history, field_structure_infinity, sync_history');
  console.log('Views ready:  vw_emp_email_mobile, vw_tm_hierarchy, vw_infinity_users');

  // 3. First service admin (signs in to /admin with an email OTP). An existing account with this
  //    mobile number keeps its role and just gets service-admin access.
  const { ADMIN_NAME, ADMIN_MOBILE, ADMIN_EMAIL } = process.env;
  if (ADMIN_NAME && ADMIN_MOBILE && ADMIN_EMAIL) {
    const mobile = String(ADMIN_MOBILE).replace(/\D/g, '').slice(-10);
    const { rows: [existing] } = await c.query('SELECT id, usertype FROM users WHERE mobileno = $1 AND is_active', [mobile]);
    if (existing) {
      await c.query('UPDATE users SET name = $2, email = $3, is_service_admin = TRUE, updated_at = NOW() WHERE id = $1', [existing.id, ADMIN_NAME, ADMIN_EMAIL]);
      console.log(`Service admin access given to ${ADMIN_NAME} · ${mobile} · OTP to ${ADMIN_EMAIL}`);
    } else {
      await c.query(
        `INSERT INTO users (name, usertype, mobileno, email, is_service_admin, source) VALUES ($1, 'admin', $2, $3, TRUE, 'manual')`,
        [ADMIN_NAME, mobile, ADMIN_EMAIL]
      );
      console.log(`Admin created: ${ADMIN_NAME} · ${mobile} · OTP to ${ADMIN_EMAIL}`);
    }
  } else {
    console.log('ADMIN_NAME / ADMIN_MOBILE / ADMIN_EMAIL not set in .env — no admin account created.');
  }
  await c.end();
}

main().catch((err) => {
  console.error('db:init failed:', err.message);
  process.exit(1);
});
