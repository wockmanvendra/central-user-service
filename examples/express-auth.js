// Drop-in token check for a client app's Express backend (CommonJS, Node 18+).
// Verifies tokens issued by the Central User Service locally with its public key (JWKS),
// so the app does not call the service on every request.
//
//   npm install jsonwebtoken
//   .env:  USER_SERVICE_URL=https://users.example.com   USER_SERVICE_CLIENT_ID=bionx-pulse
//
//   const { requireFieldUser } = require('./express-auth');
//   app.use('/api', requireFieldUser());                       // any role allowed for this app
//   app.get('/api/team', requireFieldUser({ roles: ['rm', 'zsm', 'nsm'] }), handler);
//   // req.fieldUser = { id, empcode, name, usertype, division_code, division_name, mobileno, email,
//   //                   location, sap_code, managers: { rm, zsm, nsm } }
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SERVICE = (process.env.USER_SERVICE_URL || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.USER_SERVICE_CLIENT_ID;

let keys = new Map(); // kid -> KeyObject
let fetchedAt = 0;

async function publicKey(kid) {
  // Refresh hourly, or at once when a token names a key we have not seen (key rotation).
  if (!keys.has(kid) || Date.now() - fetchedAt > 60 * 60 * 1000) {
    const res = await fetch(`${SERVICE}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const { keys: list } = await res.json();
    keys = new Map(list.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
    fetchedAt = Date.now();
  }
  const key = keys.get(kid);
  if (!key) throw new Error('Unknown signing key');
  return key;
}

/** Verifies a token for this app. Throws if invalid, expired or issued for another app. */
async function verifyFieldToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded) throw new Error('Malformed token');
  const payload = jwt.verify(token, await publicKey(decoded.header.kid), {
    algorithms: ['RS256'],
    issuer: SERVICE,
    audience: CLIENT_ID,
  });
  const { sub, iat, exp, iss, aud, ...user } = payload;
  return { id: sub, ...user, exp };
}

function requireFieldUser({ roles } = {}) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    try {
      req.fieldUser = await verifyFieldToken(header.slice(7));
    } catch (err) {
      return res.status(401).json({ error: err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token' });
    }
    if (roles && !roles.includes(req.fieldUser.usertype)) return res.status(403).json({ error: 'Not authorized' });
    next();
  };
}

module.exports = { verifyFieldToken, requireFieldUser };
