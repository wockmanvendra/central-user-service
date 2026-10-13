// Azure Synapse: read-only source of Infinity's field structure (dbo.Field_Structure). It has the
// same columns as the Infinity /filed-structure API, for every division, so no Infinity division id
// or API token is needed. Only SELECT queries are run.
const sql = require('mssql');

let poolPromise = null;

function configured() {
  return !!(process.env.SYNAPSE_SERVER && process.env.SYNAPSE_DATABASE && process.env.SYNAPSE_USER);
}

function getPool() {
  if (!configured()) throw Object.assign(new Error('Synapse is not configured (SYNAPSE_* in .env).'), { status: 400 });
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool({
      server: process.env.SYNAPSE_SERVER,
      database: process.env.SYNAPSE_DATABASE,
      user: process.env.SYNAPSE_USER,
      password: process.env.SYNAPSE_PASSWORD,
      options: { encrypt: String(process.env.SYNAPSE_ENCRYPT ?? 'true').toLowerCase() === 'true', trustServerCertificate: false },
      pool: { max: 4, idleTimeoutMillis: 30000 },
      connectionTimeout: 30000,
      requestTimeout: 120000,
    })
      .connect()
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

/** Sales divisions in the field structure. Code '0' is shared by several internal teams, so it is left out. */
async function listDivisions() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(
    `SELECT divisionCode AS division_code, MAX(division) AS division_name, COUNT(*) AS field_rows
     FROM dbo.Field_Structure
     WHERE divisionCode IS NOT NULL AND divisionCode <> '' AND divisionCode <> '0'
     GROUP BY divisionCode ORDER BY MAX(division)`
  );
  return recordset;
}

/** One division's field-structure rows, keyed by Infinity's camelCase field names (as the API returns). */
async function fieldStructure(divisionCode) {
  const pool = await getPool();
  const { recordset } = await pool
    .request()
    .input('code', sql.NVarChar(20), divisionCode)
    .query('SELECT * FROM dbo.Field_Structure WHERE divisionCode = @code');
  return recordset;
}

async function close() {
  if (poolPromise) {
    const p = await poolPromise.catch(() => null);
    poolPromise = null;
    if (p) await p.close();
  }
}

module.exports = { configured, listDivisions, fieldStructure, close };
