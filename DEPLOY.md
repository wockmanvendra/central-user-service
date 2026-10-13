# Central User Service: deploy on the Ubuntu server (192.168.3.112)

Run the blocks **in order**, and paste **each block whole**. Every block checks before it acts: if something is wrong it prints **STOP** and changes nothing. Nothing is permanently deleted until the very end.

| | |
|---|---|
| Website (admin page) | https://users.wockregenerative.com/admin |
| App folder | `/var/www/html/central-user-service` |
| Fresh copy used to install | `/root/central-user-service-new` (created in step 2) |
| pm2 app | `central-user-service` on `127.0.0.1:5020` (other pm2 apps are not touched) |
| Database | `central_user_db` on 192.168.1.76 (already created and filled) |
| Apache site | `users.wockregenerative.com.conf` (same wildcard certificate as BIONX PULSE) |

- **Part A** installs the central service.
- **Part B** switches BIONX PULSE's login over to it. Do Part B only after Part A works.

> Do **not** run `pm2 update`: it restarts every app on this server.

---

# Part A: the Central User Service

## Step 1: before you start (one time)

1. **DNS:** ask IT for a DNS record **`users.wockregenerative.com`** pointing at the same address as `bionxpulse.wockregenerative.com`. The wildcard certificate already covers it.
   - BIONX reaches the service locally (`127.0.0.1`), so BIONX login works even before the DNS record exists.
   - Only the admin page in your browser needs it.
2. **Database access:** `pg_hba.conf` on 192.168.1.76 must have the line for this server. You added it already:
   ```
   host    central_user_db    postgres    192.168.3.112/32    scram-sha-256
   ```
3. **On your PC:** build the deploy folder and zip. The zip is `D:\Lavkush\central-user-service\deploy\central-user-service.zip`.
   ```
   cd D:\Lavkush\central-user-service
   node scripts/make-deploy.cjs
   ```

## Step 2: upload and unpack the fresh copy

1. With WinSCP, upload `central-user-service.zip` to **`/root/central-user-service.zip`** on the server.
2. Paste:

```bash
test -f /root/central-user-service.zip || { echo "STOP: /root/central-user-service.zip not found"; false; } && \
(command -v unzip >/dev/null || sudo apt install -y unzip) && \
sudo rm -rf /root/central-user-service-unzip /root/central-user-service-new && \
sudo unzip -q /root/central-user-service.zip -d /root/central-user-service-unzip && \
sudo mv /root/central-user-service-unzip/central-user-service /root/central-user-service-new && \
sudo rm -rf /root/central-user-service-unzip && \
echo "OK: fresh copy at /root/central-user-service-new"
```

## Step 3: check the fresh copy and the server

```bash
cd /root && \
for f in src/server.js .env keys/private.pem package.json ecosystem.config.cjs public/admin/index.html node_modules/express/package.json node_modules/pg/package.json node_modules/mssql/package.json; do
  if test -e "/root/central-user-service-new/$f"; then echo "ok       $f"; else echo "MISSING  $f"; fi
done; \
echo "node $(node -v)"; \
if ss -ltnp 2>/dev/null | grep -q ':5020 '; then echo "port 5020: IN USE - $(ss -ltnp | grep ':5020 ')"; else echo "port 5020: free"; fi
```

You should see:
- **9 lines starting with `ok`**,
- **node v18 or newer**,
- **port 5020: free**. When **updating**, it shows `IN USE` by `central-user-service`; that is fine.

If anything differs, stop here.

Now check that this server can reach the database:

```bash
cd /root/central-user-service-new && \
node -e "require('dotenv').config({quiet:true}); const {Client}=require('pg'); const c=new Client(process.env.DATABASE_URL); c.connect().then(()=>c.query('SELECT COUNT(*) FILTER (WHERE is_active) AS users FROM users')).then(r=>{console.log('OK: database reachable, active users:', r.rows[0].users); return c.end()}).catch(e=>{console.log('STOP: database not reachable -', e.message); process.exit(1)})"
```

It must print **`OK: database reachable, active users: …`**. If it says `no pg_hba.conf entry`, add the line from step 1 on 192.168.1.76 and reload its configuration.

## Step 4: install (first time, or update)

