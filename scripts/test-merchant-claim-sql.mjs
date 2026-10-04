// Run: npm i --no-save @electric-sql/pglite && node scripts/test-merchant-claim-sql.mjs
// (--no-save: no package.json / lockfile change). Exit code 1 on any failure.
// Executes supabase/migrations/20260911200000_merchant_claim_reservation_ownership.sql
// against an embedded Postgres (PGlite) with minimal stand-in tables, and
// asserts the stale-release / reservation / claim / classifier behaviour.
// Helper functions the migration calls are copied verbatim from production.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

// Applied in order, exactly as production would: the ownership migration, then
// the stale-release hardening that supersedes its release_stale_cashout_claims.
const MIGRATIONS = process.argv.length > 2
  ? process.argv.slice(2)
  : [
      '20260911200000_merchant_claim_reservation_ownership.sql',
      '20260911210000_stale_claim_release_frees_float_reservation.sql',
    ].map((f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url)));
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const asUser = (uid) => db.query(`select set_config('test.uid', $1, false)`, [uid ?? '']);

await db.exec(`
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

create table cashout_agents (id uuid primary key default gen_random_uuid(), agent_id uuid not null, is_active boolean default true);
create table withdrawal_requests (
  id uuid primary key default gen_random_uuid(), user_id uuid default gen_random_uuid(), amount numeric not null,
  status text not null default 'pending', payout_method text default 'bank_transfer', mobile_money_number text,
  mobile_money_name text, mobile_money_provider text, bank_name text,
  assigned_cashout_agent_id uuid, dispatched_at timestamptz, dispatch_claimed_by uuid, dispatch_claimed_at timestamptz,
  processing_started_at timestamptz, processing_started_by uuid, processed_at timestamptz, processed_by uuid,
  fin_ops_reference text, payout_proof text, payout_proof_path text, payout_code text, transaction_id text,
  hidden_from_merchant_queue boolean default false, created_at timestamptz default now(), updated_at timestamptz default now());
create table merchant_float_reservations (
  id uuid primary key default gen_random_uuid(), withdrawal_id uuid unique, agent_id uuid, desk_id uuid, state text,
  amount_requested numeric, telecom_expected numeric, float_before numeric, reserved_before numeric, available_before numeric,
  reserved_amount numeric, planned_out_of_pocket numeric, consumed_float numeric, consumed_telecom numeric,
  out_of_pocket_amount numeric, float_after numeric, receivable_after numeric, released_reason text,
  reserved_at timestamptz default now(), settled_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
create table withdrawal_payment_evidence (id uuid primary key default gen_random_uuid(), withdrawal_id uuid);
create table audit_logs (id serial, user_id uuid, action_type text, table_name text, record_id text, metadata jsonb);
create table wallets (user_id uuid primary key, float_balance numeric default 0, withdrawable_balance numeric default 0);
create table wallets_physical (user_id uuid primary key);
create table agent_landlord_float (balance numeric);
create table general_ledger (reference_id text, ledger_scope text, direction text, amount numeric);
create table merchant_out_of_pocket_advances (
  id uuid primary key default gen_random_uuid(), agent_id uuid, withdrawal_id uuid, kind text, payout_amount numeric,
  telecom_charge numeric, float_used numeric, shortfall_amount numeric, status text, note text,
  attested_at timestamptz, reviewed_at timestamptz, updated_at timestamptz default now(), unique (withdrawal_id, kind));
create table merchant_payout_funding (
  withdrawal_id uuid primary key, agent_id uuid, payout_amount numeric, telecom_charge_expected numeric,
  float_consumed_principal numeric, float_consumed_telecom numeric, own_cash_principal numeric, own_cash_telecom numeric,
  receivable_recorded numeric, funding_source text, classified_via text, notes text,
  classified_at timestamptz default now(), updated_at timestamptz default now());

create function assert_no_urgent_landlord_priority(uuid) returns uuid language sql as $$ select null::uuid $$;
create function assert_no_urgent_proxy_priority(uuid) returns uuid language sql as $$ select null::uuid $$;

-- ↓ verbatim from production (2026-09-11)
CREATE OR REPLACE FUNCTION public.merchant_telecom_sending_charge(p_amount numeric) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $f$
  SELECT CASE WHEN COALESCE(p_amount, 0) <= 0 THEN 0 WHEN p_amount <= 5000 THEN 100 WHEN p_amount <= 60000 THEN 500
    WHEN p_amount <= 500000 THEN 1000 WHEN p_amount <= 1000000 THEN 1500 ELSE 2000 END::numeric; $f$;
CREATE OR REPLACE FUNCTION public.telecom_sending_charge(p_amount numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$ SELECT public.merchant_telecom_sending_charge(p_amount) $f$;
CREATE OR REPLACE FUNCTION public.merchant_reserved_float(p_agent_id uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT COALESCE(SUM(GREATEST(r.reserved_amount, 0)), 0)
  FROM public.merchant_float_reservations r LEFT JOIN public.withdrawal_requests w ON w.id = r.withdrawal_id
  WHERE r.agent_id = p_agent_id AND r.state = 'reserved' AND COALESCE(r.reserved_at, r.created_at) > now() - interval '48 hours'
    AND COALESCE(w.status, 'pending') NOT IN ('completed', 'rejected', 'cancelled', 'failed', 'settled', 'paid'); $f$;
CREATE OR REPLACE FUNCTION public.release_merchant_float(p_withdrawal_id uuid, p_reason text DEFAULT 'claim_released'::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_row public.merchant_float_reservations;
BEGIN
  SELECT * INTO v_row FROM public.merchant_float_reservations WHERE withdrawal_id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', true, 'noop', true); END IF;
  IF v_row.state = 'consumed' THEN RETURN jsonb_build_object('success', false, 'error', 'already_consumed'); END IF;
  UPDATE public.merchant_float_reservations SET state = 'released', reserved_amount = 0,
      released_reason = COALESCE(p_reason, 'claim_released'), settled_at = now() WHERE id = v_row.id;
  RETURN jsonb_build_object('success', true, 'released', true);
END; $f$;
`);

