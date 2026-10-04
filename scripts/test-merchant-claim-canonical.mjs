// Prompt 1 claim-transaction tests against a REAL PostgreSQL server (embedded),
// so concurrency is genuine: separate connections, real row locks.
//
//   npm i --no-save pg embedded-postgres@17.5.0-beta.15   (no package.json change)
//   node scripts/test-merchant-claim-canonical.mjs [migration.sql]
//
// Defaults to supabase/migrations/20260912010000_canonical_merchant_claim.sql.
//
// 1. Builds stand-in tables and installs the CURRENT production functions
//    verbatim (claim_withdrawal_verified, accept_withdrawal_dispatch,
//    reserve_merchant_float, release_merchant_float, merchant_reserved_float,
//    merchant_telecom_sending_charge, enforce_merchant_payout_authorization,
//    merchant_agent_allows_withdrawal, is_active_cashout_agent,
//    is_withdrawal_staff, the SELECT policy on withdrawal_requests).
// 2. Reproduces the production defect on the OLD claim RPC.
// 3. Applies the migration (twice, to prove it is re-runnable) and runs the
//    Prompt 1 scenarios. Exit code 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const MIGRATION = process.argv[2]
  ?? fileURLToPath(new URL('../supabase/migrations/20260912010000_canonical_merchant_claim.sql', import.meta.url));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claimpg-'));
const PORT = 54000 + Math.floor(Math.random() * 900);
const server = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'pw', port: PORT, persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {},
});
await server.initialise();
await server.start();
await server.createDatabase('t');
const mk = async () => { const c = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 't' }); await c.connect(); return c; };

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const admin = await mk();
const q1 = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const qn = async (sql, p = []) => (await admin.query(sql, p)).rows;