This block:
- keeps an existing install aside as `…previous-<date>`,
- copies the fresh copy in,
- **keeps the server's signing key** if there was an install before. Keeping the key means nobody is signed out of any app.

```bash
pm2 stop central-user-service 2>/dev/null; \
test -d /root/central-user-service-new/src || { echo "STOP: fresh copy missing (step 2)"; false; } && \
STAMP=$(date +%Y%m%d-%H%M%S) && \
if test -e /var/www/html/central-user-service; then \
  sudo mv /var/www/html/central-user-service /var/www/html/central-user-service.previous-$STAMP && \
  echo "kept the old install as /var/www/html/central-user-service.previous-$STAMP"; \
fi && \
sudo cp -a /root/central-user-service-new /var/www/html/central-user-service && \
OLD=/var/www/html/central-user-service.previous-$STAMP && \
if sudo test -f "$OLD/keys/private.pem"; then \
  sudo cp -a "$OLD/keys/." /var/www/html/central-user-service/keys/ && echo "kept the server's signing key"; \
fi && \
sudo mkdir -p /var/www/html/central-user-service/logs && \
sudo chmod 600 /var/www/html/central-user-service/.env /var/www/html/central-user-service/keys/private.pem && \
echo "OK: installed at /var/www/html/central-user-service"
```

## Step 5: start it with pm2

```bash
cd /var/www/html/central-user-service && \
(pm2 delete central-user-service 2>/dev/null; true) && \
pm2 start ecosystem.config.cjs && \
pm2 save && \
sleep 4 && \
curl -s localhost:5020/health; echo
```

The last line must show **`{"status":"ok","db":"ok",…}`**. If it doesn't, run this and send the output:

```bash
pm2 logs central-user-service --lines 40 --nostream
```

## Step 6: Apache site

```bash
if ! sudo test -f /etc/ssl/certs/wildcard_wockregenerative_com_fullchain.crt || ! sudo test -f /etc/ssl/private/wildcard.wockregenerative.com.key; then
  echo "STOP: wildcard certificate files not found"
elif ! test -f /var/www/html/central-user-service/apache/users.wockregenerative.com.conf; then
  echo "STOP: Apache site file missing from the install (step 4)"
else
  sudo cp /var/www/html/central-user-service/apache/users.wockregenerative.com.conf /etc/apache2/sites-available/ && \
  sudo a2enmod proxy proxy_http ssl headers rewrite >/dev/null && \
  sudo a2ensite users.wockregenerative.com.conf >/dev/null && \
  sudo apache2ctl configtest && \
  sudo systemctl reload apache2 && \
  echo "OK: Apache site enabled" && \
  curl -sk https://users.wockregenerative.com/health --resolve users.wockregenerative.com:443:127.0.0.1; echo
fi
```

You should see `Syntax OK`, **`OK: Apache site enabled`**, then **`{"status":"ok",…}`**.

## Step 7: test the admin page

This needs the DNS record from step 1.

1. Open **https://users.wockregenerative.com/admin**.
2. Sign in as **Lavkush Singh `9051817197`** or **Kiran Garud `8879088719`**. The OTP arrives **by email**.
3. **Overview** should show 8 divisions and about 660 users. Under **Client apps** you should see `bionx-pulse`.

---

# Part B: switch BIONX PULSE to the central login

BIONX's new version comes as a separate zip:
- **File:** `D:\Lavkush\bionx_champion\deploy\bionx-pulse.zip`
- **Contents:** central login, the A8 division, the full dashboard with own-territory drill-down, the RM level and the mail-cron fix.

Its `.env` already has the central settings, but with `CENTRAL_USER_SERVICE_URL` **empty**. So BIONX keeps its own logins until step 9 switches it over.

## Step 8: update BIONX PULSE

Follow **DEPLOY2.md**, "Future updates (safe method)":
1. Upload `bionx-pulse.zip` to `/root/bionx-pulse.zip`.
2. Run DEPLOY2 steps **1 (Option B), 2, 4, 5 and 6**.
3. Check that `curl -s localhost:5010/api/health` shows `{"ok":true}`, and that BIONX login still works as before.

## Step 9: turn on the central login for BIONX

