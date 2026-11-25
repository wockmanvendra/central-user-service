# Automatic production deploy: setup on 192.168.3.112

After this setup, **pushing to the `production` branch deploys the Central User Service by itself**.
A second GitHub Actions runner on the production server (next to Regen's `regen-prod-112`) does the work:

1. checks the code (syntax);
2. backs up the database (`central_user_db`) and the app folder, including `.env` and the signing key;
3. installs packages and applies `db/schema.sql` (re-runnable, one transaction);
4. copies the new files in and reloads `central-user-service`;
5. checks it is healthy and that the signing key did not change, and puts the previous version back if not.

The workflow is `.github/workflows/deploy-prod.yml`; the server steps are `scripts/deploy-prod.sh`.
The server keeps its own `.env` and `keys/`. No keys or passwords are stored in GitHub.

## This server

| | |
|---|---|
| User that runs pm2 (and the runner) | `root` |
| pm2 daemon | 6.0.13: `/root/.nvm/versions/node/v20.19.5/bin/pm2` |
| `central-user-service` | folder `/var/www/html/central-user-service`, port 5020 |
| Database | `central_user_db` on 192.168.1.76 (PostgreSQL 17; `pg_dump` 17 is installed for Regen) |
| Backups | `/var/backups/central-user-service/<date>-<commit>/`, root only, last 10 kept |

## 1. GitHub runner

A runner serves one repository, so this one is separate from Regen's (`/root/actions-runner`).

1. In GitHub open **central-user-service → Settings → Actions → Runners → New self-hosted runner** (Linux, x64).
2. Copy the token from the `./config.sh` line on that page. It expires after an hour.
3. Run, as root:

```bash
mkdir -p /root/actions-runner-cus && cd /root/actions-runner-cus
TGZ=$(ls /root/actions-runner/actions-runner-linux-x64-*.tar.gz 2>/dev/null | tail -1)
if [ -n "$TGZ" ]; then tar xzf "$TGZ"; else
  curl -fsSL -o runner.tgz https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-x64-2.338.2.tar.gz && tar xzf runner.tgz && rm runner.tgz
fi
export RUNNER_ALLOW_RUNASROOT=1                       # pm2 runs as root, so the runner must too
export PATH=/root/.nvm/versions/node/v24.15.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
./config.sh --url https://github.com/wockmanvendra/central-user-service --token <TOKEN> \
  --name cus-prod-112 --labels cus-prod --unattended
cat >> .env <<'EOF'
RUNNER_ALLOW_RUNASROOT=1
PM2_BIN=/root/.nvm/versions/node/v20.19.5/bin/pm2
EOF
./svc.sh install root && ./svc.sh start && ./svc.sh status
```

GitHub then shows the runner **cus-prod-112** as *Idle*. Regen's runner is not affected.

The runner takes its `PATH` from `.path`, which `config.sh` writes from the shell above, so `node`
is Node 24. If Node or pm2 change later, edit `.path` / `.env` and run `./svc.sh stop && ./svc.sh start`.

## 2. GitHub settings (central-user-service repository)

1. **Settings → Environments → New environment → `production`.**
   - Under *Deployment branches*, choose *Selected branches* and add `production`.
   - Optional: under *Required reviewers*, add yourself. Each deploy then waits for your **Approve**.
2. **Settings → Secrets and variables → Actions → Variables.** Add:
   - `PROD_APP_DIR` = `/var/www/html/central-user-service`

The deploy finds the folder again on every run, from pm2. If it doesn't match the variable, it
stops **before changing anything** and prints what it found.

## 3. First run: dry run

The *Run workflow* button appears once the workflow file is on the default branch (`main`).
**Actions → Deploy production → Run workflow**, on branch `production`. *Dry run* is ticked by
default: it checks the server and lists the files that would change, without changing anything.
Read that list before the first real deploy: files only on the server are removed (except `.env`,
`keys/`, `logs/` and `apache/`).

---

## Every deploy

```bash
git push origin production
```

Follow it in **Actions → Deploy production**:

| Step | If it fails |
|---|---|
| Syntax check | Stops; the server is not touched |
| Checks (pm2 folder, `.env`, database name, signing key present) | Stops; the server is not touched |
| Install packages in a separate folder | Stops; the server is not touched |
| Backups: `db.dump`, `app.tgz` (with `.env` and `keys/`) | Stops; the server is not touched |
| `db/schema.sql` | Stops; the transaction is rolled back and the app is not touched |
| Copy files, `pm2 reload central-user-service`, health on port 5020, signing key unchanged | The previous version is put back and reloaded |

It never changes `.env`, `keys/`, `logs/`, `apache/`, Apache or pm2 configuration, or the other
apps on this server (BIONX PULSE, Regen).

**The database is not rolled back automatically.** To put it back as it was before a deploy:

```bash
/usr/lib/postgresql/17/bin/pg_restore --clean --if-exists -d "<DATABASE_URL from .env>" /var/backups/central-user-service/<date>-<commit>/db.dump
```

**Roll back to an earlier version.** Either:
- revert the commit and push `production` (this deploys the earlier code again); or
- unpack `app.tgz` from a backup folder over `/var/www/html/central-user-service`, then run
  `npm ci --omit=dev` there and `pm2 reload central-user-service`.
