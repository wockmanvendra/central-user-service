// User lookups shared by the login, client and admin APIs.
const db = require('./db');
const { clientDenies, roleDenied } = require('./clients');

const FIELD_TYPES = ['nsm', 'zsm', 'rm', 'tm'];
const STAFF_TYPES = ['bu-head', 'admin']; // division staff of an app (e.g. BIONX PULSE BU head / admin)
const USERTYPES = [...FIELD_TYPES, ...STAFF_TYPES];

/** '+91 98765-43210' -> '9876543210' (Indian mobile: last 10 digits). Returns null if not a mobile. */
function normalizeMobile(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

const maskEmail = (email) => {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

const USER_COLS = `u.id, u.empcode, u.name, u.usertype, u.division_code, d.division_name, u.mobileno, u.email,
  u.location, u.sap_code, u.source, u.is_active, u.is_service_admin, u.last_login_at, u.created_at, u.updated_at`;

async function findUser(where, params) {
  const { rows } = await db.query(
    `SELECT ${USER_COLS} FROM users u LEFT JOIN divisions d ON d.division_code = u.division_code WHERE ${where} LIMIT 1`,
    params
  );
  return rows[0] || null;
}

const person = (empcode, name) => (empcode ? { empcode, name } : null);

/** The reporting line above a field user (RM / ZSM / NSM), from vw_tm_hierarchy. */
async function managersOf(user) {
  const none = { rm: null, zsm: null, nsm: null };
  if (!user.empcode || !FIELD_TYPES.includes(user.usertype) || user.usertype === 'nsm') return none;
  const col = { tm: 'tm_empcode', rm: 'rm_empcode', zsm: 'zsm_empcode' }[user.usertype];
  const { rows: [h] } = await db.query(
    `SELECT rm_empcode, rm_name, zsm_empcode, zsm_name, nsm_empcode, nsm_name
     FROM vw_tm_hierarchy WHERE ${col} = $1 AND division_code = $2 LIMIT 1`,
    [user.empcode, user.division_code]
  );
  if (!h) return none;
  return {
    rm: user.usertype === 'tm' ? person(h.rm_empcode, h.rm_name) : null,
    zsm: user.usertype !== 'zsm' ? person(h.zsm_empcode, h.zsm_name) : null,
    nsm: person(h.nsm_empcode, h.nsm_name),
  };
}

/**
 * Everyone below a field user, plus the territories they cover (for apps that scope data by territory).
 * TM -> their own territory; RM -> TMs of their region; ZSM -> RMs and TMs; NSM -> ZSMs, RMs and TMs.
 */
async function teamOf(user) {
  const col = { tm: 'tm_empcode', rm: 'rm_empcode', zsm: 'zsm_empcode', nsm: 'nsm_empcode' }[user.usertype];
  if (!col || !user.empcode) return { territories: [], members: [] };
  const { rows } = await db.query(
    `SELECT * FROM vw_tm_hierarchy WHERE ${col} = $1 AND division_code = $2 ORDER BY tm_location`,
    [user.empcode, user.division_code]
  );
  const members = new Map();
  const add = (usertype, empcode, name, location) => {
    if (empcode && empcode !== user.empcode && !members.has(empcode)) members.set(empcode, { empcode, name, usertype, location });
  };
  for (const r of rows) {
    if (user.usertype === 'nsm') add('zsm', r.zsm_empcode, r.zsm_name, r.zsm_location);
    if (['nsm', 'zsm'].includes(user.usertype)) add('rm', r.rm_empcode, r.rm_name, r.rm_location);
    add('tm', r.tm_empcode, r.tm_name, r.tm_location);
  }
  return {
    territories: rows.map((r) => ({
      territory: r.tm_location,
      sap_code: r.tm_sapcode,
      tm: person(r.tm_empcode, r.tm_name), // null = vacant territory
      rm: person(r.rm_empcode, r.rm_name),
      zsm: person(r.zsm_empcode, r.zsm_name),
    })),
    members: [...members.values()],
  };
}

const roleKey = (r) => `${r.usertype}:${r.division_code || ''}`;
const mainRole = (user) => ({
  key: roleKey(user),
  usertype: user.usertype,
  division_code: user.division_code,
  division_name: user.division_name || null,
  sap_code: user.sap_code,
  main: true,
});

/** The account's extra roles (user_roles), with the apps each applies to. */
async function extraRolesOf(userId) {
  const { rows } = await db.query(
    `SELECT r.id, r.usertype, r.division_code, d.division_name, r.sap_code, r.client_ids
       FROM user_roles r LEFT JOIN divisions d ON d.division_code = r.division_code
      WHERE r.user_id = $1 ORDER BY r.created_at, r.usertype`,
    [userId]
  );
  return rows;
}

/**
 * The roles this user signs in to `client` with: the main role, then the extra roles ticked for
 * the client — each kept only if the client allows it. No role: no access, and `denied` says why.
 */
async function accessFor(client, user) {
  if (client.client_id === 'admin-console') {
    const denied = clientDenies(client, user);
    return { roles: denied ? [] : [mainRole(user)], denied };
  }
  const extra = (await extraRolesOf(user.id))
    .filter((r) => r.client_ids.includes(client.client_id))
    .map((r) => ({ key: roleKey(r), usertype: r.usertype, division_code: r.division_code, division_name: r.division_name || null, sap_code: r.sap_code, main: false }));
  const roles = [mainRole(user), ...extra].filter((r) => !roleDenied(client, r));
  return { roles, denied: roles.length ? null : clientDenies(client, user) };
}

/**
 * The user object returned by the APIs and carried in the token. With `roles` (accessFor), the
 * top-level usertype / division / sap_code are the first of them — the main role whenever the app
 * allows it — so an app that reads only those sees one role it may serve; `roles` lists them all.
 */
async function profileOf(user, roles) {
  const first = roles?.[0];
  const u = first
    ? { ...user, usertype: first.usertype, division_code: first.division_code, division_name: first.division_name, sap_code: first.sap_code }
    : user;
  return {
    id: u.id,
    empcode: u.empcode,
    name: u.name,
    usertype: u.usertype,
    division_code: u.division_code,
    division_name: u.division_name || null,
    mobileno: u.mobileno,
    email: u.email,
    location: u.location,
    sap_code: u.sap_code,
    // Apps may widen access for the service's own admins (IBB Insights: every division).
    is_service_admin: u.is_service_admin === true,
    managers: await managersOf(u),
    ...(roles ? { roles } : {}),
  };
}

module.exports = {
  FIELD_TYPES, STAFF_TYPES, USERTYPES, normalizeMobile, maskEmail, findUser, managersOf, teamOf, profileOf,
  accessFor, extraRolesOf, USER_COLS,
};
