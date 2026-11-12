#!/usr/bin/env bash
# Rebuild v1 + v2 migrations, apply both to a fresh copy of the production-schema clone (prodclone), load the
# harness, copy to $1 (default ssd_t). Production's protected-function names are seeded so the v2 guard is real.
set -euo pipefail
export PGCLIENTENCODING=UTF8
D="$(cd "$(dirname "$0")" && pwd)"; P="C:/Program Files/PostgreSQL/18/bin/psql.exe"; DB="${1:-ssd_t}"
M="$D/../../migrations"
node "$D/build.cjs" 20261117120000 >/dev/null
node "$D/build_v2.cjs" >/dev/null
"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS ssd_base WITH (FORCE)" -c "CREATE DATABASE ssd_base TEMPLATE prodclone" 2>&1 | grep -v NOTICE || true
"$P" -h localhost -p 55432 -U postgres -d ssd_base -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO public.protected_functions (identity, schema_name, func_name, definition, definition_md5) SELECT 'public.' || n || '()', 'public', n, '', '' FROM unnest(string_to_array('_is_landlord_payout_owner,allow_landlord_payouts_with_exception,allow_landlord_payouts_with_exception_unchecked,check_landlord_payout_eligibility,enforce_landlord_payout_eligibility,get_cto_controlled_plan_collections,get_landlord_payout_agent_rates,get_landlord_payout_block_queue,get_landlord_payout_budget,get_landlord_payout_renewals,guard_landlord_payouts_switch,landlord_payout_allowed_today,landlord_payout_goal_allowed,landlord_payout_goal_started_at,landlord_payout_queue_blocked,landlord_payouts_blocked_from_queue,reject_landlord_payouts,set_landlord_payout_block_exemption,set_landlord_payout_block_exemption_unchecked,set_landlord_payout_budget,set_landlord_payout_budget_unchecked', ',')) n" >/dev/null
"$P" -h localhost -p 55432 -U postgres -d ssd_base -X -q -v ON_ERROR_STOP=1 -1 -f "$M/20261117120000_self_support_merchant_direct.sql" >/dev/null
# production reverted v1 on its three protected functions (protected_functions_guard); do the same here
for f in enforce_landlord_payout_eligibility landlord_payout_allowed_today landlord_payout_goal_allowed; do
  { cat "$D/live/$f.def.sql"; echo ";"; } | "$P" -h localhost -p 55432 -U postgres -d ssd_base -X -q -v ON_ERROR_STOP=1 >/dev/null
done
"$P" -h localhost -p 55432 -U postgres -d ssd_base -X -q -v ON_ERROR_STOP=1 -1 -f "$M/20261117140000_self_support_activate_on_landlord_paid.sql" >/dev/null
"$P" -h localhost -p 55432 -U postgres -d ssd_base -X -q -v ON_ERROR_STOP=1 -f "$D/harness.sql" >/dev/null
"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE ssd_base" 2>&1 | grep -v NOTICE || true
