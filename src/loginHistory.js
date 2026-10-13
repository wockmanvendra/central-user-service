const db = require('./db');

// One row per OTP request / verify. Never throws: a logging failure must not block a login.
function recordLogin({ req, client, user, mobileno, event, status, failureReason }) {
  const ip = req?.endUserIp || req?.ip || null;
  db.query(
    `INSERT INTO login_history (user_id, client_id, name, empcode, mobileno, usertype, division_code, event, status, failure_reason, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      user?.id ?? null, client?.client_id ?? null, user?.name ?? null, user?.empcode ?? null, mobileno,
      user?.usertype ?? null, user?.division_code ?? null, event, status, failureReason ?? null, ip,
    ]
  ).catch((err) => console.error('[login-history] insert failed:', err.message));
}

module.exports = { recordLogin };
