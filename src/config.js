// All settings come from .env (see .env.example).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const bool = (v) => String(v).toLowerCase() === 'true';

const config = {
  port: Number(process.env.PORT) || 5020,
  databaseUrl: process.env.DATABASE_URL,
  // Token issuer (the "iss" claim) — the public URL of this service.
  issuer: (process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT) || 5020}`).replace(/\/+$/, ''),
  keysDir: process.env.KEYS_DIR ? path.resolve(process.env.KEYS_DIR) : path.join(__dirname, '..', 'keys'),

  otp: {
    expiryMinutes: Number(process.env.OTP_EXPIRY_MINUTES) || 10,
    resendSeconds: Number(process.env.OTP_RESEND_SECONDS) || 30,
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS) || 5,
    // email = send the OTP by email (production). console = print it in the service log only
    // (local testing — no mail reaches real field users).
    delivery: process.env.OTP_DELIVERY === 'console' ? 'console' : 'email',
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 25,
    secure: bool(process.env.SMTP_SECURE),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM,
  },

  infinity: {
    reportBaseUrl: (process.env.INFINITY_REPORT_BASE_URL || 'https://infinityplus.wockhardt.com/plus/report').replace(/\/+$/, ''),
    headerName: process.env.INFINITY_API_HEADER_NAME,
    token: process.env.INFINITY_API_TOKEN,
  },

  // Extra browser origins allowed besides each client's allowed_origins (e.g. the admin page host).
  corsOrigins: list(process.env.CORS_ORIGINS),
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : 1,
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required (see .env.example)');

module.exports = config;
