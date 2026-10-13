// Login API used by every client app (from its frontend or backend):
//   POST /api/auth/otp/request { client_id, mobileno }       -> emails a 6-digit OTP
//   POST /api/auth/otp/verify  { client_id, mobileno, otp }  -> { token, user }   (RS256 JWT, aud = client_id)
//   GET  /api/auth/me          Authorization: Bearer <token> -> current user (fails if deactivated)
//   GET  /api/auth/public-key  -> PEM public key (also /.well-known/jwks.json)
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const db = require('../db');
const { signToken, verifyToken, loadKeys } = require('../keys');
const { sendOtpEmail } = require('../mail');
const { getClient, clientDenies, sha256 } = require('../clients');
const { normalizeMobile, maskEmail, findUser, profileOf, USER_COLS } = require('../users');
const { recordLogin } = require('../loginHistory');

const router = express.Router();
const bad = (status, error) => Object.assign(new Error(error), { status });
const otpHash = (userId, otp) => crypto.createHash('sha256').update(`${userId}:${otp}`).digest('hex');

// An app's backend that signs users in on their behalf sends its X-Client-Id + X-Api-Key: all its
// users then share the server's IP, so the per-IP limit is skipped (per-account limits still apply)
// and the user's own IP (end_user_ip) is logged.
async function trustedApp(req, res, next) {
  try {
    const id = req.get('x-client-id');
    const key = req.get('x-api-key');
    if (id && key && id === (req.body || {}).client_id) {
      const client = await getClient(id);
      const hash = sha256(key);
      if (client?.api_key_hash && hash.length === client.api_key_hash.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(client.api_key_hash))) {
        req.trustedApp = true;
        const ip = String((req.body || {}).end_user_ip || '').trim();
        if (/^[0-9a-fA-F.:]{3,45}$/.test(ip)) req.endUserIp = ip;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Sized for staff logins behind one office NAT: generous per IP, the per-account limits do the rest.
const otpLimiter = rateLimit({
  skip: (req) => !!req.trustedApp,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.OTP_RATE_LIMIT) || 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function loginContext(req) {
  const { client_id: clientId, mobileno: rawMobile } = req.body || {};
  if (!clientId || !rawMobile) throw bad(400, 'client_id and mobileno are required');
  const client = await getClient(clientId);
  if (!client) throw bad(400, 'Unknown or disabled application (client_id).');
  const mobileno = normalizeMobile(rawMobile);
  if (!mobileno) throw bad(400, 'Enter a valid 10-digit mobile number.');
  return { client, mobileno };
}

router.post('/otp/request', trustedApp, otpLimiter, wrap(async (req, res) => {
  const { client, mobileno } = await loginContext(req);
  const log = (user, status, failureReason) =>
    recordLogin({ req, client, user, mobileno, event: 'otp-request', status, failureReason });

  const user = await findUser('u.mobileno = $1 AND u.is_active', [mobileno]);
  if (!user) {
    log(null, 'failed', 'No active account');
    throw bad(404, 'No active account is registered with this mobile number. Contact your administrator.');
  }
  const denied = clientDenies(client, user);
  if (denied) {
    log(user, 'failed', denied);
    throw bad(403, denied);
  }
  if (!user.email) {
    log(user, 'failed', 'No email on file');
    throw bad(400, 'No email address is on file for your account. Contact your administrator.');
  }
  const { rows: [state] } = await db.query('SELECT otp_sent_at FROM users WHERE id = $1', [user.id]);
  const waited = state.otp_sent_at ? (Date.now() - new Date(state.otp_sent_at).getTime()) / 1000 : Infinity;
  if (waited < config.otp.resendSeconds) {
    throw bad(429, `Please wait ${Math.ceil(config.otp.resendSeconds - waited)} seconds before requesting another OTP.`);
  }

  const otp = String(crypto.randomInt(100000, 1000000));
  await db.query(
    `UPDATE users SET otp_hash = $1, otp_client_id = $2, otp_expires_at = NOW() + make_interval(mins => $3),
            otp_attempts = 0, otp_sent_at = NOW() WHERE id = $4`,
    [otpHash(user.id, otp), client.client_id, config.otp.expiryMinutes, user.id]
  );

  if (config.otp.delivery === 'console') {
    console.log(`[otp] ${client.client_id} · ${user.mobileno} (${user.name}, ${user.usertype}) → ${otp}  (OTP_DELIVERY=console, no email sent)`);
  } else {
    try {
      await sendOtpEmail({ to: user.email, name: user.name, otp, appName: client.name, expiryMinutes: config.otp.expiryMinutes });
    } catch (err) {
      await db.query('UPDATE users SET otp_hash = NULL, otp_expires_at = NULL, otp_sent_at = NULL WHERE id = $1', [user.id]);
      log(user, 'failed', `Email failed: ${err.message}`);
      throw bad(502, 'Could not send the OTP email. Please try again or contact your administrator.');
    }
  }
  log(user, 'success');
  res.json({
    sent: true,
    channel: 'email',
    email: maskEmail(user.email),
    expires_in_minutes: config.otp.expiryMinutes,
    resend_in_seconds: config.otp.resendSeconds,
  });
}));

router.post('/otp/verify', trustedApp, otpLimiter, wrap(async (req, res) => {
  const { client, mobileno } = await loginContext(req);
  const otp = String((req.body || {}).otp || '').trim();
  if (!/^\d{6}$/.test(otp)) throw bad(400, 'Enter the 6-digit OTP.');
  const log = (user, status, failureReason) =>
    recordLogin({ req, client, user, mobileno, event: 'otp-verify', status, failureReason });

  const { rows: [user] } = await db.query(
    `SELECT ${USER_COLS}, u.otp_hash, u.otp_client_id, u.otp_expires_at, u.otp_attempts
     FROM users u LEFT JOIN divisions d ON d.division_code = u.division_code
     WHERE u.mobileno = $1 AND u.is_active LIMIT 1`,
    [mobileno]
  );
  if (!user) {
    log(null, 'failed', 'No active account');
    throw bad(404, 'No active account is registered with this mobile number.');
  }
  const denied = clientDenies(client, user);
  if (denied) {
    log(user, 'failed', denied);
    throw bad(403, denied);
  }
  if (!user.otp_hash || user.otp_client_id !== client.client_id || !user.otp_expires_at || new Date() > new Date(user.otp_expires_at)) {
    log(user, 'failed', 'OTP expired or not requested');
    throw bad(401, 'OTP expired. Please request a new one.');
  }
  const given = otpHash(user.id, otp);
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(user.otp_hash))) {
    // Too many wrong tries cancel the OTP, so it cannot be guessed.
    const { rows: [r] } = await db.query(
      `UPDATE users SET otp_attempts = otp_attempts + 1,
              otp_hash = CASE WHEN otp_attempts + 1 >= $2 THEN NULL ELSE otp_hash END
       WHERE id = $1 RETURNING otp_attempts`,
      [user.id, config.otp.maxAttempts]
    );
    const left = config.otp.maxAttempts - r.otp_attempts;
    log(user, 'failed', 'Invalid OTP');
    throw bad(401, left > 0 ? `Invalid OTP. ${left} attempt(s) left.` : 'Too many wrong attempts. Please request a new OTP.');
  }

  await db.query(
    `UPDATE users SET otp_hash = NULL, otp_client_id = NULL, otp_expires_at = NULL, otp_attempts = 0, last_login_at = NOW()
     WHERE id = $1`,
    [user.id]
  );
  const profile = await profileOf(user);
  const { id, ...claims } = profile;
  const token = signToken({ ...claims, sub: id }, { audience: client.client_id, expiresIn: client.token_ttl });
  const { exp, iat } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  log(user, 'success');
  res.json({ token, token_type: 'Bearer', expires_in: exp - iat, user: profile });
}));

/** Bearer-token check. audience: required client_id(s), or omit to accept a token from any client. */
function requireUser({ audience, usertypes, serviceAdmin } = {}) {
  return wrap(async (req, res, next) => {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    let payload;
    try {
      payload = verifyToken(header.slice(7), audience);
    } catch (err) {
      return res.status(401).json({ error: err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token' });
    }
    // Re-read the account so a deactivation takes effect immediately.
    const user = await findUser('u.id = $1', [payload.sub]);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Your account is inactive.' });
    if (usertypes && !usertypes.includes(user.usertype)) return res.status(403).json({ error: 'Not authorized' });
    if (serviceAdmin && !user.is_service_admin) return res.status(403).json({ error: 'Not authorized' });
    req.user = user;
    req.token = payload;
    next();
  });
}

router.get('/me', requireUser(), wrap(async (req, res) => {
  res.json({ user: await profileOf(req.user), client_id: req.token.aud, expires_at: new Date(req.token.exp * 1000).toISOString() });
}));

router.get('/public-key', (req, res) => {
  const { publicPem, kid } = loadKeys();
  res.type('text/plain').set('X-Key-Id', kid).send(publicPem);
});

module.exports = { router, requireUser };
