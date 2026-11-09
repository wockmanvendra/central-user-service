-- Central User Service — database schema (PostgreSQL 13+). Safe to re-run.
--
-- One login account per field employee (NSM / ZSM / RM / TM), shared by every client app,
-- instead of a users table per project. Field data comes from Infinity's field-structure
-- report, the same source and column layout as the Online (D2D) project.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() on PostgreSQL < 13

-- ── Divisions ────────────────────────────────────────────────────────────────
-- division_code = Infinity's divisionCode (e.g. 85 BIOSCIENCES, A5 RESPIRATORY).
-- infinity_division_id = the id Infinity expects in /filed-structure/<id>.
CREATE TABLE IF NOT EXISTS divisions (
    division_code        VARCHAR(50)  PRIMARY KEY,
    division_name        VARCHAR(150) NOT NULL,
    infinity_division_id VARCHAR(100),
    is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Users ────────────────────────────────────────────────────────────────────
-- usertype: nsm | zsm | rm | tm (field users, from Infinity or added by hand), or division staff:
-- bu-head | admin (an app's BU head / administrator, e.g. BIONX PULSE). is_service_admin is separate
-- and grants this service's own admin page. Login is by mobile number + email OTP, so an active
-- account needs a unique mobile number and an email address.
CREATE TABLE IF NOT EXISTS users (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    empcode        VARCHAR(50)  UNIQUE,                 -- Infinity emp code; NULL for admins added by hand
    name           VARCHAR(150) NOT NULL,
    usertype       VARCHAR(20)  NOT NULL,
    division_code  VARCHAR(50)  REFERENCES divisions(division_code),  -- NULL only for a pure service admin
    mobileno       VARCHAR(15)  NOT NULL,
    email          VARCHAR(150),
    location       VARCHAR(150),                        -- territory / region / zone name
    sap_code       VARCHAR(100),
    source         VARCHAR(20)  NOT NULL DEFAULT 'manual' CHECK (source IN ('infinity', 'manual')),
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    disabled_by_admin BOOLEAN   NOT NULL DEFAULT FALSE,     -- an admin switched the account off: the Infinity sync keeps it off
    is_service_admin  BOOLEAN   NOT NULL DEFAULT FALSE,     -- may use this service's admin page (any role)
    -- OTP state: only a SHA-256 hash is stored, bound to the client app that asked for it.
    otp_hash       VARCHAR(64),
    otp_client_id  VARCHAR(60),
    otp_expires_at TIMESTAMPTZ,
    otp_attempts   INT          NOT NULL DEFAULT 0,
    otp_sent_at    TIMESTAMPTZ,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
-- A mobile number identifies one active account (inactive accounts may keep an old number).
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_service_admin BOOLEAN NOT NULL DEFAULT FALSE;
-- Earlier versions: usertype 'admin' without a division meant the service admin.
UPDATE users SET is_service_admin = TRUE WHERE usertype = 'admin' AND division_code IS NULL AND NOT is_service_admin;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_usertype_check;
ALTER TABLE users ADD CONSTRAINT users_usertype_check CHECK (usertype IN ('nsm', 'zsm', 'rm', 'tm', 'bu-head', 'admin'));
CREATE UNIQUE INDEX IF NOT EXISTS users_active_mobile_uq ON users (mobileno) WHERE is_active;
CREATE INDEX IF NOT EXISTS users_division_idx ON users (division_code, usertype);

-- ── Extra roles ──────────────────────────────────────────────────────────────
-- A person may hold more than one role (e.g. RM in 85 and BU head of A8). The account's own
-- usertype / division_code is the main role; each extra role here applies to the client apps it
-- lists. The Infinity sync never touches this table.
CREATE TABLE IF NOT EXISTS user_roles (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usertype       VARCHAR(20)  NOT NULL CHECK (usertype IN ('nsm', 'zsm', 'rm', 'tm', 'bu-head', 'admin')),
    division_code  VARCHAR(50)  NOT NULL REFERENCES divisions(division_code),
    sap_code       VARCHAR(100),                        -- optional, e.g. 'WKI,WKC'; else the hierarchy by empcode
    client_ids     TEXT[]       NOT NULL CHECK (cardinality(client_ids) > 0),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, usertype, division_code)
);

-- ── Client apps ──────────────────────────────────────────────────────────────
-- Every project that signs users in through this service. The api key (stored as a
-- SHA-256 hash) authenticates server-to-server calls (/api/v1/*); the login itself only
-- needs the public client_id. Empty allowed_divisions = all divisions.
CREATE TABLE IF NOT EXISTS clients (
    client_id          VARCHAR(60)  PRIMARY KEY,            -- e.g. bionx-pulse (becomes the token "aud")
    name               VARCHAR(150) NOT NULL,               -- shown in the OTP email
    allowed_usertypes  TEXT[]       NOT NULL DEFAULT ARRAY['nsm', 'zsm', 'rm', 'tm'],
    allowed_divisions  TEXT[]       NOT NULL DEFAULT '{}',
    allowed_origins    TEXT[]       NOT NULL DEFAULT '{}',  -- browser origins allowed to call the login API (CORS)
    token_ttl          VARCHAR(20)  NOT NULL DEFAULT '12h',
    api_key_hash       VARCHAR(64),
    api_key_prefix     VARCHAR(16),                         -- first characters, to recognise a key
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Login history (every attempt, success or failure, per client app) ────────
CREATE TABLE IF NOT EXISTS login_history (
    id             BIGSERIAL    PRIMARY KEY,
    user_id        UUID,
    client_id      VARCHAR(60),
    name           VARCHAR(150),
    empcode        VARCHAR(50),
    mobileno       VARCHAR(15)  NOT NULL,
    usertype       VARCHAR(20),
    division_code  VARCHAR(50),
    event          VARCHAR(20)  NOT NULL,   -- otp-request | otp-verify
    status         VARCHAR(20)  NOT NULL,   -- success | failed
    failure_reason TEXT,
    ip             VARCHAR(64),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS login_history_created_idx ON login_history (created_at DESC);

-- ── Infinity field structure (same columns as the Online project) ────────────
-- One row per field location; d2d_division_code holds this service's division_code.
CREATE TABLE IF NOT EXISTS field_structure_infinity (
    tm_location_id          VARCHAR(60)   PRIMARY KEY,
    division                VARCHAR(150),
    division_code           VARCHAR(20),
    manager1_code           VARCHAR(50),
    manager1_name           VARCHAR(150),
    manager1_location_id    VARCHAR(60),
    manager1_location       VARCHAR(150),
    manager1_location_type  VARCHAR(50),
    manager1_sap_code       VARCHAR(100),
    manager1_sap_name       VARCHAR(150),
    manager2_code           VARCHAR(50),
    manager2_name           VARCHAR(150),
    manager2_location_id    VARCHAR(60),
    manager2_location       VARCHAR(150),
    manager2_location_type  VARCHAR(50),
    manager2_sap_code       VARCHAR(100),
    manager2_sap_name       VARCHAR(150),
    emp_code                VARCHAR(50),
    emp_name                VARCHAR(150),
    emp_location            VARCHAR(150),
    emp_location_type       VARCHAR(50),
    sap_code                VARCHAR(100),
    sap_name                VARCHAR(150),
    mirror_hq               VARCHAR(10),
    emp_job_role            VARCHAR(100),
    job_role_id             VARCHAR(60),
    emp_doj                 VARCHAR(20),
    emp_dob                 VARCHAR(20),
    active_from             VARCHAR(20),
    active_to               VARCHAR(20),
    email                   VARCHAR(150),
    mobile                  VARCHAR(50),
    corporate_mobile        VARCHAR(50),
    emp_id                  VARCHAR(60),
    town                    VARCHAR(100),
    state                   VARCHAR(100),
    whatsapp_consent_detail VARCHAR(50),
    d2d_division_code       VARCHAR(20)
);
CREATE INDEX IF NOT EXISTS fsi_division_idx ON field_structure_infinity (d2d_division_code);

-- ── Sync history ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_history (
    id                BIGSERIAL    PRIMARY KEY,
    sync_type         VARCHAR(30)  NOT NULL,   -- field-structure | users | copy-online
    division_code     VARCHAR(50),
    status            VARCHAR(20)  NOT NULL,   -- success | error
    record_count      INTEGER,
    skipped_count     INTEGER,
    deactivated_count INTEGER,
    error_message     TEXT,
    details           JSONB,                   -- skipped rows and their reasons
    run_by_name       VARCHAR(150),
    run_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Views — same definitions as the Online project (d2d_portal) ──────────────
DROP VIEW IF EXISTS vw_infinity_users CASCADE;
DROP VIEW IF EXISTS vw_tm_hierarchy CASCADE;
DROP VIEW IF EXISTS vw_emp_email_mobile CASCADE;

CREATE VIEW vw_emp_email_mobile AS
SELECT COALESCE(d2d_division_code, division_code) AS division_code,
       emp_code, emp_name, mobile AS mobile_no, email AS email_id
FROM field_structure_infinity;

-- One row per Territory, with its RM (manager1), ZSM (manager2) and NSM (manager1 of the ZSM's Zone row).
CREATE VIEW vw_tm_hierarchy AS
SELECT COALESCE(a.d2d_division_code, a.division_code) AS division_code,
       nsm.emp_code      AS nsm_empcode,
       nsm.emp_name      AS nsm_name,
       nsm.emp_location  AS nsm_location,
       nsm.sap_code      AS nsm_sapcode,
       nsm.mobile_no     AS nsm_mobile_no,
       nsm.email_id      AS nsm_email_id,
       a.manager2_code   AS zsm_empcode,
       a.manager2_name   AS zsm_name,
       a.manager2_location AS zsm_location,
       a.manager2_sap_code AS zsm_sapcode,
       b.mobile_no       AS zsm_mobile_no,
       b.email_id        AS zsm_email_id,
       a.manager1_code   AS rm_empcode,
       a.manager1_name   AS rm_name,
       a.manager1_location AS rm_location,
       a.manager1_sap_code AS rm_sapcode,
       c.mobile_no       AS rm_mobile_no,
       c.email_id        AS rm_email_id,
       a.emp_code        AS tm_empcode,
       a.emp_name        AS tm_name,
       a.emp_location    AS tm_location,
       a.sap_code        AS tm_sapcode,
       d.mobile_no       AS tm_mobile_no,
       d.email_id        AS tm_email_id
FROM field_structure_infinity a
LEFT JOIN vw_emp_email_mobile b ON a.manager2_code::text = b.emp_code::text
LEFT JOIN vw_emp_email_mobile c ON a.manager1_code::text = c.emp_code::text
LEFT JOIN vw_emp_email_mobile d ON a.emp_code::text = d.emp_code::text
LEFT JOIN (
    SELECT DISTINCT zsm.manager1_code AS emp_code,
           zsm.manager1_name     AS emp_name,
           zsm.manager1_location AS emp_location,
           zsm.manager1_sap_code AS sap_code,
           ee.mobile_no,
           ee.email_id,
           zsm.emp_code          AS zsm_emp_code
    FROM field_structure_infinity zsm
    LEFT JOIN vw_emp_email_mobile ee ON zsm.manager1_code::text = ee.emp_code::text
    WHERE zsm.emp_location_type::text = 'Zone'::text
) nsm ON nsm.zsm_emp_code::text = a.manager2_code::text
WHERE a.emp_location_type::text = 'Territory'::text;

-- Every NSM / ZSM / RM / TM in the hierarchy who has a mobile number (one row per role they appear in).
CREATE VIEW vw_infinity_users AS
SELECT division_code, user_type, empcode, user_name, user_location, sapcode, mobile_no, email_id
FROM (
    SELECT DISTINCT division_code, 'NSM'::text AS user_type, nsm_empcode AS empcode, nsm_name AS user_name,
           nsm_location AS user_location, nsm_sapcode AS sapcode, nsm_mobile_no AS mobile_no, nsm_email_id AS email_id
    FROM vw_tm_hierarchy
    UNION ALL
    SELECT DISTINCT division_code, 'ZSM'::text, zsm_empcode, zsm_name, zsm_location, zsm_sapcode, zsm_mobile_no, zsm_email_id
    FROM vw_tm_hierarchy
    UNION ALL
    SELECT DISTINCT division_code, 'RM'::text, rm_empcode, rm_name, rm_location, rm_sapcode, rm_mobile_no, rm_email_id
    FROM vw_tm_hierarchy
    UNION ALL
    SELECT DISTINCT division_code, 'TM'::text, tm_empcode, tm_name, tm_location, tm_sapcode, tm_mobile_no, tm_email_id
    FROM vw_tm_hierarchy
) aa
WHERE mobile_no IS NOT NULL;

-- ── Built-in client: this service's own admin page (only for is_service_admin accounts) ──
INSERT INTO clients (client_id, name, allowed_usertypes, token_ttl)
VALUES ('admin-console', 'Central User Service Admin', ARRAY['nsm', 'zsm', 'rm', 'tm', 'bu-head', 'admin'], '8h')
ON CONFLICT (client_id) DO UPDATE SET allowed_usertypes = EXCLUDED.allowed_usertypes;
