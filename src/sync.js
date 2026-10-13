// Field data → login accounts, mirroring the Online project (routes/masters.js):
//   1. field structure: GET <INFINITY_REPORT_BASE_URL>/filed-structure/<infinity_division_id> → field_structure_infinity
//   2. users: vw_infinity_users → users (nsm / zsm / rm / tm), deactivating people who left the structure
// Sources: the Infinity API, or the same report mirrored in Azure Synapse (dbo.Field_Structure, all
// divisions, no Infinity id / token needed). copyFromOnline() seeds from Online's d2d_portal database.
// Every source is read-only.
const { Client } = require('pg');
const config = require('./config');
const db = require('./db');
const { FIELD_TYPES, normalizeMobile } = require('./users');
const synapse = require('./synapse');

const COLS = [
  'tm_location_id', 'division', 'division_code', 'manager1_code', 'manager1_name', 'manager1_location_id',
  'manager1_location', 'manager1_location_type', 'manager1_sap_code', 'manager1_sap_name',
  'manager2_code', 'manager2_name', 'manager2_location_id', 'manager2_location', 'manager2_location_type',
  'manager2_sap_code', 'manager2_sap_name', 'emp_code', 'emp_name', 'emp_location', 'emp_location_type',
  'sap_code', 'sap_name', 'mirror_hq', 'emp_job_role', 'job_role_id', 'emp_doj', 'emp_dob', 'active_from',
  'active_to', 'email', 'mobile', 'corporate_mobile', 'emp_id', 'town', 'state', 'whatsapp_consent_detail',
];
// Infinity's camelCase field name for each column, as in Online's sync (empDOJ / empDOB keep upper case).
const camel = (c) => c.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase()).replace(/Doj$/, 'DOJ').replace(/Dob$/, 'DOB');
const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
const RANK = { nsm: 4, zsm: 3, rm: 2, tm: 1 };

