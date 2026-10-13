// RSA signing key for user tokens (RS256).
// The private key never leaves this service; client apps verify tokens with the public key,
// published at /.well-known/jwks.json (and as PEM at /api/auth/public-key).
// On first start a 2048-bit key pair is generated into KEYS_DIR (keys/ by default, git-ignored).
// Keep keys/private.pem when redeploying: replacing it signs everyone out of every app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');

let cache = null;

function loadKeys() {
  if (cache) return cache;
  const privPath = path.join(config.keysDir, 'private.pem');
  const pubPath = path.join(config.keysDir, 'public.pem');
  if (!fs.existsSync(privPath)) {
    fs.mkdirSync(config.keysDir, { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(pubPath, publicKey);
    console.log(`[keys] generated a new RSA key pair in ${config.keysDir}`);
  }
  const privatePem = fs.readFileSync(privPath, 'utf8');
  const publicKey = crypto.createPublicKey(privatePem);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const jwk = publicKey.export({ format: 'jwk' });
  // kid = thumbprint of the public key (RFC 7638), so apps can tell keys apart after a rotation.
  const kid = crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest('base64url').slice(0, 16);
  cache = { privatePem, publicPem, kid, jwks: { keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] } };
  return cache;
}

function signToken(claims, { audience, expiresIn }) {
  const { privatePem, kid } = loadKeys();
  return jwt.sign(claims, privatePem, { algorithm: 'RS256', keyid: kid, issuer: config.issuer, audience, expiresIn });
}

/** Verifies signature, issuer and expiry. audience optional (string or list). */
function verifyToken(token, audience) {
  const { publicPem } = loadKeys();
  return jwt.verify(token, publicPem, { algorithms: ['RS256'], issuer: config.issuer, ...(audience ? { audience } : {}) });
}

module.exports = { loadKeys, signToken, verifyToken };