This only acts if the central service is healthy:

```bash
ENV=/var/www/html/bionx-pulse/backend/.env && \
curl -s localhost:5020/health | grep -q '"status":"ok"' || { echo "STOP: central service is not healthy (Part A)"; false; } && \
sudo grep -q '^CENTRAL_API_KEY=cus_' "$ENV" || { echo "STOP: CENTRAL_API_KEY missing in $ENV (use the new bionx-pulse.zip)"; false; } && \
sudo cp "$ENV" "$ENV.before-central" && \
sudo sed -i 's#^CENTRAL_USER_SERVICE_URL=.*#CENTRAL_USER_SERVICE_URL=http://127.0.0.1:5020#' "$ENV" && \
sudo grep '^CENTRAL_' "$ENV" | sed 's/\(CENTRAL_API_KEY=cus_\).*/\1***/' && \
pm2 restart bionx-pulse && sleep 5 && curl -s localhost:5010/api/health; echo
```

You should see:
- the five `CENTRAL_…` lines, with **`CENTRAL_USER_SERVICE_URL=http://127.0.0.1:5020`** and **`CENTRAL_ISSUER=https://users.wockregenerative.com`**,
- then **`{"ok":true}`**.

## Step 10: test BIONX login

1. Open **https://bionxpulse.wockregenerative.com** and sign in as a BU head, e.g. Kiran Garud `8879088719`.
   - The OTP email now comes from the central service: subject "BIONX PULSE - OTP Verification", sent from `MAIL_FROM` of the central service.
   - The dashboard should load as before.
2. Optional: sign in as an A8 TM. They see the whole dashboard, but only their own territory's numbers open the lists.
3. On the central admin page, **Login history** shows these sign-ins under `bionx-pulse`.

**To switch BIONX back to its own logins,** for example if the central service has a problem:

```bash
ENV=/var/www/html/bionx-pulse/backend/.env && \
sudo sed -i 's#^CENTRAL_USER_SERVICE_URL=.*#CENTRAL_USER_SERVICE_URL=#' "$ENV" && \
pm2 restart bionx-pulse && sleep 5 && curl -s localhost:5010/api/health; echo
```

---

## Step 11: clean up (only after everything works)

```bash
curl -s localhost:5020/health | grep -q '"status":"ok"' || { echo "STOP: central service is not healthy - keep the backups"; false; } && \
sudo rm -rf /var/www/html/central-user-service.previous-* /root/central-user-service.zip && \
echo "Removed old copies. Kept /root/central-user-service-new as a spare."
```

**Back up the signing key** to a safe place, outside the server, once:

```
/var/www/html/central-user-service/keys/private.pem
```

If it is lost, a new one is made on start and everybody has to sign in again in every app.

---

## Future updates

1. **On your PC:** run `node scripts/make-deploy.cjs`. It keeps the production `.env` and signing key from the last build.
2. **On the server:** upload the zip, then run **steps 2, 3, 4 and 5**. Step 4 keeps the server's signing key and the previous version.

**Going back to the previous version:**

```bash
LAST=$(ls -d /var/www/html/central-user-service.previous-* 2>/dev/null | tail -1) && \
test -n "$LAST" || { echo "STOP: no previous version kept"; false; } && \
pm2 stop central-user-service && \
sudo mv /var/www/html/central-user-service /var/www/html/central-user-service.failed-$(date +%Y%m%d-%H%M%S) && \
sudo mv "$LAST" /var/www/html/central-user-service && \
pm2 restart central-user-service && sleep 4 && curl -s localhost:5020/health; echo
```

## Settings on the server (`/var/www/html/central-user-service/.env`)

| Setting | Value |
|---|---|
| `DATABASE_URL` | `central_user_db` on 192.168.1.76 |
| `PUBLIC_URL` | `https://users.wockregenerative.com`. This is the token issuer; apps check it (BIONX: `CENTRAL_ISSUER`). |
| `OTP_DELIVERY` | `email`. OTPs go by email through the 192.168.3.9 relay, like BIONX. |
| `SYNAPSE_*` | Read-only source for **Sync from Synapse** on the admin page |
| `PORT` | `5020` |

After editing `.env`: `pm2 restart central-user-service`.
