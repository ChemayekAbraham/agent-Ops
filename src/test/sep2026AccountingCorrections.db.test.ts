// @vitest-environment node
/**
 * September 2026 rent-collection ACCOUNTING corrections (batch acct_corr_202611) - no money movement.
 *
 * Runs, verbatim on PGlite:
 *   supabase/migrations/20261108150000_money_in_exclusions_and_correction_register.sql   (D + register)
 *   supabase/migrations/20261108150100_legacy_fee_path_cap_and_reversed_rows.sql          (E)
 *   docs/finance/corrections/2026-11-08_sep2026_rent_collection_corrections{_preview,,_rollback}.sql
 * over minimal tables with production's column names (read-only export 2026-11-08). compute_instalment_allocation is
 * production's definition verbatim (fixture). create_ledger_transaction is a stand-in with production's behaviour that
 * matters here: idempotency key on every leg (a repeated key returns the first group), raw cash_in = cash_out, scope
 * defaults to 'wallet'.
 *
 * Tripwires for money movement: a wallet-scope ledger insert moves wallet_balances_projection (like production's
 * routing trigger) and is logged; agent_collections, deposit_requests, withdrawal_requests, wallets_physical and
 * wallet_balances_projection log every write; the landlord-pool trigger on allocations logs if reversed_at changes;
 * a rent_requests status change is logged (status triggers pay bonuses in production).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG_D = read('supabase/migrations/20261108150000_money_in_exclusions_and_correction_register.sql');
const MIG_E = read('supabase/migrations/20261108150100_legacy_fee_path_cap_and_reversed_rows.sql');
const RB_D = read('supabase/rollbacks/20261108150000_money_in_exclusions_and_correction_register.rollback.sql');
const RB_E = read('supabase/rollbacks/20261108150100_legacy_fee_path_cap_and_reversed_rows.rollback.sql');
const CORR = read('docs/finance/corrections/2026-11-08_sep2026_rent_collection_corrections.sql');
const PREVIEW = read('docs/finance/corrections/2026-11-08_sep2026_rent_collection_corrections_preview.sql');
const ROLLBACK = read('docs/finance/corrections/2026-11-08_sep2026_rent_collection_corrections_rollback.sql');
const COMPUTE = read('src/test/fixtures/compute_instalment_allocation.live.sql');

const CFO = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
const AG = '00000000-0000-0000-0000-00000000a001';
const id = (p: string, n: number) => `00000000-0000-0000-${p}-${String(n).padStart(12, '0')}`;
const PLAN = (n: number) => id('0001', n);
const RC = (n: number) => id('0002', n);
const AL = (n: number) => id('0003', n);
const G = (n: number) => id('0004', n);
const CONTRA = 'eb648b95-0494-451c-b2d3-142ee2be69f0';

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create type public.app_role as enum ('cfo', 'ceo', 'super_admin', 'agent');
create table public.user_roles (user_id uuid, role public.app_role);
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as
  $$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role) $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
create table public.profiles (id uuid primary key, full_name text, phone text);
create table public.merchandise_recovery_plans (id uuid primary key, is_bike_lease boolean);
create function public._cfo_received_agent_product_for(c text, s text, b boolean) returns text language sql immutable as $$ select null::text $$;
create function public._cfo_received_category_for(p_category text) returns text language sql immutable as $$
  select case p_category when 'tenant_repayment_collected' then 'land' when 'tenant_repayment' then 'land'
    when 'access_fee_collected' then 'fees' when 'platform_fee_collected' then 'fees' when 'partner_funding' then 'partner' else null end $$;
create function public._cfo_received_category_for(p_category text, p_source_table text) returns text language sql immutable as $$
  select public._cfo_received_category_for(p_category) $$;

create table public.money_log (what text, at timestamptz default clock_timestamp());

create table public.rent_requests (id uuid primary key, tenant_id uuid, agent_id uuid, status text, rent_amount numeric,
  access_fee numeric, request_fee numeric, total_repayment numeric, amount_repaid numeric default 0, funded_at timestamptz,
  updated_at timestamptz default now());
create table public.rent_amount_change_log (id uuid primary key default gen_random_uuid(), rent_request_id uuid, tenant_id uuid,
  old_amount_repaid numeric, new_amount_repaid numeric, changed_fields text[], status text, changed_by uuid,
  changed_at timestamptz default now(), source text);
-- production's clamp and change-log triggers (amount_repaid part), and a tripwire on status changes
create function public.clamp_rent_request_amount_repaid() returns trigger language plpgsql as $$
begin
  if new.amount_repaid is null or new.amount_repaid < 0 then new.amount_repaid := 0; end if;
  if coalesce(new.total_repayment, 0) > 0 and new.amount_repaid > new.total_repayment then new.amount_repaid := new.total_repayment; end if;
  return new;
end $$;
create trigger zz_clamp before insert or update on public.rent_requests for each row execute function public.clamp_rent_request_amount_repaid();
create function public.log_rent_amount_change() returns trigger language plpgsql as $$
declare v_source text := nullif(current_setting('welile.balance_edit_source', true), '');
begin
  if new.amount_repaid is distinct from old.amount_repaid then
    insert into public.rent_amount_change_log (rent_request_id, tenant_id, old_amount_repaid, new_amount_repaid, changed_fields, status, changed_by, source)
    values (new.id, new.tenant_id, old.amount_repaid, new.amount_repaid, array['amount_repaid'], new.status, auth.uid(),
            case when v_source is null then null when v_source like 'agent_%' then v_source else 'cfo_approved_' || v_source end);
  end if;
  if new.status is distinct from old.status then insert into public.money_log (what) values ('rent_request status change'); end if;
  return new;
end $$;
create trigger trg_log_rent_amount_change after update on public.rent_requests for each row execute function public.log_rent_amount_change();

create table public.agent_collections (id uuid primary key, agent_id uuid, tenant_id uuid, rent_request_id uuid, amount numeric,
  payment_method text default 'cash', notes text, reversed_at timestamptz, deposit_request_id uuid, momo_transaction_id text,
  tracking_id text, created_at timestamptz);
create table public.deposit_requests (id uuid primary key, amount numeric, status text);
create table public.withdrawal_requests (id uuid primary key, amount numeric, status text);
create table public.wallets_physical (user_id uuid primary key, locked_balance numeric);
create table public.wallet_balances_projection (user_id uuid primary key, withdrawable numeric, float numeric);
create function public.trip() returns trigger language plpgsql as $$
begin insert into public.money_log (what) values (tg_table_name || ' ' || tg_op); return null; end $$;
create trigger trip after insert or update or delete on public.agent_collections for each row execute function public.trip();
create trigger trip after insert or update or delete on public.deposit_requests for each row execute function public.trip();
create trigger trip after insert or update or delete on public.withdrawal_requests for each row execute function public.trip();
create trigger trip after insert or update or delete on public.wallets_physical for each row execute function public.trip();
create trigger trip after insert or update or delete on public.wallet_balances_projection for each row execute function public.trip();

create table public.general_ledger (id uuid primary key default gen_random_uuid(), created_at timestamptz default clock_timestamp(),
  transaction_date timestamptz default now(), amount numeric, direction text, category text, description text, reference_id text,
  user_id uuid, source_table text, source_id uuid, transaction_group_id uuid, ledger_scope text, currency text default 'UGX',
  classification text default 'production', idempotency_key text, wallet_bucket text, recipient_type text);
-- production's routing trigger moves wallet balances for wallet-scope legs only
create function public.route_wallet() returns trigger language plpgsql as $$
begin
  if new.ledger_scope = 'wallet' then
    insert into public.money_log (what) values ('wallet leg ' || new.category);
    update public.wallet_balances_projection set withdrawable = withdrawable + new.amount where user_id = new.user_id;
  end if;
  return null;
end $$;
create trigger general_ledger_route_buckets after insert on public.general_ledger for each row execute function public.route_wallet();
create function public.no_ledger_edit() returns trigger language plpgsql as $$
begin raise exception 'general_ledger is append-only (%)', tg_op; end $$;
create trigger trg_prevent_ledger_update before update or delete on public.general_ledger for each row execute function public.no_ledger_edit();

create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare v_group uuid; e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  if idempotency_key is not null then
    select g.transaction_group_id into v_group from public.general_ledger g where g.idempotency_key = create_ledger_transaction.idempotency_key
      order by g.created_at limit 1;
    if v_group is not null then return v_group; end if;
  end if;
  for e in select * from jsonb_array_elements(entries) loop
    if (e->>'amount')::numeric <= 0 then raise exception 'All amounts must be positive'; end if;
    if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
  end loop;
  if not skip_balance_check and v_in <> v_out then raise exception 'Transaction not balanced. Total cash_in (%) <> total cash_out (%)', v_in, v_out; end if;
  v_group := gen_random_uuid();
  for e in select * from jsonb_array_elements(entries) loop
    insert into public.general_ledger (user_id, ledger_scope, direction, category, amount, description, source_table, source_id,
      transaction_group_id, idempotency_key, transaction_date, reference_id, classification)
    values ((e->>'user_id')::uuid, coalesce(e->>'ledger_scope', 'wallet'), e->>'direction', e->>'category', (e->>'amount')::numeric,
      e->>'description', coalesce(e->>'source_table', 'ledger_transaction'), (e->>'source_id')::uuid, v_group,
      create_ledger_transaction.idempotency_key, coalesce((e->>'transaction_date')::timestamptz, now()), e->>'reference_id',
      coalesce(e->>'classification', 'production'));
  end loop;
  return v_group;
end $$;

create table public.instalment_allocations (id uuid primary key default gen_random_uuid(), rent_request_id uuid, transaction_group_id uuid,
  instalment_id uuid default gen_random_uuid(), instalment_date timestamptz default now(), instalment_amount numeric,
  principal_component numeric, registration_fee_component numeric, access_fee_component numeric, partner_reward_component numeric,
  agent_commission_component numeric, platform_net_component numeric, source_table text, source_id uuid,
  created_at timestamptz default clock_timestamp(), split_version text, over_total_amount numeric, commission_paid_component numeric,
  reversed_at timestamptz, reversal_group_id uuid, reversal_reason text);
create function public.pool_tripwire() returns trigger language plpgsql as $$
begin insert into public.money_log (what) values ('landlord pool return trigger'); return null; end $$;
create trigger trg_zz_landlord_pool_return after insert or update of reversed_at on public.instalment_allocations
  for each row when (pg_trigger_depth() < 2 and current_setting('test.seeding', true) is distinct from 'on')
  execute function public.pool_tripwire();
create table public.rent_fee_collection_exceptions (id uuid primary key default gen_random_uuid(), rent_request_id uuid, collection_id uuid,
  source_table text, payment_amount numeric, reason text, detail jsonb, created_at timestamptz default now(),
  constraint rent_fee_exception_unique unique (source_table, collection_id, reason));
create function public.is_treasury_waterfall_scope(p uuid) returns boolean language sql stable as $$ select true $$;
create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, actor_id uuid, performed_by uuid,
  action_type text, table_name text, record_id text, reason text, old_values jsonb, new_values jsonb, metadata jsonb,
  created_at timestamptz default now());
create table public.plan_balance_duplicate_correction_20260929 (rent_request_id uuid primary key, correction numeric);
`;

// --- fixture --------------------------------------------------------------------------------------------------------
// t(h, m): 2026-09-15 h:m UTC. The guard window is 15:12:23 (15 Sep) .. 06:03:51 (16 Sep).
const t = (day: number, h: number, m: number) => `2026-09-${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+00`;

function seedSql() {
  const s: string[] = [];
  const plan = (n: number, total: number, repaid: number, rent: number, af: number, rf: number) =>
    s.push(`insert into public.rent_requests (id, tenant_id, agent_id, status, rent_amount, access_fee, request_fee, total_repayment, amount_repaid)
            values ('${PLAN(n)}', '${id('0009', n)}', '${AG}', 'repaying', ${rent}, ${af}, ${rf}, ${total}, ${repaid});`);
  // a receipt with the shape its era posted. kind: e2 (float debited), e3 (cash in transit only); landed: balance moved
  const rc = (n: number, p: number, amount: number, at: string, kind: 'e2' | 'e3', landed: boolean) => {
    s.push(`insert into public.agent_collections (id, agent_id, rent_request_id, amount, tracking_id, created_at)
            values ('${RC(n)}', '${AG}', '${PLAN(p)}', ${amount}, 'AGT-${n}', '${at}');`);
    if (kind === 'e3') {
      s.push(`insert into public.general_ledger (transaction_group_id, ledger_scope, direction, category, amount, source_table, source_id, created_at, transaction_date)
              values ('${G(n)}', 'platform', 'cash_in', 'cash_receipt_in_transit', ${amount}, 'agent_collections', '${PLAN(p)}', '${at}', '${at}'),
                     ('${G(n)}', 'platform', 'cash_out', 'tenant_repayment_collected', ${amount}, 'agent_collections', '${PLAN(p)}', '${at}', '${at}');`);
    } else {
      s.push(`set local test.seed_wallet = 'on';`);
      s.push(`insert into public.general_ledger (transaction_group_id, ledger_scope, direction, category, amount, source_table, source_id, created_at, transaction_date, user_id)
              values ('${G(n)}', 'platform', 'cash_in', 'tenant_repayment_collected', ${amount}, 'agent_collections', '${PLAN(p)}', '${at}', '${at}', null);`);
      s.push(`insert into public.general_ledger (transaction_group_id, ledger_scope, direction, category, amount, source_table, source_id, created_at, transaction_date, user_id)
              values ('${G(n)}', 'wallet', 'cash_out', 'agent_float_used_for_rent', ${amount}, 'agent_collections', '${RC(n)}', '${at}', '${at}', '${AG}');`);
    }
    if (landed) {
      s.push(`insert into public.rent_amount_change_log (rent_request_id, old_amount_repaid, new_amount_repaid, changed_at)
              values ('${PLAN(p)}', 0, ${amount}, '${at}');`);
    }
  };
  // P1 (item A): 18 Sep-style tenant: 3 receipts dropped by the guard (unlanded), clean-up left repaid at 100,000
  plan(1, 685000, 100000, 500000, 150000, 35000);
  rc(101, 1, 20000, t(14, 9, 0), 'e3', true);
  rc(102, 1, 100000, t(15, 20, 0), 'e3', false);
  rc(103, 1, 50000, t(15, 21, 0), 'e3', false);
  rc(104, 1, 30000, t(15, 22, 0), 'e3', false);
  rc(105, 1, 80000, t(16, 7, 0), 'e3', true);
  // P2 (item B): collected above total. E2 200,000 + E3 150,000 (landed) + E3 100,000 (dropped) = 450,000 vs 300,000
  plan(2, 300000, 300000, 250000, 40000, 10000);
  rc(201, 2, 200000, t(14, 10, 0), 'e2', true);
  rc(202, 2, 150000, t(16, 6, 30), 'e3', true);
  rc(203, 2, 100000, t(15, 23, 0), 'e3', false);
  // P3 (A and B): total 200,000, receipts 260,000 (E2 50,000, two dropped E3 110,000 + 100,000), repaid 50,000
  plan(3, 200000, 50000, 160000, 30000, 10000);
  rc(301, 3, 50000, t(14, 11, 0), 'e2', true);
  rc(302, 3, 110000, t(15, 19, 0), 'e3', false);
  rc(303, 3, 100000, t(15, 19, 30), 'e3', false);
  s.push(`insert into public.plan_balance_duplicate_correction_20260929 values ('${PLAN(1)}', 180000), ('${PLAN(3)}', 160000);`);
  // P4 (item C2): older fee path, two allocations of 600 on a 1,000 Rent Plan (rent 800, access 150, request 50)
  plan(4, 1000, 1000, 800, 150, 50);
  const feeGroup = (g: number, alloc: number, p: number, rf: number, af: number, at: string, collection: string) =>
    s.push(`insert into public.general_ledger (transaction_group_id, ledger_scope, direction, category, amount, source_table, source_id, transaction_date, idempotency_key)
            values ('${G(g)}', 'platform', 'cash_out', 'treasury_fee_drawdown', ${rf + af}, 'agent_collections', '${collection}', '${at}', 'rent-fee-collection:agent_collections:${collection}'),
                   ('${G(g)}', 'platform', 'cash_in', 'registration_fee_collected', ${rf}, 'agent_collections', '${collection}', '${at}', 'rent-fee-collection:agent_collections:${collection}'),
                   ('${G(g)}', 'platform', 'cash_in', 'access_fee_collected', ${af}, 'agent_collections', '${collection}', '${at}', 'rent-fee-collection:agent_collections:${collection}');`);
  s.push(`insert into public.instalment_allocations (id, rent_request_id, transaction_group_id, instalment_amount, principal_component, registration_fee_component, access_fee_component, source_table, source_id, created_at)
          values ('${AL(1)}', '${PLAN(4)}', '${G(401)}', 600, 480, 30, 90, 'agent_collections', '${RC(401)}', '${t(15, 20, 0)}'),
                 ('${AL(2)}', '${PLAN(4)}', '${G(402)}', 600, 480, 30, 90, 'agent_collections', '${RC(402)}', '${t(15, 21, 0)}');`);
  feeGroup(401, 1, 4, 30, 90, t(15, 20, 0), RC(401));
  feeGroup(402, 2, 4, 30, 90, t(15, 21, 0), RC(402));
  // P5 (item C3): a reversed collection whose fee posting was never reversed
  plan(5, 1000, 0, 800, 150, 50);
  s.push(`insert into public.agent_collections (id, agent_id, rent_request_id, amount, created_at, reversed_at, notes)
          values ('${RC(501)}', '${AG}', '${PLAN(5)}', 500, '${t(10, 8, 0)}', '${t(10, 9, 0)}', '[REVERSED: system correction]');`);
  s.push(`insert into public.instalment_allocations (id, rent_request_id, transaction_group_id, instalment_amount, principal_component, registration_fee_component, access_fee_component, source_table, source_id, reversed_at, reversal_reason)
          values ('${AL(3)}', '${PLAN(5)}', '${G(501)}', 500, 400, 25, 75, 'agent_collections', '${RC(501)}', '${t(10, 9, 0)}', 'Marker copied from reversed agent collection');`);
  feeGroup(501, 3, 5, 25, 75, t(10, 8, 0), RC(501));
  // already-reversed pair (like the 440 of 2026-10-01): original 601, reversal 602
  plan(6, 1000, 0, 800, 150, 50);
  s.push(`insert into public.instalment_allocations (id, rent_request_id, transaction_group_id, instalment_amount, principal_component, registration_fee_component, access_fee_component, source_table, source_id, reversed_at, reversal_group_id)
          values ('${AL(4)}', '${PLAN(6)}', '${G(601)}', 400, 320, 20, 60, 'agent_collections', '${RC(601)}', '${t(16, 14, 0)}', '${G(602)}');`);
  feeGroup(601, 4, 6, 20, 60, t(15, 22, 0), RC(601));
  s.push(`insert into public.general_ledger (transaction_group_id, ledger_scope, direction, category, amount, source_table, transaction_date, idempotency_key)
          values ('${G(602)}', 'platform', 'cash_in', 'treasury_fee_drawdown', 80, 'instalment_allocations', '${t(15, 22, 0)}', 'fee_rev_floatgate:x'),
                 ('${G(602)}', 'platform', 'cash_out', 'registration_fee_collected', 20, 'instalment_allocations', '${t(15, 22, 0)}', 'fee_rev_floatgate:x'),
                 ('${G(602)}', 'platform', 'cash_out', 'access_fee_collected', 60, 'instalment_allocations', '${t(15, 22, 0)}', 'fee_rev_floatgate:x');`);
  // the 16 Sep contra pair and a genuine Money In row
  s.push(`insert into public.general_ledger (transaction_group_id, ledger_scope, direction, category, amount, source_table, transaction_date)
          values ('${CONTRA}', 'platform', 'cash_out', 'cash_receipt_in_transit', 5000, 'agent_collections', '${t(16, 14, 10)}'),
                 ('${CONTRA}', 'platform', 'cash_in', 'tenant_repayment_collected', 5000, 'agent_collections', '${t(16, 14, 10)}'),
                 ('${G(900)}', 'platform', 'cash_in', 'tenant_repayment_collected', 777, 'agent_collections', '${t(20, 9, 0)}');`);
  s.push(`insert into public.wallets_physical values ('${AG}', 0); insert into public.wallet_balances_projection values ('${AG}', 1000, 5000);`);
  s.push(`insert into public.deposit_requests values ('${id('0005', 1)}', 1000, 'approved'); insert into public.withdrawal_requests values ('${id('0006', 1)}', 1000, 'pending');`);
  s.push(`insert into public.user_roles values ('${CFO}', 'cfo');`);
  return s.join('\n');
}

// Expected schedule for this fixture (the production values are in the script; the test swaps in the fixture's).
//   A: P1 credit 180,000 (repaid 100,000 -> 280,000); P3 after B: least(260,000 - 60,000, 200,000) - 50,000 = 150,000
//   B: P2 excess 150,000 from the landed E3 202 (150,000); P3 excess 60,000 from the newest dropped E3 303
//   C2: P4 second allocation: booked fee 120, correct fee(1000) - fee(600) = 200 - 120 = 80 -> excess 40 (rf 10, af 30)
//   C3: P5 fees 100
const FIXTURE_EXPECTED = `('A', 2, 330000), ('B', 2, 210000), ('C2', 1, 40), ('C3', 1, 100)`;
const PROD_EXPECTED = `('A', 18, 2167625), ('B', 56, 8302829), ('C2', 21, 890537), ('C3', 23, 1469794)`;
const corrWith = (expected: string, decisions = '') => {
  expect(CORR).toContain(PROD_EXPECTED);
  let s = CORR.replace(PROD_EXPECTED, expected);
  if (decisions) s = s.replace('-- insert into _field_decisions (receipt_id, decision, evidence)', `insert into _field_decisions values ${decisions};\n--`);
  return s;
};

async function fresh() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(COMPUTE);
  await db.exec(`begin; set local test.seeding = 'on'; ${seedSql()} commit;`);
  await db.exec(`delete from public.money_log;`);
  await db.exec(MIG_D);
  await db.exec(MIG_E);
  return db;
}
const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string) => (await db.query<T>(sql)).rows;
const one = async <T = Record<string, unknown>>(db: PGlite, sql: string) => (await rows<T>(db, sql))[0];
const moneyIn = async (db: PGlite, from = '2026-09-01', to = '2026-09-30') => {
  await db.exec(`set test.uid = '${CFO}'`);
  const r = await rows<{ category_key: string; amount: string }>(db, `select category_key, amount from public.get_cfo_received_by_category_totals('${from}', '${to}')`);
  await db.exec(`reset test.uid`);
  return Object.fromEntries(r.map((x) => [x.category_key, Number(x.amount)]));
};
const snapshot = async (db: PGlite) => ({
  money: await rows(db, `select what from public.money_log`),
  walletLegs: await one(db, `select count(*)::int n, coalesce(sum(amount), 0)::numeric s from public.general_ledger where ledger_scope = 'wallet'`),
  wallets: await rows(db, `select * from public.wallet_balances_projection order by user_id`),
  collections: await rows(db, `select * from public.agent_collections order by id`),
  statuses: await rows(db, `select id, status from public.rent_requests order by id`),
});

describe('D: Money In exclusions and the correction register (migration 20261108150000)', () => {
  let db: PGlite;
  beforeEach(async () => { db = await fresh(); });

  it('seeds the 16 Sep contra and both sides of every fee posting already reversed', async () => {
    const x = await rows<{ transaction_group_id: string }>(db, `select transaction_group_id from public.money_in_report_exclusions order by 1`);
    expect(x.map((r) => r.transaction_group_id).sort()).toEqual([CONTRA, G(601), G(602)].sort());
  });

  it('Money In no longer counts the contra or the reversed fee as money received; real receipts still count', async () => {
    // land: float-backed receipts 201 (200,000) and 301 (50,000) + genuine 777 count; the contra (5,000) no longer does
    const after = await moneyIn(db);
    expect(after.land).toBe(250777);
    expect(after.fees).toBe(90 + 90 + 75); // P4 x2 + P5 (not yet reversed); reversed P6 (60) excluded
    await db.exec(RB_D);
    const before = await moneyIn(db);
    expect(before.land).toBe(255777);
    expect(before.fees).toBe(90 + 90 + 75 + 60);
  });

  it('an allocation reversed later is excluded on both sides automatically', async () => {
    await db.exec(`update public.instalment_allocations set reversal_group_id = '${G(999)}' where id = '${AL(1)}'`);
    const x = await rows(db, `select 1 from public.money_in_report_exclusions where transaction_group_id in ('${G(401)}', '${G(999)}')`);
    expect(x).toHaveLength(2);
  });

  it('tables are read-only to staff (select only), RLS on, staff-MFA policy present', async () => {
    for (const tbl of ['money_in_report_exclusions', 'accounting_correction_register']) {
      const g = await one<Record<string, boolean>>(db, `select has_table_privilege('authenticated', 'public.${tbl}', 'select') s,
        has_table_privilege('authenticated', 'public.${tbl}', 'insert') i, has_table_privilege('authenticated', 'public.${tbl}', 'update') u,
        has_table_privilege('authenticated', 'public.${tbl}', 'delete') d, has_table_privilege('anon', 'public.${tbl}', 'select') a`);
      expect(g).toEqual({ s: true, i: false, u: false, d: false, a: false });
      const p = await rows(db, `select 1 from pg_policies where tablename = '${tbl}' and policyname = 'mfa_required_for_staff' and permissive = 'RESTRICTIVE'`);
      expect(p).toHaveLength(1);
    }
  });
});

describe('Preview (read-only) and the posting script agree on the schedule', () => {
  it('preview lists exactly the fixture schedule and writes nothing', async () => {
    const db = await fresh();
    const before = await one(db, `select (select count(*) from public.general_ledger)::int gl, (select count(*) from public.money_log)::int ml`);
    await db.exec('begin transaction read only');
    const r = await rows<{ k: string; v: string }>(db, PREVIEW);
    await db.exec('commit');
    const by = (k: string) => r.filter((x) => x.k === k).map((x) => JSON.parse(x.v));
    expect(by('A').map((a) => [a.rent_plan, Number(a.credit)]).sort()).toEqual([[PLAN(1), 180000], [PLAN(3), 150000]]);
    expect(by('B').map((b) => [b.receipt_id, Number(b.contra)]).sort()).toEqual([[RC(202), 150000], [RC(303), 60000]]);
    expect(by('C2').map((c) => [c.allocation, Number(c.excess), Number(c.rf_ok), Number(c.af_ok)])).toEqual([[AL(2), 40, 20, 60]]);
    expect(by('C3').map((c) => [c.allocation, Number(c.fees)])).toEqual([[AL(3), 100]]);
    expect(await one(db, `select (select count(*) from public.general_ledger)::int gl, (select count(*) from public.money_log)::int ml`)).toEqual(before);
  });
});

describe('Posting script: accounting only, no money movement', () => {
  let db: PGlite;
  beforeEach(async () => { db = await fresh(); });

  it('posts the schedule and nothing that holds or moves money changes', async () => {
    const before = await snapshot(db);
    await db.exec(corrWith(FIXTURE_EXPECTED));
    const after = await snapshot(db);
    expect(after).toEqual(before); // no wallet leg, wallet, collection, status or tripwire change
    expect(after.money).toEqual([]);
  });

  it('A: tenant balances restored on amount_repaid only, status unchanged, logged as CFO-approved', async () => {
    await db.exec(corrWith(FIXTURE_EXPECTED));
    const p = await rows<{ id: string; amount_repaid: string; status: string }>(db,
      `select id, amount_repaid, status from public.rent_requests where id in ('${PLAN(1)}', '${PLAN(3)}') order by id`);
    expect(p.map((x) => [Number(x.amount_repaid), x.status])).toEqual([[280000, 'repaying'], [200000, 'repaying']]);
    const log = await rows<{ source: string }>(db, `select source from public.rent_amount_change_log where source is not null`);
    expect(log.map((l) => l.source)).toEqual(['cfo_approved_acct_corr_202611_unlanded_collections', 'cfo_approved_acct_corr_202611_unlanded_collections']);
    const reg = await one<{ detail: { reaches_total: boolean; receipts_dropped_by_guard: unknown[] } }>(db,
      `select detail from public.accounting_correction_register where correction_item = 'A' and source_id = '${PLAN(3)}'`);
    expect(reg.detail.reaches_total).toBe(true); // flagged for the CFO: status deliberately left as is
    expect(reg.detail.receipts_dropped_by_guard).toHaveLength(2);
    const nGl = await one<{ n: number }>(db, `select count(*)::int n from public.general_ledger where idempotency_key like 'acct_corr_202611:A%'`);
    expect(nGl.n).toBe(0); // item A posts no journal: the ledger already has these receipts
  });

  it('B: CR A5 / DR A3 per unsupported receipt, linked to the original legs; float-backed receipts untouched', async () => {
    await db.exec(corrWith(FIXTURE_EXPECTED));
    const legs = await rows<{ source_id: string; category: string; direction: string; amount: string; ledger_scope: string; reference_id: string }>(db,
      `select source_id, category, direction, amount, ledger_scope, reference_id from public.general_ledger
        where idempotency_key like 'acct_corr_202611:B:%' order by source_id, category`);
    expect(legs.map((l) => [l.source_id, l.category, l.direction, Number(l.amount), l.ledger_scope])).toEqual([
      [RC(202), 'cash_receipt_in_transit', 'cash_out', 150000, 'platform'], [RC(202), 'tenant_repayment_collected', 'cash_in', 150000, 'platform'],
      [RC(303), 'cash_receipt_in_transit', 'cash_out', 60000, 'platform'], [RC(303), 'tenant_repayment_collected', 'cash_in', 60000, 'platform'],
    ]);
    expect(legs[0].reference_id).toBe(G(202));
    const reg = await rows<{ source_id: string; original_leg_ids: string[] }>(db,
      `select source_id, original_leg_ids from public.accounting_correction_register where correction_item = 'B' order by source_id`);
    for (const r of reg) expect(r.original_leg_ids).toHaveLength(2);
    expect(reg.map((r) => r.source_id)).not.toContain(RC(201)); // E2 (float debited) never contra'd
  });

  it('C2: original fee group reversed in full and the capped fee rebooked; C3: reversed and linked', async () => {
    await db.exec(corrWith(FIXTURE_EXPECTED));
    const c2 = await one<{ correction_group_id: string; rebook_group_id: string; amount: string }>(db,
      `select correction_group_id, rebook_group_id, amount from public.accounting_correction_register where correction_item = 'C2'`);
    expect(Number(c2.amount)).toBe(40);
    const rev = await rows<{ category: string; direction: string; amount: string }>(db,
      `select category, direction, amount from public.general_ledger where transaction_group_id = '${c2.correction_group_id}' order by category`);
    expect(rev.map((l) => [l.category, l.direction, Number(l.amount)])).toEqual([
      ['access_fee_collected', 'cash_out', 90], ['registration_fee_collected', 'cash_out', 30], ['treasury_fee_drawdown', 'cash_in', 120]]);
    const reb = await rows<{ category: string; direction: string; amount: string }>(db,
      `select category, direction, amount from public.general_ledger where transaction_group_id = '${c2.rebook_group_id}' order by category`);
    expect(reb.map((l) => [l.category, l.direction, Number(l.amount)])).toEqual([
      ['access_fee_collected', 'cash_in', 60], ['registration_fee_collected', 'cash_in', 20], ['treasury_fee_drawdown', 'cash_out', 80]]);
    const al = await one<{ reversal_group_id: string; reversed_at: string }>(db, `select reversal_group_id, reversed_at from public.instalment_allocations where id = '${AL(3)}'`);
    expect(al.reversal_group_id).toBeTruthy();
    const c3 = await rows<{ category: string; direction: string; amount: string }>(db,
      `select category, direction, amount from public.general_ledger where transaction_group_id = '${al.reversal_group_id}' order by category`);
    expect(c3.map((l) => [l.category, l.direction, Number(l.amount)])).toEqual([
      ['access_fee_collected', 'cash_out', 75], ['registration_fee_collected', 'cash_out', 25], ['treasury_fee_drawdown', 'cash_in', 100]]);
    // the allocation rows themselves are not rewritten (only C3 gains its reversal link)
    const a2 = await one<{ access_fee_component: string; reversed_at: string | null }>(db, `select access_fee_component, reversed_at from public.instalment_allocations where id = '${AL(2)}'`);
    expect([Number(a2.access_fee_component), a2.reversed_at]).toEqual([90, null]);
  });

  it('every correction journal is platform-only and balanced, dated like the entry it corrects', async () => {
    await db.exec(corrWith(FIXTURE_EXPECTED));
    const g = await rows<{ n: number; nonplat: number; net: string }>(db, `select count(*)::int n, count(*) filter (where ledger_scope <> 'platform')::int nonplat,
       sum(case when direction = 'cash_in' then amount else -amount end) net from public.general_ledger where idempotency_key like 'acct_corr_202611:%' group by transaction_group_id`);
    expect(g.length).toBe(2 + 2 + 1); // B x2, C2 reverse + rebook, C3
    for (const x of g) { expect(x.nonplat).toBe(0); expect(Number(x.net)).toBe(0); }
    const d = await rows<{ td: string }>(db, `select distinct to_char(transaction_date at time zone 'UTC', 'YYYY-MM-DD') td from public.general_ledger where idempotency_key like 'acct_corr_202611:%' order by 1`);
    expect(d.map((x) => x.td)).toEqual(['2026-09-10', '2026-09-15', '2026-09-16']);
  });

  it('Money In: corrections are not money; the rebooked fee is the true fee', async () => {
    const before = await moneyIn(db);
    await db.exec(corrWith(FIXTURE_EXPECTED));
    const after = await moneyIn(db);
    expect(after.land).toBe(before.land); // B contra DR A3 (cash_in) never shows as tenant money
    expect(after.fees).toBe(before.fees - 90 - 75 + 60); // C2 original out, rebook (60) in; C3 original out
  });

  it('cannot post twice: the batch stops and nothing new is written', async () => {
    await db.exec(corrWith(FIXTURE_EXPECTED));
    const n = await one(db, `select (select count(*) from public.general_ledger)::int gl, (select count(*) from public.accounting_correction_register)::int reg`);
    await expect(db.exec(corrWith(FIXTURE_EXPECTED))).rejects.toThrow(/already posted/);
    await db.exec('rollback').catch(() => undefined);
    expect(await one(db, `select (select count(*) from public.general_ledger)::int gl, (select count(*) from public.accounting_correction_register)::int reg`)).toEqual(n);
  });

  it('stops, writing nothing, when production does not match the approved schedule', async () => {
    const n = await one(db, `select (select count(*) from public.general_ledger)::int gl, (select sum(amount_repaid) from public.rent_requests)::numeric r`);
    await expect(db.exec(corrWith(`('A', 2, 330001), ('B', 2, 210000), ('C2', 1, 40), ('C3', 1, 100)`))).rejects.toThrow(/STOP: item A/);
    await db.exec('rollback').catch(() => undefined);
    expect(await one(db, `select (select count(*) from public.general_ledger)::int gl, (select sum(amount_repaid) from public.rent_requests)::numeric r`)).toEqual(n);
  });

  it('field rulings: "received" keeps a receipt out of B; "not_received" contras it in full and keeps it out of A', async () => {
    // RC 202 confirmed received -> P2 excess taken from the dropped 203 (100,000) instead, 50,000 stays a supported overpayment.
    // RC 102 (P1, dropped) ruled not received -> contra'd in full; P1 credit falls by 100,000.
    const dec = `('${RC(202)}', 'received', 'handover slip'), ('${RC(102)}', 'not_received', 'tenant denies')`;
    await db.exec(corrWith(`('A', 2, 230000), ('B', 3, 260000), ('C2', 1, 40), ('C3', 1, 100)`, dec));
    const b = await rows<{ source_id: string; amount: string }>(db, `select source_id, amount from public.accounting_correction_register where correction_item = 'B' order by source_id`);
    expect(b.map((x) => [x.source_id, Number(x.amount)])).toEqual([[RC(102), 100000], [RC(203), 100000], [RC(303), 60000]]);
    const p1 = await one<{ amount_repaid: string }>(db, `select amount_repaid from public.rent_requests where id = '${PLAN(1)}'`);
    expect(Number(p1.amount_repaid)).toBe(180000);
  });

  it('rollback: counter-entries only (nothing deleted), balances and Money In back to where they were', async () => {
    const mi0 = await moneyIn(db);
    const rr0 = await rows(db, `select id, amount_repaid, status from public.rent_requests order by id`);
    await db.exec(corrWith(FIXTURE_EXPECTED));
    const glAfterPost = await one<{ n: number }>(db, `select count(*)::int n from public.general_ledger`);
    await db.exec(ROLLBACK);
    expect(await rows(db, `select id, amount_repaid, status from public.rent_requests order by id`)).toEqual(rr0);
    expect(await moneyIn(db)).toEqual(mi0);
    const glAfterRb = await one<{ n: number }>(db, `select count(*)::int n from public.general_ledger`);
    expect(glAfterRb.n).toBeGreaterThan(glAfterPost.n); // append-only
    const net = await rows<{ category: string; net: string }>(db, `select category, sum(case when direction = 'cash_in' then amount else -amount end) net
      from public.general_ledger where idempotency_key like 'acct_corr_202611:%' group by category`);
    for (const x of net) expect(Number(x.net)).toBe(0);
    const reg = await one<{ open: number }>(db, `select count(*) filter (where rolled_back_at is null)::int open from public.accounting_correction_register`);
    expect(reg.open).toBe(0);
    expect(await rows(db, `select what from public.money_log`)).toEqual([]);
  });
});

describe('E: older fee path capped at the Rent Plan fee, reversed allocations ignored (migration 20261108150100)', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await fresh();
    await db.exec(`insert into public.rent_requests (id, status, rent_amount, access_fee, request_fee, total_repayment) values ('${PLAN(7)}', 'repaying', 800, 150, 50, 1000)`);
  });
  const post = (n: number, amount: number) =>
    one<{ r: Record<string, unknown> }>(db, `select public._post_rent_fee_collection_legacy('${PLAN(7)}', ${amount}, 'agent_collections', '${RC(700 + n)}') r`);
  const fees = async () => Number((await one<{ f: string }>(db, `select coalesce(sum(registration_fee_component + access_fee_component), 0) f
     from public.instalment_allocations where rent_request_id = '${PLAN(7)}' and reversed_at is null`)).f);

  it('fees stop at the Rent Plan fee; cash above the total is recorded and filed, with no fee', async () => {
    await db.exec(`insert into public.general_ledger (ledger_scope, direction, category, amount, source_table, source_id) values ('platform', 'cash_in', 'treasury_fee_recognised', 200, 'rent_requests', '${PLAN(7)}')`);
    await post(1, 600);
    await post(2, 600);
    await post(3, 300);
    expect(await fees()).toBe(200);
    const over = await rows<{ over_total_amount: string }>(db, `select over_total_amount from public.instalment_allocations where rent_request_id = '${PLAN(7)}' order by created_at`);
    expect(over.map((o) => Number(o.over_total_amount))).toEqual([0, 200, 300]);
    const ex = await rows(db, `select 1 from public.rent_fee_collection_exceptions where rent_request_id = '${PLAN(7)}' and reason = 'collection_above_plan_total'`);
    expect(ex).toHaveLength(2);
    const drawn = await one<{ s: string }>(db, `select sum(amount) s from public.general_ledger where category = 'treasury_fee_drawdown' and source_id in ('${RC(701)}', '${RC(702)}', '${RC(703)}')`);
    expect(Number(drawn.s)).toBe(200);
  });

  it('a reversed allocation no longer counts toward the running total', async () => {
    await db.exec(`insert into public.general_ledger (ledger_scope, direction, category, amount, source_table, source_id) values ('platform', 'cash_in', 'treasury_fee_recognised', 200, 'rent_requests', '${PLAN(7)}')`);
    await post(1, 600);
    await db.exec(`set test.seeding = 'on'; update public.instalment_allocations set reversed_at = now() where source_id = '${RC(701)}'; reset test.seeding;`);
    const r = await post(2, 600);
    expect(Number((r.r as { access_fee_collected: number }).access_fee_collected) + Number((r.r as { registration_fee_collected: number }).registration_fee_collected)).toBe(120);
    expect(Number((r.r as { amount_above_total: number }).amount_above_total)).toBe(0);
  });

  it('rollback restores the previous (uncapped) behaviour', async () => {
    await db.exec(RB_E);
    await db.exec(`insert into public.general_ledger (ledger_scope, direction, category, amount, source_table, source_id) values ('platform', 'cash_in', 'treasury_fee_recognised', 200, 'rent_requests', '${PLAN(7)}')`);
    await post(1, 600);
    await post(2, 600);
    expect(await fees()).toBe(240);
  });
});

describe('Static safety checks on the correction scripts', () => {
  const body = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  it.each([['posting', CORR], ['rollback', ROLLBACK], ['preview', PREVIEW]])('%s never edits money tables or deletes ledger rows', (_n, s) => {
    const b = body(s).toLowerCase();
    expect(b).not.toMatch(/update\s+public\.(general_ledger|agent_collections|wallets|wallets_physical|wallet_balances_projection|deposit_requests|withdrawal_requests)/);
    expect(b).not.toMatch(/delete\s+from\s+public\.(general_ledger|agent_collections|wallets|deposit_requests|withdrawal_requests)/);
    expect(b).not.toMatch(/'ledger_scope',\s*'wallet'/);
    expect(b).not.toMatch(/set\s+status\s*=/);
  });
  it('preview is plain SELECT (safe in a read-only transaction)', () => {
    expect(body(PREVIEW).toLowerCase()).not.toMatch(/\b(insert|update|delete|create|drop|alter)\b/);
  });
  it('user-facing descriptions use the regulatory terms', () => {
    const text = body(CORR + ROLLBACK).toLowerCase();
    expect(text).not.toMatch(/\bloan\b|\blender\b|\broi\b|\binterest\b/);
  });
});