for (const m of MIGRATIONS) await db.exec(fs.readFileSync(m, 'utf8'));
console.log(`migrations executed OK (${MIGRATIONS.length})`);

// ── fixtures ──
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const deskA = (await one(`insert into cashout_agents(agent_id) values ($1) returning id`, [A])).id;
const deskB = (await one(`insert into cashout_agents(agent_id) values ($1) returning id`, [B])).id;
await db.query(`insert into wallets values ($1, 10000000, 0), ($2, 10000000, 0)`, [A, B]);
await db.query(`insert into wallets_physical values ($1), ($2)`, [A, B]);

const mkStale = async (extra = {}, minutesAgo = 90) => {
  const cols = Object.keys(extra), vals = Object.values(extra);
  const set = cols.map((c, i) => `, ${c} = $${i + 3}`).join('');
  const w = await one(`insert into withdrawal_requests(amount) values (100000) returning id`);
  await db.query(`update withdrawal_requests set assigned_cashout_agent_id = $1, dispatched_at = now() - make_interval(mins => $2),
      dispatch_claimed_by = '${A}', dispatch_claimed_at = now()${set} where id = '${w.id}'`, [deskA, minutesAgo, ...vals]);
  return w.id;
};
const mkResv = (wid, state = 'reserved') => db.query(
  `insert into merchant_float_reservations(withdrawal_id, agent_id, state, reserved_amount) values ($1, $2, $3, 101000)`, [wid, A, state]);
const wr = (id) => one(`select * from withdrawal_requests where id = $1`, [id]);
const resv = (id) => one(`select * from merchant_float_reservations where withdrawal_id = $1`, [id]);

// ── Defect C: stale release ──
const wStale = await mkStale(); await mkResv(wStale);
const wNoResv = await mkStale();
const wRecent = await mkStale({}, 10); await mkResv(wRecent);
const wConsumed = await mkStale(); await mkResv(wConsumed, 'consumed');
const evidence = {
  processing: { processing_started_at: new Date().toISOString() },
  proof: { payout_proof: 'https://x/proof.jpg' },
  proofPath: { payout_proof_path: 'payment-proofs/x.jpg' },
  code: { payout_code: 'WPO-12345' },
  tid: { transaction_id: 'TID123' },
  processedAt: { processed_at: new Date().toISOString() },
  finopsRef: { fin_ops_reference: 'REF123' },
};
const evIds = {};
for (const [k, v] of Object.entries(evidence)) { evIds[k] = await mkStale(v); await mkResv(evIds[k]); }
evIds.paymentEvidence = await mkStale(); await mkResv(evIds.paymentEvidence);
await db.query(`insert into withdrawal_payment_evidence(withdrawal_id) values ($1)`, [evIds.paymentEvidence]);

const released = (await one(`select released_count from release_stale_cashout_claims()`)).released_count;
ok(released === 2, `stale release count = 2 (got ${released})`);

let r = await wr(wStale), rv = await resv(wStale);
ok(r.assigned_cashout_agent_id === null && r.dispatched_at === null && r.dispatch_claimed_by === null && r.dispatch_claimed_at === null,
  '#5 stale zero-evidence claim: assignment + dispatch stamps cleared');
