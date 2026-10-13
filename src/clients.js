// Client apps registered with the service, and the API-key check for server-to-server calls.
const crypto = require('crypto');
const db = require('./db');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

let cache = { at: 0, byId: new Map() };
const CACHE_MS = 30 * 1000;

async function allClients() {
  if (Date.now() - cache.at > CACHE_MS) {
    const { rows } = await db.query('SELECT * FROM clients');
    cache = { at: Date.now(), byId: new Map(rows.map((c) => [c.client_id, c])) };
  }
  return cache.byId;
}
const invalidateClients = () => { cache.at = 0; };

async function getClient(clientId) {
  const c = (await allClients()).get(String(clientId || ''));
  return c && c.is_active ? c : null;
}

/** May this user sign in to / be read by this client? Returns an error message or null. */
function clientDenies(client, user) {
  if (client.client_id === 'admin-console') {
    return user.is_service_admin ? null : 'This admin page is for service administrators only.';
  }
  if (!client.allowed_usertypes.includes(user.usertype)) return `${client.name} is not available for your role.`;
  if (client.allowed_divisions.length && !client.allowed_divisions.includes(user.division_code)) {
    return `${client.name} is not available for your division.`;
  }
  return null;
}

/** New API key: 'cus_' + 40 random hex chars. Only its hash is stored. */
function newApiKey() {
  const key = `cus_${crypto.randomBytes(20).toString('hex')}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 10) };
}

/**
 * Express middleware for /api/v1: headers X-Client-Id + X-Api-Key (or HTTP Basic client_id:api_key).
 * Sets req.client.
 */
function requireClientKey() {
  return async (req, res, next) => {
    try {
      let id = req.get('x-client-id');
      let key = req.get('x-api-key');
      const auth = req.get('authorization') || '';
      if ((!id || !key) && auth.startsWith('Basic ')) {
        [id, key] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      }
      const client = id && key ? await getClient(id) : null;
      if (!client || !client.api_key_hash || !safeEqual(sha256(key), client.api_key_hash)) {
        return res.status(401).json({ error: 'Invalid client credentials' });
      }
      req.client = client;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Browser origins allowed by any active client (CORS for the login API). */
async function allowedOrigins() {
  const out = new Set();
  for (const c of (await allClients()).values()) if (c.is_active) c.allowed_origins.forEach((o) => out.add(o.replace(/\/+$/, '')));
  return out;
}

module.exports = { getClient, allClients, invalidateClients, clientDenies, newApiKey, requireClientKey, allowedOrigins, sha256 };
