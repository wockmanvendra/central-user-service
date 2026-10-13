// Registers a client app from the command line and prints its API key (shown once).
//   npm run client:add -- <client_id> "<App name>" [--divisions=85,A5] [--usertypes=nsm,zsm,rm,tm]
//                         [--origins=https://app.example.com] [--ttl=12h]
// Re-running for an existing client_id issues a new API key (the old one stops working).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { pool } = require('../src/db');
const { newApiKey } = require('../src/clients');

const args = process.argv.slice(2);
const flag = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3).split(',').map((s) => s.trim()).filter(Boolean) : null;
};
const [clientId, name] = args.filter((a) => !a.startsWith('--'));

async function main() {
  if (!clientId || !name || !/^[a-z0-9][a-z0-9-]{1,58}$/.test(clientId)) {
    throw new Error('Usage: npm run client:add -- <client_id> "<App name>" [--divisions=85,A5] [--usertypes=nsm,zsm,rm,tm] [--origins=https://...] [--ttl=12h]');
  }
  const key = newApiKey();
  const { rows: [r] } = await pool.query(
    `INSERT INTO clients (client_id, name, allowed_usertypes, allowed_divisions, allowed_origins, token_ttl, api_key_hash, api_key_prefix)
     VALUES ($1, $2, COALESCE($3::text[], ARRAY['nsm','zsm','rm','tm']), COALESCE($4::text[], '{}'), COALESCE($5::text[], '{}'), COALESCE($6, '12h'), $7, $8)
     ON CONFLICT (client_id) DO UPDATE SET name = EXCLUDED.name,
       allowed_usertypes = COALESCE($3::text[], clients.allowed_usertypes), allowed_divisions = COALESCE($4::text[], clients.allowed_divisions),
       allowed_origins = COALESCE($5::text[], clients.allowed_origins), token_ttl = COALESCE($6, clients.token_ttl),
       api_key_hash = EXCLUDED.api_key_hash, api_key_prefix = EXCLUDED.api_key_prefix, updated_at = NOW()
     RETURNING (xmax = 0) AS created, *`,
    [clientId, name, flag('usertypes'), flag('divisions'), flag('origins'), (flag('ttl') || [])[0] || null, key.hash, key.prefix]
  );
  console.log(`${r.created ? 'Registered' : 'Updated'} client ${r.client_id} (${r.name})`);
  console.log(`  user types: ${r.allowed_usertypes.join(', ')} · divisions: ${r.allowed_divisions.join(', ') || 'all'} · token lifetime: ${r.token_ttl}`);
  console.log(`  origins:    ${r.allowed_origins.join(', ') || '(none — server-side login only)'}`);
  console.log(`\n  API key (store it in the app's .env; it is not shown again):\n  ${key.key}\n`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
