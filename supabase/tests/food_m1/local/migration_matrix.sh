#!/usr/bin/env bash
# Food M1 migration matrix on a LOCAL disposable cluster. Each case builds its
# own database and drops it. Usage: migration_matrix.sh [old_ref]
#   old_ref: git ref holding the pre-FM-17 M1..M2 (default 8c437912da), used for
#            the "pre-existing database" upgrade case.
# psql on Windows switches to the console code page when it believes it is on a
# terminal (the NUL device counts), which mis-decodes UTF-8 migration files.
export PGCLIENTENCODING=UTF8
set -uo pipefail
case "${PGHOST:-}" in 127.0.0.1|localhost) ;; *) echo "refusing: PGHOST must be local" >&2; exit 2;; esac
# live-system protection: nothing may redirect psql away from PGHOST, and the
# production project is refused outright
[ -z "${PGHOSTADDR:-}${PGSERVICE:-}${DATABASE_URL:-}" ] || { echo "refusing: PGHOSTADDR/PGSERVICE/DATABASE_URL set" >&2; exit 2; }
case "${PGHOST:-} ${PGDATABASE:-} ${PGUSER:-}" in *wirntoujqoyjobfhyelc*) echo "refusing: production project" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../../../.." && pwd)"
old_ref="${1:-8c437912daed55ca3c7fa1e161ed32012ea8ebea}"
M="$root/supabase/migrations"
CHAIN=(20261009120001_food_service_schema_and_coordinator 20261009130001_food_service_operations_rpcs
       20261009160000_food_coordinator_candidates 20261009170000_food_exception_resolution
       20261012120000_food_m1_release_corrections 20261013120001_food_meal_images
       20261013125000_food_staff_includes_pso 20261013127000_food_exception_self_resolution
       20261013128000_food_payment_after_receipt 20261013128500_food_reversal_and_handover_controls)
P() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
Q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
result=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got: $2, expected: $3)"; result=1; fi; }
mkdb() { P -d postgres -c "drop database if exists $1 with (force)" -c "create database $1" >/dev/null; P -d "$1" -f "$here/00_supabase_scaffold.sql" >/dev/null; P -d "$1" -f "$here/05_ledger_standin.sql" >/dev/null; }
apply() { P -d "$1" -1 -f "$2" 2>&1; }   # one transaction per file, as in production
inventory() {  # schema fingerprint of everything Food owns (see inventory.sql)
  Q -d "$1" -f "$here/inventory.sql" | md5sum | cut -c1-32; }

echo "server: $(Q -d postgres -c 'show server_version')"

# ── A. fresh database WITHOUT the seed profile ──
mkdb mm_fresh
Q -d mm_fresh -c "delete from public.user_roles; delete from public.profiles; delete from auth.users" >/dev/null
ok=1; notice=""
for m in "${CHAIN[@]}"; do out=$(apply mm_fresh "$M/$m.sql") || { ok=0; echo "$out" | tail -3; }; echo "$out" | grep -q "initial coordinator NOT seeded" && notice=yes; done
check "MIG-A1 full chain applies on a fresh database with no seed profile" "$ok" "1"
check "MIG-A2 skipped seed is announced, not silent" "$notice" "yes"
check "MIG-A3 nobody is seated" "$(Q -d mm_fresh -c "select count(*) from food_coordinator_assignments")" "0"
check "MIG-A4 all 12 Food tables (incl. food_payment_attempts) exist with RLS on" "$(Q -d mm_fresh -c "select count(*) from pg_class where relname like 'food\_%' and relkind='r' and relrowsecurity")" "12"
Q -d mm_fresh -c "insert into auth.users(id,email) values ('f0000000-0000-4000-8000-0000000000e1','boot@example.invalid'); insert into profiles(id,full_name,email) values ('f0000000-0000-4000-8000-0000000000e1','BOOT','boot@example.invalid'); insert into user_roles(user_id,role) values ('f0000000-0000-4000-8000-0000000000e1','employee')" >/dev/null
check "MIG-A5 first coordinator appointed via service-role bootstrap" \
  "$(Q -d mm_fresh -c "begin; set local role service_role; select public.food_bootstrap_coordinator('f0000000-0000-4000-8000-0000000000e1','first appointment on a fresh database')->>'status'; commit;" | grep -v -E '^(BEGIN|SET|COMMIT)$')" "appointed"