ok(rv && rv.state === 'released' && rv.released_reason === 'stale_claim_auto_release' && Number(rv.reserved_amount) === 0,
  '#5/#6 its reservation released via release_merchant_float with reason stale_claim_auto_release (row kept)');
ok((await one(`select count(*)::int n from merchant_float_reservations`)).n === 11, '#6 no reservation rows deleted');
ok((await wr(wNoResv)).assigned_cashout_agent_id === null, '#8 stale claim with NO reservation is still released');
ok((await wr(wRecent)).assigned_cashout_agent_id === deskA && (await resv(wRecent)).state === 'reserved', '45-minute threshold kept: 10-minute-old claim untouched');
ok((await wr(wConsumed)).assigned_cashout_agent_id === deskA && (await resv(wConsumed)).state === 'consumed', 'consumed reservation => claim preserved, no divergence');
for (const [k, id] of Object.entries(evIds)) {
  ok((await wr(id)).assigned_cashout_agent_id === deskA && (await resv(id)).state === 'reserved', `#7 evidence "${k}" => claim and reservation NOT released`);
}
const audit = await one(`select metadata from audit_logs where action_type = 'cashout_claim_auto_released' order by id desc limit 1`);
ok(audit.metadata.reservations_released === 1 && audit.metadata.preserved_consumed_ids.includes(wConsumed), 'audit row records released / preserved ids');
ok((await one(`select released_count from release_stale_cashout_claims()`)).released_count === 0, 'idempotent: second run releases nothing');

// Atomicity: make release_merchant_float refuse one row; its unassign must roll back too.
const wAtomic = await mkStale(); await mkResv(wAtomic);
const wAtomicOk = await mkStale(); await mkResv(wAtomicOk);
await db.exec(`
  alter function release_merchant_float(uuid, text) rename to release_merchant_float_real;
  create function release_merchant_float(p_withdrawal_id uuid, p_reason text default 'claim_released') returns jsonb language plpgsql as $f$
  begin
    if p_withdrawal_id = '${wAtomic}' then return jsonb_build_object('success', false, 'error', 'simulated'); end if;
    return release_merchant_float_real(p_withdrawal_id, p_reason);
  end $f$;`);
await one(`select released_count from release_stale_cashout_claims()`);
ok((await wr(wAtomic)).assigned_cashout_agent_id === deskA && (await resv(wAtomic)).state === 'reserved',
  'atomic: reservation release refused => assignment kept (both rolled back together)');
ok((await wr(wAtomicOk)).assigned_cashout_agent_id === null && (await resv(wAtomicOk)).state === 'released',
  'atomic: other rows in the same batch still released');
await db.exec(`drop function release_merchant_float(uuid, text); alter function release_merchant_float_real(uuid, text) rename to release_merchant_float;`);

// ── #9 one active claim + reservation ownership ──
await db.query(`update withdrawal_requests set assigned_cashout_agent_id = null, dispatched_at = null`); // clear fixtures
await db.query(`update withdrawal_requests set status = 'cancelled'`);
const w1 = (await one(`insert into withdrawal_requests(amount) values (50000) returning id`)).id;
const w2 = (await one(`insert into withdrawal_requests(amount) values (60000) returning id`)).id;
await asUser(A);
let res = (await one(`select claim_withdrawal_verified($1) r`, [w1])).r;
ok(res.success === true, '#9 merchant A claims one available withdrawal');
res = (await one(`select claim_withdrawal_verified($1) r`, [w2])).r;
ok(res.error === 'active_claim_exists' && res.blocking_withdrawal_id === w1, '#9 A refused a second claim; blocking id = first claim');
res = (await one(`select claim_withdrawal_verified($1) r`, [w1])).r;
ok(res.success === true && res.idempotent === true, 're-tap on own claim is idempotent success (was: already_claimed + own reservation released)');
await asUser(B);
res = (await one(`select claim_withdrawal_verified($1) r`, [w1])).r;
ok(res.error === 'already_claimed', 'B cannot claim A\'s withdrawal');
ok((await resv(w1)).state === 'reserved' && (await resv(w1)).agent_id === A, 'B\'s lost race does NOT release A\'s reservation (was: claim_race_lost on the winner)');
await db.query(`update withdrawal_requests set status = 'completed', processed_at = now() where id = $1`, [w1]);
await asUser(A);
res = (await one(`select claim_withdrawal_verified($1) r`, [w2])).r;
ok(res.success === true, '#9 after the first is completed, A can claim another');
const wDone = (await one(`insert into withdrawal_requests(amount, status, processed_at) values (1000, 'completed', now()) returning id`)).id;
await asUser(B);
res = (await one(`select claim_withdrawal_verified($1) r`, [wDone])).r;
ok(res.error === 'not_available', 'a completed withdrawal cannot be claimed via direct RPC');

