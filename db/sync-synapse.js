// Loads divisions, field structure and NSM / ZSM / RM / TM accounts from Azure Synapse
// (dbo.Field_Structure — Infinity's field structure for every division). Synapse is only read.
//   npm run db:sync-synapse                     all sales divisions
//   npm run db:sync-synapse -- --divisions=A8,85
// Re-running refreshes the data; people no longer in a division's structure are deactivated.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { syncFromSynapse } = require('../src/sync');
const { pool } = require('../src/db');
const synapse = require('../src/synapse');

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || null;

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  if (!LOCAL_HOSTS.includes(target.hostname) && !process.argv.includes('--production')) {
    throw new Error(`DATABASE_URL points at ${target.hostname}, not this machine. Re-run with --production if that is intended.`);
  }
  const codes = (arg('divisions') || '').split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`Synapse ${process.env.SYNAPSE_DATABASE} (read-only) → ${target.host}${target.pathname}\n`);
  const results = await syncFromSynapse(codes, 'sync-synapse (command line)');
  for (const r of results) {
    if (r.error) { console.log(`${r.division_name} (${r.division_code}): FAILED — ${r.error}`); continue; }
    console.log(`${r.division_name} (${r.division_code}): ${r.field_rows} field rows · ${r.users} accounts · ${r.skipped.length} skipped · ${r.deactivated} deactivated`);
    for (const s of r.skipped) console.log(`   skipped ${String(s.usertype).toUpperCase()} ${s.empcode} ${s.name}: ${s.reason}`);
  }
  if (results.some((r) => r.error)) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Sync failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await synapse.close();
    await pool.end();
  });
