#!/usr/bin/env bash
# Deploys the Central User Service on the production server (192.168.3.112). Run by
# .github/workflows/deploy-prod.yml on the self-hosted runner, as the Linux user that owns the
# central-user-service pm2 process (root).
#
#   scripts/deploy-prod.sh <checkout folder>
#
# Environment:
#   PROD_APP_DIR        the confirmed app folder (GitHub repository variable). Detected from pm2 on
#                       every run; a difference stops the deploy before anything is changed.
#   DRY_RUN=true        checks only, changes nothing
#   GITHUB_SHA          commit being deployed (names the backup folder)
#   PM2_BIN             pm2 to use (default: pm2 on PATH); must match the running daemon
#   PROD_BACKUP_DIR     where backups go (default /var/backups/central-user-service, root-only)
#
# Order: checks -> release (copy, install) -> backups (database, app incl. .env and keys) ->
# schema (db/schema.sql, re-runnable, one transaction) -> app files -> pm2 reload -> health and
# signing-key check. A failed health check puts the previous app back. The database is never
# rolled back automatically; the dump taken before the schema step is printed for a manual restore.
#
# Never touches the server's .env, keys/ (the token signing key), logs/, apache/, Apache or pm2
# configuration, or the other apps on this server.
set -euo pipefail

SRC=$(cd "${1:?usage: deploy-prod.sh <checkout folder>}" && pwd)
APP=central-user-service
SITE=users.wockregenerative.com
PORT_DEFAULT=5020
DB_EXPECTED=central_user_db
KEEP_BACKUPS=10
case "${DRY_RUN:-}" in 1 | true | yes) DRY=1 ;; *) DRY=0 ;; esac
SHA=${GITHUB_SHA:-manual}
SHA=${SHA:0:7}
# Server-only files the deploy leaves exactly as they are.
KEEP=(--exclude '/.env*' --exclude /keys --exclude /logs --exclude /apache)

step() { echo; echo "==> $*"; }
fail() { echo "::error::$*" >&2; exit 1; }
strip() { local p=$1; while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p=${p%/}; done; printf '%s' "$p"; }

# ---------------------------------------------------------------------------------------------
step "Tools"
for t in node npm rsync curl tar; do command -v "$t" >/dev/null || fail "$t is not installed or not on the runner's PATH"; done
PM2=${PM2_BIN:-pm2}
command -v "$PM2" >/dev/null || fail "pm2 not found ($PM2); set PM2_BIN to the pm2 that matches the running daemon"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || fail "Node.js 20+ is needed, found $(node -v)"
PG_DUMP=${PG_DUMP:-}
if [ -z "$PG_DUMP" ]; then
  for v in 18 17; do [ -x "/usr/lib/postgresql/$v/bin/pg_dump" ] && { PG_DUMP=/usr/lib/postgresql/$v/bin/pg_dump; break; }; done
  [ -n "$PG_DUMP" ] || PG_DUMP=$(command -v pg_dump || true)
fi
[ -n "$PG_DUMP" ] || fail "pg_dump is not installed (install postgresql-client-17)"
pg_major=$("$PG_DUMP" --version | grep -oE '[0-9]+' | head -1)
[ "$pg_major" -ge 17 ] || fail "pg_dump $pg_major cannot back up the PostgreSQL 17 database; install postgresql-client-17"
echo "node $(node -v), pm2 $("$PM2" -v), $("$PG_DUMP" --version)"

# ---------------------------------------------------------------------------------------------
step "Server path"
LIVE=$("$PM2" jlist 2>/dev/null | node -e '
  let s = ""
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const list = JSON.parse(s.slice(s.indexOf("[")) || "[]")
    const app = list.find((p) => p.name === process.argv[1])
    process.stdout.write(app ? app.pm2_env.pm_cwd : "")
  })' "$APP" || true)