// ── schema + verbatim production functions ─────────────────────────────────
await admin.query(`
create role anon nologin; create role authenticated nologin;
grant usage on schema public to anon, authenticated;
create schema auth; grant usage on schema auth to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;

create table profiles (id uuid primary key, full_name text, phone text);
create table user_roles (user_id uuid, role text, enabled boolean default true);
create table cashout_agents (id uuid primary key default gen_random_uuid(), agent_id uuid not null, is_active boolean default true,
  config jsonb, created_at timestamptz default now());
create table withdrawal_requests (
  id uuid primary key default gen_random_uuid(), user_id uuid, amount numeric not null, status text not null default 'pending',
  reason text, payout_method text default 'bank_transfer', mobile_money_number text, mobile_money_name text, mobile_money_provider text,
  bank_name text, bank_account_number text, bank_account_name text, linked_party uuid, priority_level text,
  assigned_cashout_agent_id uuid, dispatched_at timestamptz, dispatch_claimed_by uuid, dispatch_claimed_at timestamptz,
  dispatch_expires_at timestamptz, processing_started_at timestamptz, processed_at timestamptz, processed_by uuid,
  fin_ops_reference text, payout_proof text, payout_code text, transaction_id text, hidden_from_merchant_queue boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table merchant_float_reservations (
  id uuid primary key default gen_random_uuid(), withdrawal_id uuid unique, agent_id uuid, desk_id uuid, state text,
  amount_requested numeric, telecom_expected numeric, float_before numeric, reserved_before numeric, available_before numeric,
  reserved_amount numeric, planned_out_of_pocket numeric, consumed_float numeric, consumed_telecom numeric,
  out_of_pocket_amount numeric, float_after numeric, receivable_after numeric, released_reason text,
  reserved_at timestamptz default now(), settled_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
create table withdrawal_notification_log (id uuid primary key default gen_random_uuid(), withdrawal_id uuid, recipient_id uuid,
  response text default 'pending', claimed_at timestamptz, updated_at timestamptz default now());
create table wallets (user_id uuid primary key, float_balance numeric default 0, withdrawable_balance numeric default 0);
create table wallets_physical (user_id uuid primary key);
create table agent_landlord_float (balance numeric);
grant select on all tables in schema public to authenticated;

create function update_updated_at_column() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger trg_mfr_touch before update on merchant_float_reservations for each row execute function update_updated_at_column();
create trigger trg_wr_touch before update on withdrawal_requests for each row execute function update_updated_at_column();

-- stand-ins (behaviour controlled per test through cashout_agents.config)
create function merchant_config_allows_payout(cfg jsonb, r text, m text, b text, p text) returns boolean language sql stable
  as $$ select coalesce((cfg->>'deny_all')::boolean, false) = false $$;
create function merchant_handles_payout(p_agent_id uuid, m text, p text, b text) returns boolean language sql stable
  as $$ select coalesce((select (config->>'deny_all')::boolean from cashout_agents where agent_id = p_agent_id limit 1), false) = false $$;
create function assert_no_urgent_landlord_priority(uuid) returns uuid language sql as $$ select null::uuid $$;
create function assert_no_urgent_proxy_priority(uuid) returns uuid language sql as $$ select null::uuid $$;

-- ↓ verbatim from production (2026-09-12 00:40 EAT)
CREATE OR REPLACE FUNCTION public.merchant_agent_allows_withdrawal(p_agent_id uuid, p_reason text, p_payout_method text, p_bank_name text, p_momo_provider text)
 RETURNS boolean LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE v_cfg jsonb; v_found boolean := false;
BEGIN
  IF p_agent_id IS NULL THEN RETURN true; END IF;
  SELECT ca.config, true INTO v_cfg, v_found FROM public.cashout_agents ca
  WHERE ca.id = p_agent_id OR ca.agent_id = p_agent_id ORDER BY (ca.id = p_agent_id) DESC LIMIT 1;
  IF NOT coalesce(v_found, false) THEN RETURN true; END IF;
  RETURN public.merchant_config_allows_payout(v_cfg, p_reason, p_payout_method, p_bank_name, p_momo_provider);
END; $function$;

CREATE OR REPLACE FUNCTION public.enforce_merchant_payout_authorization() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.dispatch_claimed_by IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.dispatch_claimed_by IS DISTINCT FROM OLD.dispatch_claimed_by) THEN
    IF NOT public.merchant_agent_allows_withdrawal(NEW.dispatch_claimed_by, NEW.reason, NEW.payout_method, NEW.bank_name, NEW.mobile_money_provider) THEN
      RAISE EXCEPTION 'This payout is outside your authorized payment channels / payout categories';
    END IF;
  END IF;
  IF NEW.assigned_cashout_agent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.assigned_cashout_agent_id IS DISTINCT FROM OLD.assigned_cashout_agent_id) THEN
    IF NOT public.merchant_agent_allows_withdrawal(NEW.assigned_cashout_agent_id, NEW.reason, NEW.payout_method, NEW.bank_name, NEW.mobile_money_provider) THEN
      RAISE EXCEPTION 'Merchant agent is not authorized for this payment channel / payout category';
    END IF;
  END IF;
  RETURN NEW;
END; $function$;
create trigger trg_enforce_merchant_payout_authorization before insert or update on withdrawal_requests
  for each row execute function enforce_merchant_payout_authorization();

CREATE OR REPLACE FUNCTION public.is_active_cashout_agent(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.cashout_agents ca WHERE ca.agent_id = _user_id AND ca.is_active = true); $function$;
CREATE OR REPLACE FUNCTION public.is_withdrawal_staff(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.enabled = true
    AND ur.role IN ('manager', 'operations', 'cfo', 'coo', 'super_admin', 'cto')); $function$;

alter table withdrawal_requests enable row level security;
create policy "Owners staff and assigned merchant agents can view withdrawals" on withdrawal_requests for select using (
  (user_id = auth.uid()) OR is_withdrawal_staff(auth.uid()) OR (is_active_cashout_agent(auth.uid()) AND ((assigned_cashout_agent_id IS NULL)
  OR (assigned_cashout_agent_id = (SELECT ca.id FROM cashout_agents ca WHERE (ca.agent_id = auth.uid()) LIMIT 1))
  OR (dispatch_claimed_by = auth.uid()) OR (processed_by = auth.uid()))));

CREATE OR REPLACE FUNCTION public.merchant_telecom_sending_charge(p_amount numeric) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $f$
  SELECT CASE WHEN COALESCE(p_amount, 0) <= 0 THEN 0 WHEN p_amount <= 5000 THEN 100 WHEN p_amount <= 60000 THEN 500
    WHEN p_amount <= 500000 THEN 1000 WHEN p_amount <= 1000000 THEN 1500 ELSE 2000 END::numeric; $f$;
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
// reserve_merchant_float, claim_withdrawal_verified and accept_withdrawal_dispatch
// (current production versions; also the rollback for the migration).
await admin.query(fs.readFileSync(new URL('./fixtures/merchant-claim-prod-baseline-2026-09-12.sql', import.meta.url), 'utf8'));
await admin.query(`grant execute on all functions in schema public to authenticated`);

// ── fixtures ───────────────────────────────────────────────────────────────
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = U(1), B = U(2), C = U(3), D = U(4), STAFF = U(9), CUST = U(100);
await admin.query(`insert into profiles values ($1,'Nabwire Resty','+256731727650'), ($2,'Agent A','1'), ($3,'Agent B','2')`, [CUST, A, B]);
await admin.query(`insert into user_roles(user_id, role) values ($1, 'cfo')`, [STAFF]);
const desk = {};
for (const [u, t] of [[A, 1], [B, 2], [C, 3], [D, 4]]) {
  desk[u] = (await q1(`insert into cashout_agents(agent_id, created_at) values ($1, now() - make_interval(mins => $2)) returning id`, [u, t])).id;
  await admin.query(`insert into wallets values ($1, 5000000, 0) on conflict do nothing`, [u]);
  await admin.query(`insert into wallets_physical values ($1) on conflict do nothing`, [u]);
}
await admin.query(`insert into wallets values ($1, 0, 100000000)`, [CUST]); // company payout pool
const mkW = async (amount = 10000, extra = {}) => {
  const cols = ['user_id', 'amount', 'payout_method', 'mobile_money_number', 'mobile_money_name', 'mobile_money_provider', ...Object.keys(extra)];
  const vals = [CUST, amount, 'mobile_money', '0731727650', 'Nabwire Resty', 'airtel', ...Object.values(extra)];
  return (await q1(`insert into withdrawal_requests(${cols}) values (${cols.map((_, i) => `$${i + 1}`)}) returning id`, vals)).id;
};
const wr = (id) => q1(`select * from withdrawal_requests where id = $1`, [id]);
const resv = (id) => q1(`select * from merchant_float_reservations where withdrawal_id = $1`, [id]);
const closeW = (id) => admin.query(`update withdrawal_requests set status = 'completed', processed_at = now() where id = $1`, [id]);

async function asUser(c, uid) {
  await c.query(`select set_config('test.uid', $1, false)`, [uid ?? '']);
  await c.query('set role authenticated');
}
const rpc = async (c, uid, fn, args) => {
  await asUser(c, uid);
  try { return (await c.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`)}) r`, args)).rows[0].r; }
  finally { await c.query('reset role'); }
};
const claim = (c, uid, wid) => rpc(c, uid, 'claim_withdrawal_verified', [wid, '0731727650', 'Nabwire Resty']);

// ── 0. Reproduce the production defect on the OLD RPC ──────────────────────
{
  const w = await mkW();
  const first = await claim(admin, A, w);
  const retry = await claim(admin, A, w);
  const r = await resv(w), row = await wr(w);
  ok(first.success === true, 'OLD RPC: first claim succeeds');
  ok(retry.error === 'already_claimed' && row.assigned_cashout_agent_id === desk[A] && r.state === 'released' && r.released_reason === 'claim_race_lost',
    'OLD RPC reproduces production: owner retry -> "already_claimed", row still assigned to owner, own reservation released as claim_race_lost');
  await closeW(w);
}

// ── apply the migration twice (must be re-runnable) ────────────────────────
const migration = fs.readFileSync(MIGRATION, 'utf8');
await admin.query(migration);
await admin.query(migration);
ok(true, 'migration applies cleanly on top of production definitions, and re-applies idempotently');

const attempts = async (wid) => qn(`select result_code, idempotent, race_lost, reservation_outcome, error_code from withdrawal_claim_attempts where withdrawal_id = $1 order by created_at, id`, [wid]);

// ── TEST 1: normal claim returns the full claimed withdrawal ───────────────
const X = await mkW(10000);
{
  const res = await claim(admin, A, X);
  const row = await wr(X), r = await resv(X);
  ok(res.success === true && res.idempotent === false && res.result_code === 'CLAIM_SUCCESS', 'T1 success, idempotent=false, result_code CLAIM_SUCCESS');
  ok(row.assigned_cashout_agent_id === desk[A] && row.dispatch_claimed_by === A && row.dispatched_at && row.dispatch_claimed_at,
    'T1 assigned to A\'s desk; dispatch_claimed_by/dispatch_claimed_at/dispatched_at written together');
  ok(r.state === 'reserved' && r.agent_id === A && r.desk_id === desk[A], 'T1 reservation reserved, owned by A / A\'s desk');
  const cl = res.claim;
  ok(cl && cl.id === X && cl.assigned_cashout_agent_id === desk[A] && Number(cl.amount) === 10000 && cl.mobile_money_number === '0731727650'
     && cl.mobile_money_name === 'Nabwire Resty' && cl.mobile_money_provider === 'airtel' && cl.status === 'pending' && cl.claimed_at
     && cl.profiles?.full_name === 'Nabwire Resty' && cl.profiles?.phone === '+256731727650',
    'T1 response.claim is the full row + profiles{full_name, phone} (renders without a second read)');
  ok(res.reservation?.state === 'reserved' && Number(res.reservation.reserved_amount) === 10500 && Number(res.reservation.telecom_expected) === 500
     && Number(res.reserved_amount) === 10500 && res.withdrawal_id === X,
    'T1 response.reservation + legacy top-level keys (withdrawal_id, reserved_amount)');
}

// ── TEST 2 / 5: owner retries (while it is their active claim) ─────────────
{
  const before = await resv(X);
  const res = await claim(admin, A, X);
  const after = await resv(X);
  ok(res.success === true && res.idempotent === true && res.already_owned_by_you === true && res.result_code === 'CLAIM_ALREADY_OWNED_BY_SELF',
    'T2/T5 retry -> success, idempotent, already_owned_by_you (NOT active_claim_exists, NOT already_claimed)');
  ok(after.id === before.id && after.state === 'reserved' && String(after.reserved_at) === String(before.reserved_at)
     && Number(after.reserved_amount) === Number(before.reserved_amount),
    'T2 no new reservation, original reservation untouched (same id, same reserved_at, still reserved)');
  ok((await wr(X)).assigned_cashout_agent_id === desk[A] && res.claim?.id === X, 'T2 still assigned to A and full claim returned again');
  ok((await q1(`select count(*)::int n from merchant_float_reservations where released_reason = 'claim_race_lost' and withdrawal_id = $1`, [X])).n === 0,
    'T2 no claim_race_lost');
}

// ── TEST 4: second withdrawal while X is active ────────────────────────────
const Y = await mkW(20000);
{
  const res = await claim(admin, A, Y);
  ok(res.success === false && res.error === 'active_claim_exists' && res.blocking_withdrawal_id === X && res.result_code === 'CLAIM_BLOCKED_ACTIVE_CLAIM',
    'T4 active_claim_exists, blocking_withdrawal_id = X');
  ok((await wr(Y)).assigned_cashout_agent_id === null && !(await resv(Y)), 'T4 Y stays available, no reservation created for Y');
}

// ── another merchant tries A's claim ───────────────────────────────────────
{
  const before = await resv(X);
  const res = await claim(admin, B, X);
  const after = await resv(X);
  ok(res.success === false && res.error === 'already_claimed' && res.result_code === 'CLAIM_ALREADY_OWNED_BY_OTHER', 'B on A\'s claim -> already_claimed');
  ok(after.agent_id === A && after.state === 'reserved' && String(after.updated_at) === String(before.updated_at), 'B\'s attempt did not touch A\'s reservation at all');
}

// ── legacy damage (Brian's production state) is repaired on the owner's retry
{
  await admin.query(`update merchant_float_reservations set state = 'released', reserved_amount = 0, released_reason = 'claim_race_lost' where withdrawal_id = $1`, [X]);
  const res = await claim(admin, A, X);
  const r = await resv(X);
  ok(res.success === true && res.idempotent === true && res.reservation_outcome === 'restored_for_owner' && r.state === 'reserved' && r.agent_id === A,
    'owner retry on a claim whose reservation the OLD RPC released -> reservation restored for the owner, claim kept');
}
await closeW(X);

// ── TEST 3: two merchants, same withdrawal, genuinely concurrent ───────────
{
  // Deterministic interleaving: A holds the row lock; B must wait, then lose.
  const cA = await mk(), cB = await mk();
  const Z = await mkW(30000);
  await cA.query('begin');
  const resA = await rpc(cA, A, 'claim_withdrawal_verified', [Z, '0731727650', 'Nabwire Resty']);
  let settled = false;
  const pB = rpc(cB, B, 'claim_withdrawal_verified', [Z, '0731727650', 'Nabwire Resty']).then((r) => { settled = true; return r; });
  await sleep(400);
  ok(resA.success === true && settled === false, 'T3 while A\'s claim transaction is open, B is blocked on the row lock (not racing ahead)');
  await cA.query('commit');
  const resB = await pB;
  const r = await resv(Z);
  ok(resB.success === false && resB.error === 'already_claimed', 'T3 after A commits, B gets already_claimed');
  ok((await wr(Z)).assigned_cashout_agent_id === desk[A] && r.agent_id === A && r.state === 'reserved'
     && (await q1(`select count(*)::int n from merchant_float_reservations where withdrawal_id = $1`, [Z])).n === 1,
    'T3 exactly one reservation, owned by the winner, still reserved');
  await closeW(Z);

  // Winner rolls back -> the waiting merchant gets it (no partial state left).
  const Z2 = await mkW(30000);
  await cA.query('begin');
  const resA2 = await rpc(cA, A, 'claim_withdrawal_verified', [Z2, '0731727650', 'Nabwire Resty']);
  const pB2 = rpc(cB, B, 'claim_withdrawal_verified', [Z2, '0731727650', 'Nabwire Resty']);
  await sleep(300);
  await cA.query('rollback');
  const resB2 = await pB2;
  const r2 = await resv(Z2);
  ok(resA2.success === true && resB2.success === true && (await wr(Z2)).assigned_cashout_agent_id === desk[B] && r2.agent_id === B && r2.state === 'reserved',
    'T3 if the first transaction rolls back, the waiting merchant claims cleanly (reservation is theirs)');
  await closeW(Z2);

  // Burst: 30 rounds of two merchants firing at once.
  let clean = 0;
  for (let i = 0; i < 30; i++) {
    const w = await mkW(15000 + i);
    const [ra, rb] = await Promise.all([
      rpc(cA, C, 'claim_withdrawal_verified', [w, '0731727650', 'Nabwire Resty']),
      rpc(cB, D, 'claim_withdrawal_verified', [w, '0731727650', 'Nabwire Resty']),
    ]);
    const winners = [ra, rb].filter((x) => x.success === true);
    const losers = [ra, rb].filter((x) => x.error === 'already_claimed');
    const row = await wr(w), rr = await resv(w);
    const winnerUid = row.assigned_cashout_agent_id === desk[C] ? C : row.assigned_cashout_agent_id === desk[D] ? D : null;
    if (winners.length === 1 && losers.length === 1 && winnerUid && rr?.agent_id === winnerUid && rr.state === 'reserved') clean++;
    await closeW(w);
  }
  ok(clean === 30, `T3 burst: ${clean}/30 concurrent rounds -> exactly one winner, one already_claimed, one reservation owned by the winner`);

  // Same merchant, two connections, same withdrawal at once (double tap).
  let dtClean = 0;
  for (let i = 0; i < 15; i++) {
    const w = await mkW(12000 + i);
    const [r1, r2] = await Promise.all([
      rpc(cA, C, 'claim_withdrawal_verified', [w, '0731727650', 'Nabwire Resty']),
      rpc(cB, C, 'claim_withdrawal_verified', [w, '0731727650', 'Nabwire Resty']),
    ]);
    const rr = await resv(w);
    if (r1.success && r2.success && [r1.idempotent, r2.idempotent].sort().join() === 'false,true'
        && rr.state === 'reserved' && rr.agent_id === C && (await wr(w)).assigned_cashout_agent_id === desk[C]) dtClean++;
    await closeW(w);
  }
  ok(dtClean === 15, `double tap: ${dtClean}/15 -> both calls succeed (one idempotent), reservation stays reserved`);
  await cA.end(); await cB.end();
}

// ── TEST 7: failures before/at assignment leave no partial state ───────────
{
  // Reservation failure: merchant with no float and an empty company pool.
  await admin.query(`update wallets set float_balance = 0 where user_id = $1`, [B]);
  await admin.query(`update wallets set withdrawable_balance = 0 where user_id = $1`, [CUST]);
  const w = await mkW(40000);
  const res = await claim(admin, B, w);
  ok(res.success === false && res.result_code === 'CLAIM_RESERVATION_FAILED' && res.error === 'pool_exhausted' && /UGX/.test(res.message),
    'T7 reservation failure -> CLAIM_RESERVATION_FAILED / pool_exhausted with the pool message');
  ok((await wr(w)).assigned_cashout_agent_id === null && !(await resv(w)), 'T7 withdrawal unassigned, no reservation row left');
  await admin.query(`update wallets set float_balance = 5000000 where user_id = $1`, [B]);
  await admin.query(`update wallets set withdrawable_balance = 100000000 where user_id = $1`, [CUST]);

  // Assignment failure AFTER the reservation was written: the savepoint must
  // roll the reservation back too.
  const w2 = await mkW(41000);
  await admin.query(`create function t_boom() returns trigger language plpgsql as $$ begin
    if new.id = '${w2}' and new.assigned_cashout_agent_id is not null then raise exception 'simulated assignment failure'; end if; return new; end $$;
    create trigger t_boom before update on withdrawal_requests for each row execute function t_boom();`);
  const res2 = await claim(admin, B, w2);
  ok(res2.success === false && res2.result_code === 'CLAIM_FAILED' && /simulated/.test(res2.detail || ''),
    'T7 assignment failure -> CLAIM_FAILED with the database reason in detail');
  ok((await wr(w2)).assigned_cashout_agent_id === null && !(await resv(w2)), 'T7 reservation written before the failed assignment was rolled back (no orphan)');
  await admin.query(`drop trigger t_boom on withdrawal_requests; drop function t_boom();`);

  // Permission denied (category/channel matrix).
  await admin.query(`update cashout_agents set config = '{"deny_all": true}' where agent_id = $1`, [B]);
  const w3 = await mkW(42000);
  const res3 = await claim(admin, B, w3);
  ok(res3.result_code === 'CLAIM_PERMISSION_DENIED' && res3.error === 'not_authorized_for_payout' && !(await resv(w3)) && (await wr(w3)).assigned_cashout_agent_id === null,
    'permission matrix refusal -> CLAIM_PERMISSION_DENIED, nothing reserved');
  await admin.query(`update cashout_agents set config = null where agent_id = $1`, [B]);

  // Payout details mismatch, closed row, consumed reservation.
  const w4 = await mkW(43000);
  const res4 = await rpc(admin, B, 'claim_withdrawal_verified', [w4, '0700000000', 'Nabwire Resty']);
  ok(res4.result_code === 'CLAIM_DETAILS_MISMATCH' && res4.error === 'number_mismatch' && !(await resv(w4)), 'wrong MoMo number -> CLAIM_DETAILS_MISMATCH, nothing reserved');
  const w5 = await mkW(44000, { status: 'completed' });
  const res5 = await claim(admin, B, w5);
  ok(res5.result_code === 'CLAIM_NOT_ACTIONABLE' && res5.error === 'not_available', 'completed withdrawal -> CLAIM_NOT_ACTIONABLE');
  const w6 = await mkW(45000);
  await admin.query(`insert into merchant_float_reservations(withdrawal_id, agent_id, state, reserved_amount) values ($1, $2, 'consumed', 0)`, [w6, D]);
  const res6 = await claim(admin, B, w6);
  ok(res6.result_code === 'CLAIM_RESERVATION_FAILED' && res6.error === 'reservation_already_consumed' && (await wr(w6)).assigned_cashout_agent_id === null
     && (await resv(w6)).state === 'consumed' && (await resv(w6)).agent_id === D,
    'row with consumed float -> refused, consumed reservation untouched');
  const nobody = await rpc(admin, U(77), 'claim_withdrawal_verified', [w4, null, null]);
  ok(nobody.result_code === 'CLAIM_PERMISSION_DENIED' && nobody.error === 'not_cashout_agent', 'non-merchant -> CLAIM_PERMISSION_DENIED');
}

// ── orphan reservation from a claim that was taken back ────────────────────
{
  const w = await mkW(46000);
  await admin.query(`insert into merchant_float_reservations(withdrawal_id, agent_id, desk_id, state, reserved_amount) values ($1, $2, $3, 'reserved', 46500)`, [w, D, desk[D]]);
  const res = await claim(admin, B, w);
  const r = await resv(w);
  ok(res.success === true && res.reservation_outcome === 'orphan_released_then_reserved' && r.agent_id === B && r.desk_id === desk[B] && r.state === 'reserved',
    'claiming a row with another merchant\'s leftover reservation re-reserves it for the claimant');
  await closeW(w);
}

// ── dispatch pop-up goes through the same transaction ──────────────────────
{
  const w = await mkW(47000);
  const res = await rpc(admin, B, 'accept_withdrawal_dispatch', [w]);
  const r = await resv(w);
  ok(res.ok === true && res.success === true && res.result_code === 'CLAIM_SUCCESS' && r?.state === 'reserved' && r.agent_id === B
     && (await wr(w)).assigned_cashout_agent_id === desk[B],
    'accept_withdrawal_dispatch now reserves float + assigns via the canonical claim (was: assignment with NO reservation)');
  const again = await rpc(admin, B, 'accept_withdrawal_dispatch', [w]);
  ok(again.ok === true && again.idempotent === true, 'pop-up re-accept by the owner is idempotent');
  const other = await rpc(admin, C, 'accept_withdrawal_dispatch', [w]);
  ok(other.ok === false && other.error === 'already_claimed', 'pop-up accept by another merchant -> ok:false / already_claimed (old client key kept)');

  // ── claim status RPC (ambiguous-network reconciliation) ──
  const mine = await rpc(admin, B, 'get_withdrawal_claim_status', [w]);
  const theirs = await rpc(admin, C, 'get_withdrawal_claim_status', [w]);
  const freeW = await mkW(48000);
  const free = await rpc(admin, C, 'get_withdrawal_claim_status', [freeW]);
  ok(mine.state === 'mine' && mine.claim?.id === w && mine.reservation?.state === 'reserved', 'status: owner -> mine + full claim');
  ok(theirs.state === 'other' && !('claim' in theirs) && !JSON.stringify(theirs).includes(desk[B]), 'status: other merchant -> "other", no claim data, no desk id leaked');
  ok(free.state === 'unassigned', 'status: unclaimed row -> unassigned');

  // ── TEST 9: reload -> "Claimed by you" query (verbatim filter) under RLS ──
  await asUser(admin, B);
  const mineRows = (await admin.query(`select id from withdrawal_requests where assigned_cashout_agent_id = $1
    and status = any($2) and processed_at is null`, [desk[B], ['pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved', 'approved']])).rows;
  await admin.query('reset role');
  ok(mineRows.length === 1 && mineRows[0].id === w, 'T9 reload: the "Claimed by you" query returns the claim for its owner under RLS');

  // ── TEST 10: RLS ──
  const seen = async (uid, id) => { await asUser(admin, uid); const n = (await admin.query(`select count(*)::int n from withdrawal_requests where id = $1`, [id])).rows[0].n; await admin.query('reset role'); return n; };
  ok(await seen(B, w) === 1, 'T10 owner merchant can read the claimed withdrawal');
  ok(await seen(C, w) === 0, 'T10 another merchant cannot read it');
  ok(await seen(STAFF, w) === 1, 'T10 withdrawal staff (CFO) can read it');
  await asUser(admin, C);
  let denied = false;
  try { await admin.query(`select merchant_claim_payload($1)`, [w]); } catch { denied = true; }
  await admin.query('reset role');
  ok(denied, 'T10 merchant_claim_payload is not callable by clients (cannot be used to read another desk\'s payout)');
  await asUser(admin, C);
  const cSees = (await admin.query(`select count(*)::int n from withdrawal_claim_attempts where agent_user_id <> $1`, [C])).rows[0].n;
  await admin.query('reset role');
  await asUser(admin, STAFF);
  const staffSees = (await admin.query(`select count(*)::int n from withdrawal_claim_attempts`)).rows[0].n;
  await admin.query('reset role');
  ok(cSees === 0 && staffSees > 0, 'claim attempt log: merchants see only their own attempts, staff see all');
  await closeW(w);
}

// ── audit trail ────────────────────────────────────────────────────────────
{
  const codes = (await qn(`select result_code, count(*)::int n from withdrawal_claim_attempts group by 1`)).reduce((m, r) => ({ ...m, [r.result_code]: r.n }), {});
  console.log('attempt log result codes:', codes);
  const need = ['CLAIM_SUCCESS', 'CLAIM_ALREADY_OWNED_BY_SELF', 'CLAIM_ALREADY_OWNED_BY_OTHER', 'CLAIM_BLOCKED_ACTIVE_CLAIM',
    'CLAIM_NOT_ACTIONABLE', 'CLAIM_PERMISSION_DENIED', 'CLAIM_RESERVATION_FAILED', 'CLAIM_DETAILS_MISMATCH', 'CLAIM_FAILED'];
  ok(need.every((k) => codes[k] > 0), 'every outcome is recorded in withdrawal_claim_attempts with its result code');
  const xLog = await attempts(X);
  ok(xLog.some((l) => l.result_code === 'CLAIM_ALREADY_OWNED_BY_SELF' && l.idempotent) && xLog.some((l) => l.result_code === 'CLAIM_ALREADY_OWNED_BY_OTHER' && l.race_lost),
    'X\'s log shows the idempotent retry and B\'s lost race as separate, flagged rows');
  const post = await q1(`select count(*)::int n from merchant_float_reservations r join withdrawal_requests w on w.id = r.withdrawal_id
     join cashout_agents ca on ca.id = w.assigned_cashout_agent_id
     where w.status in ('pending','requested','manager_approved','cfo_approved','fin_ops_approved','approved') and w.processed_at is null
       and (r.state <> 'reserved' or r.agent_id <> ca.agent_id)`);
  ok(post.n === 0, 'invariant across the whole test run: every open claim\'s reservation is reserved and owned by the claimant');
}

await admin.end();
await server.stop();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
