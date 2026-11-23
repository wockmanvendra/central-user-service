// Server-to-server API for client apps (headers X-Client-Id + X-Api-Key).
// Results are limited to the divisions and user types the client is allowed.
//   POST /api/v1/token/introspect { token }  -> { active, user } (signature, expiry, audience and account status)
//   GET  /api/v1/users?division_code=&usertype=&q=&active=true|false|all&limit=&offset=
//   GET  /api/v1/users/:empcode              -> user with managers
//   GET  /api/v1/users/:empcode/team         -> territories and people under them
//   GET  /api/v1/hierarchy?division_code=    -> vw_tm_hierarchy rows (one per territory)
//   GET  /api/v1/otps                        -> this app's live sign-in OTPs (needs OTP_ENCRYPTION_KEY)
const express = require('express');
const db = require('../db');
const { verifyToken } = require('../keys');
const { requireClientKey } = require('../clients');
const otpVault = require('../otpVault');
const { findUser, profileOf, accessFor, teamOf, USER_COLS } = require('../users');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
router.use(requireClientKey());

/** SQL filter limiting rows to the client's divisions / user types. */
function clientScope(client, params, alias = 'u') {
  params.push(client.allowed_usertypes);
  let where = `${alias}.usertype = ANY($${params.length})`;
  if (client.allowed_divisions.length) {
    params.push(client.allowed_divisions);
    where += ` AND ${alias}.division_code = ANY($${params.length})`;
  }
  return where;
}

router.post('/token/introspect', wrap(async (req, res) => {
  const token = String((req.body || {}).token || '');
  let payload;
  try {
    payload = verifyToken(token, req.client.client_id); // only tokens issued for this client
  } catch (err) {
    return res.json({ active: false, reason: err.name === 'TokenExpiredError' ? 'expired' : 'invalid' });
  }
  const user = await findUser('u.id = $1', [payload.sub]);
  if (!user || !user.is_active) return res.json({ active: false, reason: 'inactive' });
  const { roles, denied } = await accessFor(req.client, user);
  if (denied) return res.json({ active: false, reason: 'not-allowed' });
  res.json({ active: true, exp: payload.exp, user: await profileOf(user, roles) });
}));

router.get('/users', wrap(async (req, res) => {
  const params = [];
  const where = [clientScope(req.client, params)];
  const { division_code: division, usertype, q, active = 'true' } = req.query;
  if (division) { params.push(division); where.push(`u.division_code = $${params.length}`); }
  if (usertype) { params.push(String(usertype).toLowerCase()); where.push(`u.usertype = $${params.length}`); }
  if (active !== 'all') where.push(active === 'false' ? 'NOT u.is_active' : 'u.is_active');
  if (q) {
    params.push(`%${String(q).trim()}%`);
    where.push(`(u.name ILIKE $${params.length} OR u.empcode ILIKE $${params.length} OR u.mobileno ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.location ILIKE $${params.length})`);
  }
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const offset = Number(req.query.offset) || 0;
  const { rows } = await db.query(
    `SELECT ${USER_COLS}, COUNT(*) OVER () AS total FROM users u LEFT JOIN divisions d ON d.division_code = u.division_code
     WHERE ${where.join(' AND ')} ORDER BY u.division_code, u.usertype, u.name LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ total: Number(rows[0]?.total || 0), users: rows.map(({ total, ...u }) => u) });
}));

async function scopedUser(req) {
  const params = [req.params.empcode];
  const user = await findUser(`u.empcode = $1 AND ${clientScope(req.client, params)}`, params);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  return user;
}

router.get('/users/:empcode', wrap(async (req, res) => {
  const user = await scopedUser(req);
  res.json({ user: { ...(await profileOf(user)), is_active: user.is_active, source: user.source } });
}));

router.get('/users/:empcode/team', wrap(async (req, res) => {
  const user = await scopedUser(req);
  res.json({ user: await profileOf(user), ...(await teamOf(user)) });
}));

// The live sign-in OTPs this app asked for, for its admins to read out when the email does not
// arrive. Only the calling app's own OTPs, and only while they still work.
router.get('/otps', wrap(async (req, res) => {
  if (!otpVault.enabled()) return res.json({ enabled: false, otps: [] });
  const { rows } = await db.query(
    `SELECT u.empcode, u.name, u.usertype, u.mobileno, u.email, u.otp_encrypted, u.otp_expires_at, u.otp_sent_at, u.otp_attempts
     FROM users u
     WHERE u.otp_client_id = $1 AND u.otp_hash IS NOT NULL AND u.otp_encrypted IS NOT NULL AND u.otp_expires_at > NOW() AND u.is_active
     ORDER BY u.otp_sent_at DESC NULLS LAST
     LIMIT 500`,
    [req.client.client_id]
  );
  res.json({
    enabled: true,
    otps: rows
      .map((r) => ({
        empcode: r.empcode,
        name: r.name,
        usertype: r.usertype,
        mobileno: r.mobileno,
        email: r.email,
        otp: otpVault.open(r.otp_encrypted),
        expires_at: r.otp_expires_at,
        sent_at: r.otp_sent_at,
        attempts: r.otp_attempts,
      }))
      .filter((o) => o.otp),
  });
}));

router.get('/hierarchy', wrap(async (req, res) => {
  const params = [];
  const where = [];
  if (req.client.allowed_divisions.length) { params.push(req.client.allowed_divisions); where.push(`division_code = ANY($${params.length})`); }
  if (req.query.division_code) { params.push(req.query.division_code); where.push(`division_code = $${params.length}`); }
  const { rows } = await db.query(
    `SELECT * FROM vw_tm_hierarchy ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY division_code, zsm_location, rm_location, tm_location`,
    params
  );
  res.json({ rows });
}));

module.exports = router;
