// A readable copy of a live OTP, for client apps whose admins read a code out when the email does
// not arrive (GET /api/v1/otps, behind the app's API key). The one-way otp_hash still decides
// whether a code is right; this copy is AES-256-GCM encrypted with OTP_ENCRYPTION_KEY and cleared
// whenever otp_hash is. Without the key nothing is stored and apps simply see no codes.
const crypto = require('crypto');
const config = require('./config');

const key = config.otp.encryptionKey;

const enabled = () => !!key;

/** "iv.tag.ciphertext" in base64url, or null when the key is not set. */
function seal(otp) {
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(otp), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

/** The OTP, or null when it cannot be read (no key, another key, damaged value). */
function open(sealed) {
  if (!key || !sealed) return null;
  try {
    const [iv, tag, data] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { enabled, seal, open };
