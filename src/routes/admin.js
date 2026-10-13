// Admin API for the admin page (/admin). Requires a token issued to the built-in
// 'admin-console' client for a service administrator (users.is_service_admin).
const express = require('express');
const db = require('../db');
const { requireUser } = require('./auth');
const { USERTYPES, normalizeMobile, USER_COLS } = require('../users');
const { invalidateClients, newApiKey } = require('../clients');
const { syncDivisionFromInfinity, syncDivisionFromSynapse, syncFromSynapse, rebuildUsers } = require('../sync');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const bad = (status, error) => Object.assign(new Error(error), { status });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

router.use(requireUser({ audience: 'admin-console', serviceAdmin: true }));

// Unique-index clash on mobile number -> readable 409.
function friendly(err) {
  if (err.code === '23505' && /mobile/.test(err.constraint || '')) return bad(409, 'Another active account already uses this mobile number.');
  if (err.code === '23505' && /empcode/.test(err.constraint || '')) return bad(409, 'Another account already uses this employee code.');
  if (err.code === '23503') return bad(400, 'Unknown division.');
  return err;
}

// ── Overview ──
router.get('/summary', wrap(async (req, res) => {
  const [byDivision, logins, syncs] = await Promise.all([
    db.query(`SELECT d.division_code, d.division_name, d.infinity_division_id,
                     COUNT(u.id) FILTER (WHERE u.is_active AND u.usertype = 'nsm') AS nsm,
                     COUNT(u.id) FILTER (WHERE u.is_active AND u.usertype = 'zsm') AS zsm,
                     COUNT(u.id) FILTER (WHERE u.is_active AND u.usertype = 'rm')  AS rm,
                     COUNT(u.id) FILTER (WHERE u.is_active AND u.usertype = 'tm')  AS tm,
                     COUNT(u.id) FILTER (WHERE NOT u.is_active) AS inactive,
                     (SELECT COUNT(*) FROM field_structure_infinity f WHERE f.d2d_division_code = d.division_code) AS field_rows,
                     (SELECT MAX(run_at) FROM sync_history s WHERE s.division_code = d.division_code AND s.status = 'success') AS last_sync
              FROM divisions d LEFT JOIN users u ON u.division_code = d.division_code
              GROUP BY d.division_code ORDER BY d.division_name`),
    db.query(`SELECT COUNT(*) FILTER (WHERE event = 'otp-verify' AND status = 'success') AS logins,
                     COUNT(*) FILTER (WHERE status = 'failed') AS failures
              FROM login_history WHERE created_at > NOW() - INTERVAL '7 days'`),
    db.query(`SELECT COUNT(*) AS clients FROM clients WHERE is_active`),
  ]);
  res.json({ divisions: byDivision.rows, last7days: logins.rows[0], activeClients: Number(syncs.rows[0].clients) });
}));

// ── Users ──
router.get('/users', wrap(async (req, res) => {
  const params = [];
  const where = [];
  const { q, division_code: division, usertype, status, source } = req.query;
  if (division) { params.push(division); where.push(`u.division_code = $${params.length}`); }
  if (usertype) { params.push(usertype); where.push(`u.usertype = $${params.length}`); }
  if (source) { params.push(source); where.push(`u.source = $${params.length}`); }
  if (status === 'active') where.push('u.is_active');
  if (status === 'inactive') where.push('NOT u.is_active');
  if (q) {
    params.push(`%${String(q).trim()}%`);
    const p = `$${params.length}`;
    where.push(`(u.name ILIKE ${p} OR u.empcode ILIKE ${p} OR u.mobileno ILIKE ${p} OR u.email ILIKE ${p} OR u.location ILIKE ${p})`);
  }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { rows } = await db.query(
    `SELECT ${USER_COLS}, u.disabled_by_admin, COUNT(*) OVER () AS total
     FROM users u LEFT JOIN divisions d ON d.division_code = u.division_code
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY d.division_name NULLS FIRST, array_position(ARRAY['bu-head','admin','nsm','zsm','rm','tm'], u.usertype::text), u.name
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ total: Number(rows[0]?.total || 0), users: rows.map(({ total, ...u }) => u) });
}));

function userInput(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = str(body.name);
    if (!out.name) throw bad(400, 'Name is required.');
  }
  if (!partial || body.mobileno !== undefined) {
    out.mobileno = normalizeMobile(body.mobileno);
    if (!out.mobileno) throw bad(400, 'Enter a valid 10-digit mobile number.');
  }
  if (!partial || body.email !== undefined) {
    out.email = str(body.email);
    if (!out.email || !EMAIL_RE.test(out.email)) throw bad(400, 'A valid email address is required (the OTP is sent there).');
  }
  if (!partial || body.usertype !== undefined) {
    out.usertype = str(body.usertype)?.toLowerCase();
    if (!USERTYPES.includes(out.usertype)) throw bad(400, `User type must be one of ${USERTYPES.join(', ')}.`);
  }
  for (const k of ['division_code', 'empcode', 'location', 'sap_code']) if (!partial || body[k] !== undefined) out[k] = str(body[k]);
  if (!partial || body.is_service_admin !== undefined) out.is_service_admin = body.is_service_admin === true || body.is_service_admin === 'true' || body.is_service_admin === 'on';
  return out;
}

router.post('/users', wrap(async (req, res) => {
  const u = userInput(req.body || {}, { partial: false });
  if (!u.division_code && !u.is_service_admin) throw bad(400, 'Division is required (only a service admin may have none).');
  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO users (empcode, name, usertype, division_code, mobileno, email, location, sap_code, is_service_admin, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual') RETURNING id`,
      [u.empcode, u.name, u.usertype, u.division_code, u.mobileno, u.email, u.location, u.sap_code, u.is_service_admin]
    );
    res.status(201).json({ id: row.id });
  } catch (err) {
    throw friendly(err);
  }
}));

