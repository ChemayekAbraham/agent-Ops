#!/usr/bin/env bash
# Builds a fresh disposable database from the scaffold plus the Food migrations
# and runs the behavioural suite. Refuses anything that is not a local cluster.
#   PGHOST must be 127.0.0.1/localhost. Usage: run.sh [extra_migration.sql ...]
# psql on Windows switches to the console code page when it believes it is on a
# terminal (the NUL device counts), which mis-decodes UTF-8 migration files.
export PGCLIENTENCODING=UTF8
set -euo pipefail
case "${PGHOST:-}" in 127.0.0.1|localhost) ;; *) echo "refusing: PGHOST must be local" >&2; exit 2;; esac
# live-system protection: nothing may redirect psql away from PGHOST, and the
# production project is refused outright
[ -z "${PGHOSTADDR:-}${PGSERVICE:-}${DATABASE_URL:-}" ] || { echo "refusing: PGHOSTADDR/PGSERVICE/DATABASE_URL set" >&2; exit 2; }
case "${PGHOST:-} ${PGDATABASE:-} ${PGUSER:-}" in *wirntoujqoyjobfhyelc*) echo "refusing: production project" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../../../.."
db="food_run_$$"
P() { psql -X -v ON_ERROR_STOP=1 -q "$@"; }
P -d postgres -c "create database $db" >/dev/null
trap 'P -d postgres -c "drop database if exists $db with (force)" >/dev/null' EXIT
P -d "$db" -f "$here/00_supabase_scaffold.sql" >/dev/null
# Local stand-in for the shared ledger objects, created BEFORE the Food migrations as
# they exist before Food in production (20261013128500 attaches a guard to general_ledger).
P -d "$db" -f "$here/05_ledger_standin.sql" >/dev/null
for m in "$root"/supabase/migrations/2026100912*food*.sql "$root"/supabase/migrations/2026100913*food*.sql \
         "$root"/supabase/migrations/2026100916*food*.sql "$root"/supabase/migrations/2026100917*food*.sql \
         "$root"/supabase/migrations/202610121*food*.sql "$root"/supabase/migrations/202610131*food*.sql "$@"; do
  [ -e "$m" ] || continue
  P -d "$db" -1 -f "$m" >/dev/null && echo "applied $(basename "$m")"
done
# The shared recipient gate, loaded verbatim from drizzle/migrations/0045 (only
# welile_transfer_items and check_transfer_recipient_eligibility; the schedule
# function in that file needs tables the scaffold does not have).
sed -n '/^CREATE OR REPLACE FUNCTION public.welile_transfer_items/,/^GRANT EXECUTE ON FUNCTION public.check_transfer_recipient_eligibility/p'   "$root"/drizzle/migrations/0045_transfer_recipient_eligibility.sql | P -d "$db" >/dev/null
# The standard sender reversal and its status check, verbatim from drizzle/migrations
# 0451 and 0453 (latest definitions), so reversal tests run the real mechanism.
sed -n '/^CREATE OR REPLACE FUNCTION public.wallet_transfer_reversal_status/,/^\$function\$;/p'   "$root"/drizzle/migrations/0453_wallet_transfer_reversal_status_reversed_at.sql | P -d "$db" >/dev/null
sed -n '/^CREATE OR REPLACE FUNCTION public.reverse_wallet_transfer/,/^\$\$;/p'   "$root"/drizzle/migrations/0451_wallet_transfer_reversal_atomic_and_notify.sql | P -d "$db" >/dev/null
# The REPO definition of the Agent Advance sweep gate, loaded verbatim from its
# migration (that file also holds a sweep job later superseded; only this
# statement is taken). Proves Food payments meet the existing rule unchanged.
sed -n '/^CREATE OR REPLACE FUNCTION public.get_agent_sweepable_withdrawable/,/^\$\$;/p'   "$root"/supabase/migrations/20260719161607_12e3ac27-7b55-4c8b-8d98-f9b7ba2794b6.sql | P -d "$db" >/dev/null
# One session for all suites: later files reuse 10_behaviour.sql's helpers.
# 20_* only applies once the release-corrections migration is present.
# 08 runs first: proves install seats nobody, then appoints the synthetic stand-in
# through the supported food_bootstrap_coordinator() so later suites have a coordinator.
suites=("$here/08_appointment.sql" "$here/10_behaviour.sql")
ls "$root"/supabase/migrations/20261012120000_food_m1_release_corrections.sql >/dev/null 2>&1 \
  && suites+=("$here/20_release_corrections.sql" "$here/25_canteen_access.sql" "$here/40_completion.sql")
ls "$root"/supabase/migrations/20261013120001_food_meal_images.sql >/dev/null 2>&1   && suites+=("$here/45_meal_images.sql")
ls "$root"/supabase/migrations/20261013125000_food_staff_includes_pso.sql >/dev/null 2>&1 && suites+=("$here/46_staff_pso.sql")
ls "$root"/supabase/migrations/20261013127000_food_exception_self_resolution.sql >/dev/null 2>&1 && suites+=("$here/47_exception_controls.sql")
ls "$root"/supabase/migrations/20261013128000_food_payment_after_receipt.sql >/dev/null 2>&1 && suites+=("$here/48_payment.sql" "$here/49_advance_integration.sql" "$here/51_recipient_eligibility.sql" "$here/52_reversal.sql" "$here/53_settlement.sql" "$here/54_wallet_routing.sql" "$here/55_policy_controls.sql")
out="$(cat "${suites[@]}" | P -d "$db" 2>&1 || true)"
# Count only real psql errors ("ERROR:  ..."), never a result value that
# happens to contain the word (e.g. the ORDER_ERROR exception kind).
echo "$out" | grep -E 'NOTICE:  (PASS|FAIL)|(^|: )ERROR:  ' | sed -E 's/^(psql:[^ ]* )?NOTICE:  //'
pass=$(echo "$out" | grep -c 'NOTICE:  PASS' || true); fail=$(echo "$out" | grep -c -E 'NOTICE:  FAIL|(^|: )ERROR:  ' || true)
echo "== $pass passed, $fail failed"
[ "$fail" -eq 0 ]