// Reservation re-point: stale reservation held by A on an unassigned row; B claims it.
const w3 = (await one(`insert into withdrawal_requests(amount) values (70000) returning id`)).id;
await db.query(`insert into merchant_float_reservations(withdrawal_id, agent_id, state, reserved_amount) values ($1, $2, 'reserved', 70500)`, [w3, A]);
res = (await one(`select claim_withdrawal_verified($1) r`, [w3])).r;
ok(res.success === true && (await resv(w3)).agent_id === B, 'B claiming a row with A\'s leftover reservation re-points it to B (was: B inherited A\'s)');

// ── #10 queue exclusivity (SQL mirror of applyMerchantQueueFence + claimed-by-you) ──
const inShared = async (id) => (await one(`select count(*)::int n from withdrawal_requests where id = $1 and assigned_cashout_agent_id is null
  and status in ('pending','requested','manager_approved','cfo_approved','fin_ops_approved') and processed_at is null and fin_ops_reference is null
  and hidden_from_merchant_queue is not true`, [id])).n === 1;
const inMine = async (id, desk) => (await one(`select count(*)::int n from withdrawal_requests where id = $1 and assigned_cashout_agent_id = $2
  and status in ('pending','requested','manager_approved','cfo_approved','fin_ops_approved','approved') and processed_at is null
  and coalesce(fin_ops_reference,'') = ''`, [id, desk])).n === 1;
const w4 = (await one(`insert into withdrawal_requests(amount) values (80000) returning id`)).id;
ok(await inShared(w4) && !(await inMine(w4, deskA)), '#10 unassigned open row: shared queue only');
ok(!(await inShared(w2)) && (await inMine(w2, deskA)) && !(await inMine(w2, deskB)), '#10 claimed row: only in its merchant\'s Claimed by you, never both');

// ── classifier: claimant/settler mismatch leaves existing receivables untouched ──
await asUser(null);
const w5 = (await one(`insert into withdrawal_requests(amount, status, processed_at, processed_by) values (200000, 'completed', now(), $1) returning id`, [B])).id;
await db.query(`insert into merchant_float_reservations(withdrawal_id, agent_id, state, reserved_amount) values ($1, $2, 'released', 0)`, [w5, A]);
await db.query(`insert into merchant_out_of_pocket_advances(agent_id, withdrawal_id, kind, shortfall_amount, status, note) values ($1, $2, 'payout', 200000, 'pending_reimbursement', 'Phase 6 classification: x')`, [A, w5]);
res = (await one(`select classify_merchant_payout_funding($1, 'test') r`, [w5])).r;
const oop5 = await one(`select agent_id, status, shortfall_amount from merchant_out_of_pocket_advances where withdrawal_id = $1`, [w5]);
ok(res.skipped === 'attribution_mismatch_existing_receivables_left' && oop5.agent_id === A && oop5.status === 'pending_reimbursement',
  'mismatch + existing receivable => left exactly as is');
const w6 = (await one(`insert into withdrawal_requests(amount, status, processed_at, processed_by) values (300000, 'completed', now(), $1) returning id`, [B])).id;
await db.query(`insert into merchant_float_reservations(withdrawal_id, agent_id, state, reserved_amount) values ($1, $2, 'consumed', 0)`, [w6, A]);
res = (await one(`select classify_merchant_payout_funding($1, 'test') r`, [w6])).r;
ok(res.funding_source === 'needs_review' && (await one(`select count(*)::int n from merchant_out_of_pocket_advances where withdrawal_id = $1`, [w6])).n === 0,
  'mismatch + no receivable => needs_review, no receivable raised');
const w7 = (await one(`insert into withdrawal_requests(amount, status, processed_at, processed_by) values (300000, 'completed', now(), $1) returning id`, [B])).id;
await db.query(`insert into merchant_float_reservations(withdrawal_id, agent_id, state, reserved_amount) values ($1, $2, 'consumed', 0)`, [w7, B]);
res = (await one(`select classify_merchant_payout_funding($1, 'test') r`, [w7])).r;
const oop7 = await one(`select agent_id, shortfall_amount from merchant_out_of_pocket_advances where withdrawal_id = $1 and kind = 'payout'`, [w7]);
ok(res.funding_source === 'own_cash' && oop7?.agent_id === B && Number(oop7.shortfall_amount) === 300000, 'settler = reservation holder => receivable to the settler');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