async function recordSync(entry) {
  try {
    await db.query(
      `INSERT INTO sync_history (sync_type, division_code, status, record_count, skipped_count, deactivated_count, error_message, details, run_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entry.type, entry.division ?? null, entry.status, entry.count ?? null, entry.skipped ?? null, entry.deactivated ?? null,
        entry.error ?? null, entry.details ? JSON.stringify(entry.details) : null, entry.by ?? null]
    );
  } catch (err) {
    console.error('[sync] could not record sync history:', err.message);
  }
}

/** Replaces one division's field-structure rows (inside the caller's transaction). */
async function replaceFieldStructure(client, divisionCode, records) {
  await client.query('DELETE FROM field_structure_infinity WHERE d2d_division_code = $1', [divisionCode]);
  const placeholders = [...COLS, 'd2d_division_code'].map((_, i) => `$${i + 1}`).join(', ');
  let count = 0;
  for (const r of records) {
    if (!str(r.tm_location_id)) continue;
    await client.query(
      `INSERT INTO field_structure_infinity (${[...COLS, 'd2d_division_code'].join(', ')}) VALUES (${placeholders})
       ON CONFLICT (tm_location_id) DO UPDATE SET ${[...COLS.slice(1), 'd2d_division_code'].map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
      [...COLS.map((c) => str(r[c])), divisionCode]
    );
    count++;
  }
  return count;
}

/**
 * Step 2: create / update / deactivate this division's field accounts from vw_infinity_users plus
 * each person's own row (by job role).
 * Rows without an emp code, a valid mobile or an email are skipped (login is by email OTP);
 * a mobile number already used by another active person is skipped too.
 */
async function syncUsers(client, divisionCode) {
  // vw_infinity_users (Online's view) finds NSMs only through ZSM zone rows, so an NSM above vacant
  // zones is missed; people are therefore also taken from their own row's job role.
  const { rows } = await client.query(
    `SELECT user_type, empcode, user_name, user_location, sapcode, mobile_no, email_id
     FROM vw_infinity_users WHERE division_code = $1
     UNION ALL
     SELECT UPPER(emp_job_role), emp_code, emp_name, emp_location, sap_code, mobile, email
     FROM field_structure_infinity
     WHERE COALESCE(d2d_division_code, division_code) = $1 AND UPPER(emp_job_role) IN ('NSM', 'ZSM', 'RM', 'TM')
       AND COALESCE(emp_code, '') <> ''`,
    [divisionCode]
  );
  // Someone listed in two roles keeps the higher one.
  const byEmp = new Map();
  for (const r of rows) {
    const usertype = String(r.user_type || '').toLowerCase();
    if (!r.empcode || !FIELD_TYPES.includes(usertype)) continue;
    const prev = byEmp.get(r.empcode);
    if (!prev || RANK[usertype] > RANK[prev.usertype]) byEmp.set(r.empcode, { ...r, usertype });
  }
  if (!byEmp.size) {
    throw Object.assign(new Error(`No field users found for division ${divisionCode}; nothing was changed.`), { status: 400 });
  }

  let count = 0;
  const skipped = [];
  for (const r of byEmp.values()) {
    const mobileno = normalizeMobile(r.mobile_no);
    const email = str(r.email_id);
    const skip = (reason) => skipped.push({ empcode: r.empcode, name: r.user_name, usertype: r.usertype, reason });
    if (!mobileno) { skip(`Invalid mobile number "${r.mobile_no ?? ''}"`); continue; }
    if (!email) { skip('No email address (needed for OTP)'); continue; }
    const { rows: [clash] } = await client.query(
      'SELECT empcode, name FROM users WHERE mobileno = $1 AND is_active AND empcode IS DISTINCT FROM $2',
      [mobileno, r.empcode]
    );
    if (clash) { skip(`Mobile ${mobileno} already used by ${clash.name} (${clash.empcode || 'manual account'})`); continue; }
    await client.query(
      `INSERT INTO users (empcode, name, usertype, division_code, mobileno, email, location, sap_code, source, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'infinity', TRUE)
       ON CONFLICT (empcode) DO UPDATE SET
         name = EXCLUDED.name, usertype = EXCLUDED.usertype, division_code = EXCLUDED.division_code,
         mobileno = EXCLUDED.mobileno, email = EXCLUDED.email, location = EXCLUDED.location,
         sap_code = EXCLUDED.sap_code, source = 'infinity', is_active = NOT users.disabled_by_admin, updated_at = NOW()`,
      [r.empcode, str(r.user_name) || r.empcode, r.usertype, divisionCode, mobileno, email, str(r.user_location), str(r.sapcode)]
    );
    count++;
  }

  // People who dropped out of the structure are deactivated, not deleted (history stays; a
  // later sync reactivates them if they come back).
  const { rowCount: deactivated } = await client.query(
    `UPDATE users SET is_active = FALSE, updated_at = NOW()
     WHERE source = 'infinity' AND division_code = $1 AND is_active
       AND empcode <> ALL($2::text[])`,
    [divisionCode, [...byEmp.keys()]]
  );
  return { count, skipped, deactivated };
}

async function ensureDivision(client, code, name, infinityId) {
  await client.query(
    `INSERT INTO divisions (division_code, division_name, infinity_division_id) VALUES ($1, $2, $3)
     ON CONFLICT (division_code) DO UPDATE SET
       division_name = COALESCE(NULLIF(EXCLUDED.division_name, ''), divisions.division_name),
       infinity_division_id = COALESCE(EXCLUDED.infinity_division_id, divisions.infinity_division_id)`,
    [code, name || code, infinityId || null]
  );
}

/** Full sync of one division from the Infinity API: field structure, then users. */
async function syncDivisionFromInfinity(divisionCode, by) {
  const { rows: [div] } = await db.query('SELECT * FROM divisions WHERE division_code = $1', [divisionCode]);
  const fail = async (error, status = 400) => {
    await recordSync({ type: 'field-structure', division: divisionCode, status: 'error', error, by });
    throw Object.assign(new Error(error), { status });
  };
  if (!div) await fail(`Unknown division ${divisionCode}`);
  if (!div.infinity_division_id) await fail(`No Infinity division id is set for ${div.division_name} (${divisionCode}).`);

  const headers = config.infinity.headerName && config.infinity.token ? { [config.infinity.headerName]: config.infinity.token } : {};
  let records;
  try {
    const res = await fetch(`${config.infinity.reportBaseUrl}/filed-structure/${encodeURIComponent(div.infinity_division_id)}`, {
      headers,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Infinity field-structure API responded ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('Infinity field-structure API returned an unexpected response');
    records = body.map((r) => Object.fromEntries(COLS.map((c) => [c, r[camel(c)]])));
  } catch (err) {
    await fail(err.message, 502);
  }
  // An empty answer would wipe the division and deactivate everyone: treat it as an error.
  if (!records.length) await fail('Infinity returned no field-structure records; nothing was changed.', 502);
  return applyStructure(divisionCode, records, 'field-structure', by);
}

/** Replace the division's field structure with records (snake_case columns) and update its accounts. */
async function applyStructure(divisionCode, records, type, by) {
  const result = await db.tx(async (client) => {
    const rows = await replaceFieldStructure(client, divisionCode, records);
    return { rows, ...(await syncUsers(client, divisionCode)) };
  });
  await recordSync({ type, division: divisionCode, status: 'success', count: result.rows, by });
  await recordSync({
    type: 'users', division: divisionCode, status: 'success', count: result.count,
    skipped: result.skipped.length, deactivated: result.deactivated, details: { skipped: result.skipped }, by,
  });
  return { division_code: divisionCode, field_rows: result.rows, users: result.count, skipped: result.skipped, deactivated: result.deactivated };
}

/** Full sync of one division from Synapse's copy of the Infinity field structure (dbo.Field_Structure). */
async function syncDivisionFromSynapse(divisionCode, by) {
  const fail = async (error, status = 400) => {
    await recordSync({ type: 'synapse', division: divisionCode, status: 'error', error, by });
    throw Object.assign(new Error(error), { status });
  };
  const { rows: [div] } = await db.query('SELECT * FROM divisions WHERE division_code = $1', [divisionCode]);
  if (!div) await fail(`Unknown division ${divisionCode}`);
  let records;
  try {
    records = (await synapse.fieldStructure(divisionCode)).map((r) => Object.fromEntries(COLS.map((c) => [c, r[camel(c)]])));
  } catch (err) {
    await fail(`Synapse: ${err.message}`, err.status || 502);
  }
  if (!records.length) await fail(`Synapse has no field-structure rows for division ${divisionCode}; nothing was changed.`, 404);
  return applyStructure(divisionCode, records, 'synapse', by);
}

/**
 * Adds every sales division found in Synapse to the divisions table (names refreshed), then syncs
 * them — or only the codes given. Returns one result (or error) per division.
 */
async function syncFromSynapse(codes, by) {
  const found = await synapse.listDivisions();
  for (const d of found) {
    await db.query(
      `INSERT INTO divisions (division_code, division_name) VALUES ($1, $2)
       ON CONFLICT (division_code) DO UPDATE SET division_name = EXCLUDED.division_name`,
      [d.division_code, d.division_name]
    );
  }
  const wanted = codes && codes.length ? found.filter((d) => codes.includes(d.division_code)) : found;
  const results = [];
  for (const d of wanted) {
    try {
      results.push({ division_name: d.division_name, ...(await syncDivisionFromSynapse(d.division_code, by)) });
    } catch (err) {
      results.push({ division_code: d.division_code, division_name: d.division_name, error: err.message });
    }
  }
  return results;
}

/** Rebuild one division's accounts from the field structure already stored (no Infinity call). */
async function rebuildUsers(divisionCode, by) {
  const r = await db.tx((client) => syncUsers(client, divisionCode));
  await recordSync({
    type: 'users', division: divisionCode, status: 'success', count: r.count,
    skipped: r.skipped.length, deactivated: r.deactivated, details: { skipped: r.skipped }, by,
  });
  return { division_code: divisionCode, users: r.count, skipped: r.skipped, deactivated: r.deactivated };
}

/**
 * Seed from the Online project's database (d2d_portal): divisions (division_mapping) and the field
 * structure, then build the users. The source connection is read-only — nothing is written there.
 */
async function copyFromOnline(sourceUrl, by = 'copy-from-online') {
  const src = new Client({ connectionString: sourceUrl, connectionTimeoutMillis: 15000, options: '-c default_transaction_read_only=on' });
  await src.connect();
  let mapping, structure;
  try {
    mapping = (await src.query('SELECT division_code, infinity_division_code, division_name FROM division_mapping')).rows;
    structure = (await src.query(`SELECT ${COLS.join(', ')}, COALESCE(d2d_division_code, division_code) AS div FROM field_structure_infinity`)).rows;
  } finally {
    await src.end();
  }

  const byDivision = new Map();
  for (const r of structure) {
    if (!r.div) continue;
    if (!byDivision.has(r.div)) byDivision.set(r.div, []);
    byDivision.get(r.div).push(r);
  }
  const results = [];
  for (const [code, rows] of byDivision) {
    const m = mapping.find((x) => x.division_code === code);
    const r = await db.tx(async (client) => {
      await ensureDivision(client, code, m?.division_name || rows[0].division, m?.infinity_division_code);
      const fieldRows = await replaceFieldStructure(client, code, rows);
      return { fieldRows, ...(await syncUsers(client, code)) };
    });
    await recordSync({ type: 'copy-online', division: code, status: 'success', count: r.fieldRows, by });
    await recordSync({
      type: 'users', division: code, status: 'success', count: r.count,
      skipped: r.skipped.length, deactivated: r.deactivated, details: { skipped: r.skipped }, by,
    });
    results.push({ division_code: code, division_name: m?.division_name || rows[0].division, field_rows: r.fieldRows, users: r.count, skipped: r.skipped, deactivated: r.deactivated });
  }
  return results;
}

module.exports = { syncDivisionFromInfinity, syncDivisionFromSynapse, syncFromSynapse, rebuildUsers, copyFromOnline, recordSync };