fresh_fp=$(inventory mm_fresh)

# ── B. fresh database WITH the seed profile (production shape) ──
mkdb mm_seeded
ok=1; for m in "${CHAIN[@]}"; do apply mm_seeded "$M/$m.sql" >/dev/null || ok=0; done
check "MIG-B1 full chain applies with the seed profile present" "$ok" "1"
check "MIG-B2 the seed profile is the single active coordinator" \
  "$(Q -d mm_seeded -c "select string_agg(coordinator_id::text,',') from food_coordinator_assignments where revoked_at is null and access_level='active'")" \
  "29a0cfa8-1eaf-453c-874c-0fc72fa4f74b"
check "MIG-B3 schema identical to the fresh path" "$(inventory mm_seeded)" "$fresh_fp"

# ── C. PRE-EXISTING database: old M1..M4 applied and in use, then the corrections ──
mkdb mm_upgrade
tmp=$(mktemp -d)
git -C "$root" show "$old_ref:supabase/migrations/20261009120000_food_service_schema_and_coordinator.sql" > "$tmp/m1.sql"
git -C "$root" show "$old_ref:supabase/migrations/20261009130000_food_service_operations_rpcs.sql" > "$tmp/m2.sql"
ok=1
for f in "$tmp/m1.sql" "$tmp/m2.sql" "$M/${CHAIN[2]}.sql" "$M/${CHAIN[3]}.sql"; do apply mm_upgrade "$f" >/dev/null || ok=0; done
check "MIG-C1 the OLD M1..M4 apply (state of existing test projects)" "$ok" "1"
# legacy data written by the old functions' shapes
Q -d mm_upgrade -c "
  insert into food_service_periods(id,name,ordering_opens_at,ordering_closes_at) values ('f0000000-0000-4000-8000-00000000ff01','Legacy','00:00','23:59:59');
  insert into food_orders(id,order_reference,employee_id,service_date,period_id,total_ugx,idempotency_key)
    values ('f0000000-0000-4000-8000-00000000ff02','FO-LEGACY','29a0cfa8-1eaf-453c-874c-0fc72fa4f74b',current_date,'f0000000-0000-4000-8000-00000000ff01',0,'legacy-key');
  insert into food_exceptions(kind,detail) values ('legacy_kind','{\"note\":\"legacy\"}');" >/dev/null
out=$(apply mm_upgrade "$M/${CHAIN[4]}.sql"); rc=$?
check "MIG-C2 corrections apply on top of a database with legacy rows" "$rc" "0"
apply mm_upgrade "$M/${CHAIN[5]}.sql" >/dev/null; rc=$?
check "MIG-C2b meal-photo migration applies after the corrections" "$rc" "0"
apply mm_upgrade "$M/${CHAIN[6]}.sql" >/dev/null; rc=$?
check "MIG-C2c staff/PSO migration applies after the meal-photo migration" "$rc" "0"
apply mm_upgrade "$M/${CHAIN[7]}.sql" >/dev/null; rc=$?
check "MIG-C2d exception self-resolution migration applies" "$rc" "0"
apply mm_upgrade "$M/${CHAIN[8]}.sql" >/dev/null; rc=$?
check "MIG-C2e payment-after-receipt migration applies over legacy orders" "$rc" "0"
apply mm_upgrade "$M/${CHAIN[9]}.sql" >/dev/null; rc=$?
check "MIG-C2f reversal and handover controls migration applies" "$rc" "0"
check "MIG-C3 legacy order kept, payment_mode NULL, still unpaid" \
  "$(Q -d mm_upgrade -c "select payment_mode is null and payment_status='pending_payment' from food_orders where order_reference='FO-LEGACY'")" "t"
check "MIG-C4 legacy exception kind kept (constraint is NOT VALID for old rows)" \
  "$(Q -d mm_upgrade -c "select count(*) from food_exceptions where kind='legacy_kind'")" "1"