[ -n "$LIVE" ] || fail "pm2 has no process named $APP for user $(id -un). The runner must run as the user that owns it."
LIVE=$(strip "$LIVE")
echo "detected app folder: $LIVE"
if [ "$(strip "${PROD_APP_DIR:-}")" != "$LIVE" ]; then
  echo "configured:          PROD_APP_DIR='${PROD_APP_DIR:-}'"
  fail "Confirm the path: set the GitHub repository variable PROD_APP_DIR=$LIVE (Settings > Secrets and variables > Actions > Variables), then run again. Nothing was changed."
fi

# ---------------------------------------------------------------------------------------------
step "Checks"
ENV_FILE=$LIVE/.env
[ -f "$ENV_FILE" ] || fail "$ENV_FILE is missing"
envval() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -1 | cut -d= -f2- | tr -d '\r' | sed -E 's/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/'; }
PORT=$(envval PORT); PORT=${PORT:-$PORT_DEFAULT}
DATABASE_URL=$(envval DATABASE_URL)
[ -n "$DATABASE_URL" ] || fail "DATABASE_URL is missing from $ENV_FILE"
DB_NAME=$(DATABASE_URL=$DATABASE_URL node -p 'decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1))')
DB_HOST=$(DATABASE_URL=$DATABASE_URL node -p 'new URL(process.env.DATABASE_URL).hostname')
[ "$DB_NAME" = "$DB_EXPECTED" ] || fail "DATABASE_URL points to '$DB_NAME', expected $DB_EXPECTED"
# The signing key: a new one would sign everybody out of every app. It must exist and stay put.
KEYS_VAL=$(envval KEYS_DIR)
if [ -n "$KEYS_VAL" ]; then KEYS=$(strip "$(cd "$LIVE" && node -p 'require("path").resolve(process.argv[1])' "$KEYS_VAL")"); else KEYS=$LIVE/keys; fi
case "$KEYS/" in
  "$LIVE/keys/") ;;
  "$LIVE"/*) fail "KEYS_DIR resolves to $KEYS, inside the app folder, which every deploy replaces. Use $LIVE/keys or a folder outside it." ;;
esac
[ -f "$KEYS/private.pem" ] || fail "$KEYS/private.pem is missing. Starting without it would make a new key and sign everybody out. Put the key back first."
for f in package.json package-lock.json ecosystem.config.cjs src/server.js db/schema.sql public/admin/index.html; do
  [ -f "$SRC/$f" ] || fail "checkout is incomplete: $f is missing"
done
[ ! -e "$SRC/.env" ] && [ ! -e "$SRC/keys" ] || fail "the checkout contains .env or keys/; production keeps its own"
[ -w "$LIVE" ] || fail "$LIVE is not writable by $(id -un)"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || echo "::warning::$APP is not healthy before the deploy (http://127.0.0.1:$PORT/health)"
echo "database $DB_NAME on $DB_HOST, port $PORT, signing key $KEYS/private.pem, commit $SHA"

# Release folder: the checkout without git, CI and local build files; the live app is not touched.
REL=$(mktemp -d)
trap 'rm -rf -- "$REL"' EXIT
rsync -a --exclude /.git --exclude /.github --exclude /deploy --exclude /node_modules "${KEEP[@]}" "$SRC/" "$REL/"

if [ "$DRY" = 1 ]; then
  step "Dry run: what a real run would change (node_modules not listed)"
  rsync -ani --delete "${KEEP[@]}" --exclude /node_modules "$REL/" "$LIVE/" | grep -v '^\.' | head -80 || true
  echo; echo "Dry run passed. Nothing was changed."
  exit 0
fi

# ---------------------------------------------------------------------------------------------
step "Install packages (in the release folder; the live app is not touched yet)"
(cd "$REL" && npm ci --omit=dev --no-audit --no-fund)

# ---------------------------------------------------------------------------------------------
BK_ROOT=${PROD_BACKUP_DIR:-/var/backups/central-user-service}
BK=$BK_ROOT/$(TZ=Asia/Kolkata date +%Y%m%d-%H%M%S)-$SHA
step "Backups -> $BK"
# The dump holds users' data and app.tgz the .env and signing key: readable by the deploy user only.
mkdir -p "$BK_ROOT" && chmod 700 "$BK_ROOT"
(umask 077 && mkdir -p "$BK")
# The password goes through the environment, not the command line (where `ps` would show it).
DB_URL_NOPASS=$(DATABASE_URL=$DATABASE_URL node -p 'const u = new URL(process.env.DATABASE_URL); u.password = ""; u.toString()')
PGPASSWORD=$(DATABASE_URL=$DATABASE_URL node -p 'decodeURIComponent(new URL(process.env.DATABASE_URL).password)') \
  "$PG_DUMP" -Fc -f "$BK/db.dump" -d "$DB_URL_NOPASS"
tar -czf "$BK/app.tgz" -C "$LIVE" --exclude=./node_modules --exclude=./logs .
if [ "$KEYS" != "$LIVE/keys" ]; then (umask 077 && cp -a "$KEYS" "$BK/keys"); fi
ls -la "$BK" | tail -n +2
find "$BK_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??????-*' | sort | head -n -"$KEEP_BACKUPS" | while read -r old; do
  echo "removing old backup $old"; rm -rf -- "$old"
done

# The key the apps check tokens against, before and after: it must not change.
kid() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/.well-known/jwks.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).keys[0].kid)}catch{}})' || true; }
KID_BEFORE=$(kid)

ready() {
  for _ in $(seq 1 30); do
    sleep 2
    curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"status":"ok"' && return 0
  done
  return 1
}

restore_app() {
  echo "::warning::Putting the previous version back"
  local old; old=$(mktemp -d)
  tar -xzf "$BK/app.tgz" -C "$old"
  (cd "$old" && npm ci --omit=dev --no-audit --no-fund)
  rsync -a --delete "${KEEP[@]}" "$old/" "$LIVE/"
  rm -rf -- "$old"
  "$PM2" reload "$APP"
  if ready; then echo "previous version is running again"; else echo "::error::previous version is not healthy either: check pm2 logs $APP"; fi
}

# ---------------------------------------------------------------------------------------------
step "Database schema (db/schema.sql)"
# Every statement is re-runnable (IF NOT EXISTS, views re-created); sent as one query, it applies
# in a single transaction, so a failure leaves the database as it was.
(cd "$REL" && DATABASE_URL=$DATABASE_URL node -e '
  const { Client } = require("pg")
  const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 })
  c.connect()
    .then(() => c.query(require("fs").readFileSync("db/schema.sql", "utf8")))
    .then(() => c.end())
    .then(() => console.log("schema applied"))
    .catch((e) => { console.error(e.message); process.exit(1) })
') || fail "db/schema.sql failed; nothing was changed (the app was not touched). Backup: $BK/db.dump"

# ---------------------------------------------------------------------------------------------
step "App"
rsync -a --delete "${KEEP[@]}" "$REL/" "$LIVE/"
mkdir -p "$LIVE/logs"
"$PM2" reload "$APP"
if ! ready; then
  "$PM2" logs "$APP" --lines 40 --nostream || true
  restore_app
  fail "new version did not become healthy on port $PORT. Previous version restored; database backup: $BK/db.dump"
fi
KID_AFTER=$(kid)
if [ -n "$KID_BEFORE" ] && [ "$KID_AFTER" != "$KID_BEFORE" ]; then
  restore_app
  fail "the signing key changed ($KID_BEFORE -> $KID_AFTER), which signs everybody out. Previous version restored; check $KEYS."
fi
echo "healthy: $(curl -fsS "http://127.0.0.1:$PORT/health"), signing key ${KID_AFTER:-?}"

# Through Apache, as a browser reaches it. Nothing of Apache changed, so this only warns.
via=$(curl -sS --max-time 10 --resolve "$SITE:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$SITE/health" 2>/dev/null || echo 000)
echo "https://$SITE/health -> $via"
[ "$via" = 200 ] || echo "::warning::https://$SITE/health answered $via from the server itself; open the admin page in a browser to check."

# ---------------------------------------------------------------------------------------------
step "Deployed $SHA"
echo "app:     $LIVE"
echo "backups: $BK"
