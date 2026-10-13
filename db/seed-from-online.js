// Seeds divisions, field structure and NSM / ZSM / RM / TM accounts from the Online project's
// database (d2d_portal). The source is opened READ-ONLY (default_transaction_read_only=on):
// nothing is written there.
//   npm run db:seed-online        (SOURCE_DATABASE_URL and DATABASE_URL from .env)
// Re-running refreshes the copied divisions; accounts that left the structure are deactivated.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { copyFromOnline } = require('../src/sync');
const { pool } = require('../src/db');

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

async function main() {
  const source = process.env.SOURCE_DATABASE_URL;
  if (!source) throw new Error('Set SOURCE_DATABASE_URL (Online d2d_portal database) in .env');
  const target = new URL(process.env.DATABASE_URL);
  if (!LOCAL_HOSTS.includes(target.hostname) && !process.argv.includes('--production')) {
    throw new Error(`DATABASE_URL points at ${target.hostname}, not this machine. Re-run with --production if that is intended.`);
  }
  console.log(`Copying from ${new URL(source).host}${new URL(source).pathname} (read-only) into ${target.host}${target.pathname}\n`);
  const results = await copyFromOnline(source);
  for (const r of results) {
    console.log(`${r.division_name} (${r.division_code}): ${r.field_rows} field rows · ${r.users} accounts · ${r.skipped.length} skipped · ${r.deactivated} deactivated`);
    for (const s of r.skipped) console.log(`   skipped ${s.usertype?.toUpperCase()} ${s.empcode} ${s.name}: ${s.reason}`);
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