check "MIG-C5 new rows must carry a payment mode" \
  "$(Q -d mm_upgrade -c "do \$\$ begin insert into food_orders(order_reference,employee_id,service_date,period_id,total_ugx,idempotency_key) values ('FO-X','29a0cfa8-1eaf-453c-874c-0fc72fa4f74b',current_date,'f0000000-0000-4000-8000-00000000ff01',0,'k-x'); raise exception 'inserted'; exception when check_violation then raise notice 'refused'; end \$\$;" 2>&1 | grep -c refused)" "1"
check "MIG-C6 upgraded schema identical to a fresh install" "$(inventory mm_upgrade)" "$fresh_fp"

# ── D. re-applying the corrections fails atomically ──
before=$(inventory mm_upgrade)
apply mm_upgrade "$M/${CHAIN[4]}.sql" >/dev/null 2>&1; rc=$?
check "MIG-D1 a second application is refused (one-shot migration)" "$([ $rc -ne 0 ] && echo refused)" "refused"
check "MIG-D2 ...and leaves no partial change" "$(inventory mm_upgrade)" "$before"
apply mm_upgrade "$M/${CHAIN[5]}.sql" >/dev/null 2>&1; rc=$?
check "MIG-D3 re-applying the meal-photo migration is refused" "$([ $rc -ne 0 ] && echo refused)" "refused"
check "MIG-D4 ...and leaves no partial change" "$(inventory mm_upgrade)" "$before"
apply mm_upgrade "$M/${CHAIN[6]}.sql" >/dev/null 2>&1; rc=$?
check "MIG-D8 re-applying the staff/PSO migration is refused" "$([ $rc -ne 0 ] && echo refused)" "refused"
check "MIG-D9 ...and leaves no partial change" "$(inventory mm_upgrade)" "$before"
check "MIG-D5 the meal-photo bucket is private"   "$(Q -d mm_upgrade -c "select public from storage.buckets where id='food-meal-images'")" "f"
# A database that already holds a PUBLIC bucket of this name (an earlier draft of
# this migration) must be refused, not silently left public.
mkdb mm_publicbucket
for i in 0 1 2 3 4; do apply mm_publicbucket "$M/${CHAIN[$i]}.sql" >/dev/null; done
Q -d mm_publicbucket -c "insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('food-meal-images','food-meal-images',true,2097152,array['image/jpeg','image/png','image/webp'])" >/dev/null
apply mm_publicbucket "$M/${CHAIN[5]}.sql" >/dev/null 2>&1; rc=$?
check "MIG-D6 an existing PUBLIC food-meal-images bucket makes the migration fail closed" "$([ $rc -ne 0 ] && echo refused)" "refused"
check "MIG-D7 ...with no partial change (no photo policy, no read check)"   "$(Q -d mm_publicbucket -c "select (select count(*) from pg_policies where policyname like 'food\_meal\_images%') + (select count(*) from pg_proc where proname='food_meal_photo_readable')")" "0"
P -d postgres -c "drop database if exists mm_publicbucket with (force)" >/dev/null

# ── E. a missing prerequisite fails cleanly ──
mkdb mm_noprereq
Q -d mm_noprereq -c "alter table public.profiles drop column deleted_at" >/dev/null
apply mm_noprereq "$M/${CHAIN[0]}.sql" >/dev/null 2>&1; rc=$?
check "MIG-E1 M1 refuses when profiles.deleted_at is missing" "$([ $rc -ne 0 ] && echo refused)" "refused"
check "MIG-E2 ...and creates nothing" "$(Q -d mm_noprereq -c "select count(*) from pg_class where relname like 'food\_%'")" "0"

# ── G. no non-ASCII outside comments (immune to client-encoding mistakes) ──
na=0; for m in "${CHAIN[@]}"; do n=$(grep -nP '[^\x00-\x7F]' "$M/$m.sql" | grep -vP '^\d+:.*--' | wc -l); na=$((na+n)); done
check "MIG-G1 Food migrations carry non-ASCII only inside comments" "$na" "0"

# ── F. the requisition migration is not part of the chain ──
check "MIG-F1 20261009150000 (requisition) absent from this tree" "$(ls "$M"/20261009150000* 2>/dev/null | wc -l | tr -d ' ')" "0"

[ -n "${KEEP_DBS:-}" ] || for d in mm_fresh mm_seeded mm_upgrade mm_noprereq; do P -d postgres -c "drop database if exists $d with (force)" >/dev/null; done
rm -rf "$tmp"
exit $result
