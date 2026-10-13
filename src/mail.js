const nodemailer = require('nodemailer');
const config = require('./config');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let transport = null;

/**
 * Same relay rules as BIONX PULSE / Regen:
 * SMTP_SECURE=true -> authenticated TLS login; false -> internal relay without login (self-signed TLS accepted).
 */
function getTransport() {
  if (transport) return transport;
  const { host, port, secure, user, pass } = config.smtp;
  if (!host) throw Object.assign(new Error('Email is not configured on the server (SMTP_HOST).'), { status: 500 });
  const settings = { host, port, secure: port === 587 ? false : secure, connectionTimeout: 20000 };
  if (secure) settings.auth = { user, pass };
  else settings.tls = { rejectUnauthorized: false };
  transport = nodemailer.createTransport(settings);
  return transport;
}

async function sendOtpEmail({ to, name, otp, appName, expiryMinutes }) {
  if (!config.smtp.from) throw Object.assign(new Error('Email sender is not configured on the server (MAIL_FROM).'), { status: 500 });
  const html = `<!doctype html><html><body style="margin:0;background:#f3f7fb;font-family:Segoe UI,Arial,sans-serif;color:#15263a">
  <div style="max-width:520px;margin:0 auto;padding:20px">
    <div style="background:#071b2e;color:#fff;border-radius:14px 14px 0 0;padding:16px 22px;font-size:18px;font-weight:800;letter-spacing:.5px">${esc(appName)}</div>
    <div style="background:#fff;border:1px solid #dbe5ef;border-top:0;border-radius:0 0 14px 14px;padding:22px">
      <p style="margin:0 0 14px;font-size:14px">Dear ${esc(name || 'User')},</p>
      <p style="margin:0 0 14px;font-size:14px">Your one-time password to sign in to <b>${esc(appName)}</b> is:</p>
      <div style="display:inline-block;background:#eaf2ff;border:1px solid #c9dcff;border-radius:8px;padding:12px 26px;font-size:28px;font-weight:800;letter-spacing:.3em;color:#1478ff">${esc(otp)}</div>
      <p style="margin:14px 0 6px;font-size:14px">It is valid for <b>${expiryMinutes} minutes</b>. Do not share it with anyone.</p>
      <p style="margin:0;font-size:12px;color:#6d7f94">If you did not request this, you can ignore this email.</p>
    </div>
  </div></body></html>`;
  const info = await getTransport().sendMail({ from: config.smtp.from, to, subject: `${appName} - OTP Verification`, html });
  if (info.rejected && info.rejected.length) {
    throw Object.assign(new Error('Could not send the OTP email. Contact your administrator.'), { status: 502 });
  }
}

module.exports = { sendOtpEmail };
