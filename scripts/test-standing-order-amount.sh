#!/usr/bin/env bash
set -euo pipefail
# Disposable local PostgreSQL only. Never reads .env or managed PG* credentials.
root="$(pwd)"
tmp="$(mktemp -d /tmp/standing-order-db.XXXXXX)"
if [ "$(id -u)" = 0 ]; then
  chown lovable:lovable "$tmp"
  owner=(setpriv --reuid=1000 --regid=1000 --clear-groups)
  dbuser=lovable
else
  owner=()
  dbuser="$(id -un)"
fi
cleanup() {
  "${owner[@]}" pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
"${owner[@]}" initdb -D "$tmp/data" -A trust --no-locale >/dev/null
# No TCP listener: isolated Unix socket path, no automatic payer or cron loaded.
"${owner[@]}" pg_ctl -D "$tmp/data" -l "$tmp/postgres.log" -o "-k $tmp -p 55439 -c listen_addresses=''" start >/dev/null
psql_local=(psql -X -h "$tmp" -p 55439 -U "$dbuser" -d postgres -v ON_ERROR_STOP=1)
"${psql_local[@]}" -f "$root/scripts/fixtures/standing-order-amount-local.sql"
"${psql_local[@]}" -f "$root/docs/pending-migrations/standing_order_amount_edit.sql"
"${psql_local[@]}" -f "$root/scripts/fixtures/standing-order-amount-tests.sql"