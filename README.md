# Central User Service

One login service for Wockhardt field users (**NSM, ZSM, RM, TM**) and app staff (**BU heads, admins**), shared by every project.
Before this, each project kept its own users table filled with the same field data. With this
service, the field data lives in one database (`central_user_db`). Projects send their users here
to sign in, and get back a signed token they can trust.

- **Login:** mobile number → 6-digit OTP by email → token. This is the same flow as Online and BIONX PULSE.
- **Token:** an RS256 JWT for the calling app (`aud` = the app's `client_id`). The app verifies
  it locally with the service's public key (`/.well-known/jwks.json`). The app never holds a
  signing secret and does not call the service on every request.
- **Data:** the Infinity field-structure report, the same source and tables as Online
  (`field_structure_infinity`, `vw_tm_hierarchy`, `vw_infinity_users`). People who leave the
  structure are deactivated automatically.
- **Admin page** at `/admin`: users, divisions and Infinity sync, client apps and API keys, and login history.

Stack: Node 20+, Express, PostgreSQL. It is a single process and needs no build step.

## Layout

```
src/server.js           app entry (routes below)
src/routes/auth.js      /api/auth/*    login: OTP request / verify, /me, public key
src/routes/clientApi.js /api/v1/*      server-to-server lookups for apps (API key)
src/routes/admin.js     /api/admin/*   admin page API
src/sync.js             Infinity sync, account rebuild, copy from Online
src/keys.js             RSA signing key (generated into keys/ on first start)
db/schema.sql           tables + views (safe to re-run)
db/init.js              create database, schema, first admin
db/seed-from-online.js  copy divisions + field structure from Online's d2d_portal (read-only)
db/add-client.js        register a client app from the command line
db/import-staff.js      copy an app's BU heads / admins from its own users table (read-only)
public/admin/           admin page (plain HTML/JS)
examples/express-auth.js  token check to copy into a client app
```

## Local setup (this PC)

```bash
npm install
cp .env.example .env          # local values: DATABASE_URL on 127.0.0.1, OTP_DELIVERY=console
npm run db:init               # creates central_user_db on the local Postgres + admin from ADMIN_*
npm run db:seed-online        # copies BIOSCIENCES (85) + RESPIRATORY (A5) from d2d_portal, read-only
npm start                     # http://localhost:5020/admin
```

`OTP_DELIVERY=console` prints OTPs in the service log instead of emailing them, so local tests
never mail real field users. `db:init` and `db:seed-online` refuse to write to a database that
is not on this machine unless you add `--production`.

## Deploying

`node scripts/make-deploy.cjs` builds `deploy/central-user-service/` and `deploy/central-user-service.zip`. They contain the production `.env` and a production signing key that is kept across rebuilds. **DEPLOY.md** is the step-by-step guide for the Ubuntu server (192.168.3.112).

## Moving to the production server

1. **Back up the local database:**
   ```bash
   D:\Lavkush\pg\pgsql\bin\pg_dump.exe -h 127.0.0.1 -U postgres -Fc -d central_user_db -f central_user_db.dump
   ```
2. **Restore it on the production server** (192.168.1.76). This creates a new database and touches no other database:
   ```bash
   createdb -h 192.168.1.76 -U postgres central_user_db
   pg_restore -h 192.168.1.76 -U postgres -d central_user_db --no-owner central_user_db.dump
   ```
3. **Set up the app server.** Copy the project (without `node_modules`), run `npm ci --omit=dev`, and create `.env` from `.env.example`:
   - `DATABASE_URL` → the production database
   - `OTP_DELIVERY=email`
   - `PUBLIC_URL` → the service's https URL (this becomes the token issuer)
   - `INFINITY_API_HEADER_NAME` / `INFINITY_API_TOKEN`, if Infinity needs them
4. **Start it:** `pm2 start ecosystem.config.cjs && pm2 save`, then put Apache in front of it (reverse proxy to `127.0.0.1:5020`).
5. **The signing key** is created in `keys/` on first start. Keep `keys/private.pem` across redeploys and back it up, because a new key signs everyone out of every app. Never commit it (`keys/` is git-ignored).

## Roles

- **Field users** (`nsm`, `zsm`, `rm`, `tm`) come from the Infinity sync, or are added by hand.
- **App staff** (`bu-head`, `admin`) belong to a division, e.g. BIONX PULSE's BU heads under `AESTHETICS`. Which roles may use an app is set on its client entry (**Allowed roles**).
- **Service admin** is a separate tick box on any account. It opens this service's own admin page (`/admin`), whatever the person's role. `npm run db:init` gives it to `ADMIN_MOBILE`.

To move an app's existing staff here, read them from its users table (read-only):

```bash
npm run db:import-staff -- --source=BIONX_USERS_DATABASE_URL --division=AESTHETICS --source-division=AESTHETICS
```

The match is by mobile number: an existing manual account is updated, and an active Infinity field user is never overwritten.

## Field data: Synapse (main source)

Azure Synapse (`WH_SAPdataAnalytics`) holds Infinity's field structure for every division in `dbo.Field_Structure`, with the same columns as the Infinity API. So no Infinity division id or API token is needed. The service only reads it.

```bash
npm run db:sync-synapse                      # all sales divisions (new ones are added)
npm run db:sync-synapse -- --divisions=A8,85
```

On the admin page, use **Divisions & sync** → **Sync all divisions from Synapse**, or the per-division button. It loads the 8 sales divisions:

| Code | Division |
|---|---|
| A8 | AESTHETICS (BIONX PULSE) |
| 78 | BIOPHARMA |
| 85 | BIOSCIENCES |
| 91 | INSTITUTION |
| 83 | PHARMA |
| 84 | RESEARCH |
| A5 | RESPIRATORY |
| A7 | SPECIALITY |

Divisions with code `0` (MARKET ACCESS, NEPAL, TEST…) share one code and are left out. Settings: `SYNAPSE_*` in `.env`.

Accounts come from `vw_infinity_users` plus each person's own row by job role (NSM / ZSM / RM / TM). This means an NSM above vacant zones, who is missing from the view, still gets an account.

## Adding divisions

- **Divisions in Online** (85, A5): seeded by `db:seed-online`. After that, use **Sync from Infinity** on the admin page.
- **A new division (e.g. AESTHETICS):**
  1. On the admin page, open **Divisions & sync** and add the division code, its name and its Infinity division id (`divsn…`).
  2. Click **Sync from Infinity**.
- **Safeguards:** an empty or failed Infinity response changes nothing. People listed with no valid mobile number or email are skipped, and the reason is shown in the sync history.
- **Disabling a person:** do it on the admin page. They stay disabled through later syncs until an admin enables them again.

## Connecting an app

### 1. Register the app

On the admin page, open **Client apps**, or use the command line:

```bash
npm run client:add -- bionx-pulse "BIONX PULSE" --divisions=AESTHETICS --origins=https://bionxpulse.wockregenerative.com
```

- The **client_id** (`bionx-pulse`) is public. It goes into the token as `aud`.
- The **name** appears in the OTP email ("Your one-time password to sign in to BIONX PULSE").
- Allowed **roles** and **divisions** decide who may sign in to this app.
- **Origins** let the app's browser frontend call the login API directly (CORS).
- The **API key** is shown once and is only needed for `/api/v1` calls. Store it in the app's `.env`.

### 2. Sign in (the app's frontend, or its backend acting for it)

```http
POST /api/auth/otp/request   { "client_id": "bionx-pulse", "mobileno": "9876543210" }
→ 200 { "sent": true, "email": "r***@wockhardt.com", "expires_in_minutes": 10, "resend_in_seconds": 30 }

POST /api/auth/otp/verify    { "client_id": "bionx-pulse", "mobileno": "9876543210", "otp": "123456" }
→ 200 { "token": "<JWT>", "token_type": "Bearer", "expires_in": 43200, "user": { ... } }
```

Errors return `{ "error": "<message shown to the user>" }`:

| Status | Meaning |
|---|---|
| 400 | Bad input or unknown app |
| 401 | Wrong or expired OTP. Five wrong tries cancel the OTP. |
| 403 | The user may not use this app (role or division) |
| 404 | No active account with this mobile number |
| 429 | Asked again within 30 s, or rate-limited |

### 3. Use the token in the app's backend

Send it as `Authorization: Bearer <token>`. Verify it with `examples/express-auth.js`, which checks the signature, the issuer, the expiry and that `aud` is this app:

```js
// .env: USER_SERVICE_URL=https://<service host>   USER_SERVICE_CLIENT_ID=bionx-pulse
const { requireFieldUser } = require('./express-auth');
app.use('/api', requireFieldUser());
app.get('/api/team', requireFieldUser({ roles: ['rm', 'zsm', 'nsm'] }), handler);  // req.fieldUser
```

Token claims and the `user` object:

```json
{ "sub": "<user id>", "empcode": "834715", "name": "…", "usertype": "tm", "division_code": "A5",
  "division_name": "RESPIRATORY", "mobileno": "…", "email": "…", "location": "…", "sap_code": "…",
  "managers": { "rm": { "empcode": "…", "name": "…" }, "zsm": { … }, "nsm": { … } } }
```

The token lasts for the app's token lifetime (12 h by default). The app can check sooner whether an account was disabled: `GET /api/auth/me` with the token, or `POST /api/v1/token/introspect`.

### 4. Server-to-server lookups (optional)

These need the headers `X-Client-Id: bionx-pulse` and `X-Api-Key: cus_…`. Results are limited to the app's roles and divisions.

| Endpoint | Returns |
|---|---|
| `POST /api/v1/token/introspect { token }` | `{ active, user }` (also checks that the account is still active) |
| `GET /api/v1/users?division_code=&usertype=&q=&active=` | users |
| `GET /api/v1/users/:empcode` | one user with their managers |
| `GET /api/v1/users/:empcode/team` | territories and people under them (for data scoping) |
| `GET /api/v1/hierarchy?division_code=` | `vw_tm_hierarchy` rows, one per territory |

## Security notes

- OTPs are stored only as SHA-256 hashes, tied to the app that requested them, and expire in 10 minutes. They are used once, with a 30 s resend gap and 5 wrong tries at most.
- API keys are stored as hashes. Rotating a key on the admin page stops the old one immediately.
- Every OTP request and sign-in attempt is logged with the app, user, result and IP (**Login history**).
- The admin API accepts only tokens issued to `admin-console` for service admins.
- An app's backend that signs users in for them sends its `X-Client-Id` / `X-Api-Key` with the OTP calls. The per-IP rate limit is then skipped, because all its users share the server's IP. The per-account limits still apply.
- The service re-reads the account on `/me`, introspect and every admin call, so a deactivation takes effect at once.