router.patch('/users/:id', wrap(async (req, res) => {
  const body = req.body || {};
  const u = userInput(body, { partial: true });
  if (body.is_active !== undefined) {
    if (req.params.id === req.user.id && !body.is_active) throw bad(400, 'You cannot deactivate your own account.');
    u.is_active = !!body.is_active;
    u.disabled_by_admin = !body.is_active;
  }
  if (req.params.id === req.user.id && u.is_service_admin === false) throw bad(400, 'You cannot remove your own service-admin access.');
  const keys = Object.keys(u);
  if (!keys.length) throw bad(400, 'Nothing to update.');
  try {
    const { rowCount } = await db.query(
      `UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
      [req.params.id, ...keys.map((k) => u[k])]
    );
    if (!rowCount) throw bad(404, 'User not found.');
    res.json({ updated: true });
  } catch (err) {
    throw friendly(err);
  }
}));

// ── Divisions ──
router.get('/divisions', wrap(async (req, res) => {
  res.json({ divisions: (await db.query('SELECT * FROM divisions ORDER BY division_name')).rows });
}));

router.post('/divisions', wrap(async (req, res) => {
  const b = req.body || {};
  const code = str(b.division_code);
  const name = str(b.division_name);
  if (!code || !name) throw bad(400, 'Division code and name are required.');
  await db.query(
    `INSERT INTO divisions (division_code, division_name, infinity_division_id, is_active) VALUES ($1, $2, $3, COALESCE($4, TRUE))
     ON CONFLICT (division_code) DO UPDATE SET division_name = EXCLUDED.division_name,
       infinity_division_id = EXCLUDED.infinity_division_id, is_active = EXCLUDED.is_active`,
    [code, name, str(b.infinity_division_id), b.is_active === undefined ? null : !!b.is_active]
  );
  res.json({ saved: true });
}));

// ── Sync ── mode 'synapse' = Synapse copy of the field structure (default); 'infinity' = Infinity API;
// 'rebuild' = rebuild accounts from the stored structure
router.post('/sync', wrap(async (req, res) => {
  const { division_code: division, mode = 'synapse' } = req.body || {};
  if (!division) throw bad(400, 'division_code is required.');
  const by = `${req.user.name} (admin page)`;
  if (mode === 'rebuild') return res.json(await rebuildUsers(division, by));
  res.json(mode === 'infinity' ? await syncDivisionFromInfinity(division, by) : await syncDivisionFromSynapse(division, by));
}));

// All sales divisions from Synapse (new divisions are added).
router.post('/sync/synapse-all', wrap(async (req, res) => {
  res.json({ results: await syncFromSynapse(null, `${req.user.name} (admin page)`) });
}));

router.get('/sync-history', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM sync_history ORDER BY run_at DESC LIMIT 100');
  res.json({ history: rows });
}));

// ── Client apps ──
const clientOut = ({ api_key_hash, ...c }) => ({ ...c, has_api_key: !!api_key_hash });
const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
const TTL_RE = /^\d+[smhd]$/;

router.get('/clients', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM clients ORDER BY client_id');
  res.json({ clients: rows.map(clientOut) });
}));

function clientInput(b) {
  const out = {};
  if (b.name !== undefined) out.name = str(b.name);
  if (b.allowed_usertypes !== undefined) {
    out.allowed_usertypes = arr(b.allowed_usertypes).map((s) => s.toLowerCase());
    if (!out.allowed_usertypes.length || out.allowed_usertypes.some((t) => !USERTYPES.includes(t))) {
      throw bad(400, `Allowed user types must be from ${USERTYPES.join(', ')}.`);
    }
  }
  if (b.allowed_divisions !== undefined) out.allowed_divisions = arr(b.allowed_divisions);
  if (b.allowed_origins !== undefined) out.allowed_origins = arr(b.allowed_origins).map((o) => o.replace(/\/+$/, ''));
  if (b.token_ttl !== undefined) {
    out.token_ttl = str(b.token_ttl);
    if (!TTL_RE.test(out.token_ttl || '')) throw bad(400, 'Token lifetime must look like 30m, 12h or 7d.');
  }
  if (b.is_active !== undefined) out.is_active = !!b.is_active;
  return out;
}

router.post('/clients', wrap(async (req, res) => {
  const b = req.body || {};
  const id = str(b.client_id)?.toLowerCase();
  if (!id || !/^[a-z0-9][a-z0-9-]{1,58}$/.test(id)) throw bad(400, 'client_id: lowercase letters, digits and dashes (e.g. bionx-pulse).');
  const c = clientInput(b);
  if (!c.name) throw bad(400, 'Name is required.');
  const key = newApiKey();
  try {
    await db.query(
      `INSERT INTO clients (client_id, name, allowed_usertypes, allowed_divisions, allowed_origins, token_ttl, api_key_hash, api_key_prefix)
       VALUES ($1, $2, COALESCE($3::text[], ARRAY['nsm','zsm','rm','tm']), COALESCE($4::text[], '{}'), COALESCE($5::text[], '{}'), COALESCE($6, '12h'), $7, $8)`,
      [id, c.name, c.allowed_usertypes || null, c.allowed_divisions || null, c.allowed_origins || null, c.token_ttl || null, key.hash, key.prefix]
    );
  } catch (err) {
    if (err.code === '23505') throw bad(409, `Client ${id} already exists.`);
    throw err;
  }
  invalidateClients();
  // The key is shown once; only its hash is stored.
  res.status(201).json({ client_id: id, api_key: key.key });
}));

router.patch('/clients/:id', wrap(async (req, res) => {
  const c = clientInput(req.body || {});
  if (req.params.id === 'admin-console' && (c.is_active === false || c.allowed_usertypes)) {
    throw bad(400, 'The admin-console client cannot be disabled or given other user types.');
  }
  const keys = Object.keys(c);
  if (!keys.length) throw bad(400, 'Nothing to update.');
  const { rowCount } = await db.query(
    `UPDATE clients SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE client_id = $1`,
    [req.params.id, ...keys.map((k) => c[k])]
  );
  if (!rowCount) throw bad(404, 'Client not found.');
  invalidateClients();
  res.json({ updated: true });
}));

router.post('/clients/:id/rotate-key', wrap(async (req, res) => {
  const key = newApiKey();
  const { rowCount } = await db.query(
    'UPDATE clients SET api_key_hash = $2, api_key_prefix = $3, updated_at = NOW() WHERE client_id = $1',
    [req.params.id, key.hash, key.prefix]
  );
  if (!rowCount) throw bad(404, 'Client not found.');
  invalidateClients();
  res.json({ client_id: req.params.id, api_key: key.key });
}));

// ── Login history ──
router.get('/login-history', wrap(async (req, res) => {
  const params = [];
  const where = [];
  const { q, client_id: clientId, status } = req.query;
  if (clientId) { params.push(clientId); where.push(`client_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (q) {
    params.push(`%${String(q).trim()}%`);
    where.push(`(name ILIKE $${params.length} OR mobileno ILIKE $${params.length} OR empcode ILIKE $${params.length})`);
  }
  const { rows } = await db.query(
    `SELECT * FROM login_history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`,
    params
  );
  res.json({ history: rows });
}));

module.exports = router;
