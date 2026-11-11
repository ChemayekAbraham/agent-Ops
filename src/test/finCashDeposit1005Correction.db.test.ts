// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped JSON / rows returned by SQL */
/**
 * DRAFT correction docs/finance/corrections/2026-11-10_cash_deposit_1005m_correction.sql, run verbatim on PGlite against
 * PRODUCTION's ledger resolver (fixture sofp_ledger_legs.live.sql) with the production leg shapes of 3 Nov 2026:
 * the 1,005,000,000 cash deposit group and the 900,538,843 float removal to the platform bucket.
 * Proves: without the CFO-confirmed amount it refuses to run; with 100,000,000 it leaves A5 and L1 at 100M, removes the
 * false X6 loss, restores A2, writes no wallet leg and cannot run twice.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');
const CORR = read('docs/finance/corrections/2026-11-10_cash_deposit_1005m_correction.sql');
const MIG = read('supabase/migrations/20261111110000_float_restatement_correction_category.sql');
const DEP = 'c18ee41c-41fd-4d05-ab5e-ebaa2fed0e14';
const OP = '59d45ad2-0d44-433c-b4ec-20927a25c281';
const G1 = '00000000-0000-0000-00cc-000000000001';
const G2 = '00000000-0000-0000-00cc-000000000002';

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid, reference_id text,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
  account_code text, debit_when text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.ledger_account_catalog (code text primary key, label text, section text, nature text, sort_order int, created_at timestamptz default now());
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
create function public.ledger_category_allowlist_base() returns text[] language sql immutable as $$ select array['system_balance_correction'] $$;
insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values
 ('A2','Float','current_asset','asset',2), ('A5','Cash in transit','current_asset','asset',5), ('A8','Float cycle','current_asset','asset',8),
 ('A9','Suspense','current_asset','asset',9), ('L1','Wallet custody','current_liability','liability',31),
 ('E3','Legacy','equity','equity',43), ('X6','Float restatement','expense','expense',66);
-- production mapping rows for the categories involved (10 Nov 2026)
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','agent_float_assignment',null,'A8','cash_in'), ('wallet','agent_float_assignment',null,'A2','cash_in'),
 ('platform','agent_float_cash_offset',null,'A2','cash_in'), ('platform','agent_float_deposit',null,'A8','cash_in'),
 ('wallet','agent_float_deposit',null,'A2','cash_in'), ('platform','cash_custody_payable',null,'L1','cash_in'),
 ('platform','cash_receipt_in_transit',null,'A5','cash_in');
create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  if idempotency_key is not null and exists (select 1 from public.general_ledger x where x.idempotency_key = create_ledger_transaction.idempotency_key) then
    raise exception 'duplicate idempotency key %', idempotency_key; end if;
  for e in select * from jsonb_array_elements(entries) loop
    if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
    insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table, source_id, reference_id, description, idempotency_key)
    values (g, coalesce((e->>'transaction_date')::timestamptz, now()), e->>'ledger_scope', e->>'category', e->>'direction', (e->>'amount')::numeric,
            e->>'source_table', (e->>'source_id')::uuid, e->>'reference_id', e->>'description', create_ledger_transaction.idempotency_key);
  end loop;
  if abs(v_in - v_out) > 0.5 then raise exception 'group not balanced'; end if;
  return g;
end $$;
create table public.deposit_requests (id uuid primary key, amount numeric, status text, provider text);
insert into public.deposit_requests values ('${DEP}', 1005000000, 'approved', 'cash_deposit');
create table public.accounting_correction_register (id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null,
  action text not null, source_table text not null, source_id uuid not null, rent_request_id uuid, original_group_id uuid, original_leg_ids uuid[],
  correction_group_id uuid, rebook_group_id uuid, amount numeric not null, before_value numeric, after_value numeric, detail jsonb default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz);
create table public.money_in_report_exclusions (transaction_group_id uuid primary key, reason text, correction_item text, reverses_group_id uuid);
create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, action_type text, action text, table_name text,
  record_id text, reason text, metadata jsonb, created_at timestamptz default now());

-- production shapes, 3 Nov 2026
insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, user_id, source_table, source_id, reference_id) values
 ('${G1}','2026-11-03 08:45:27+00','wallet','agent_float_deposit','cash_in',1005000000,'float','${OP}','deposit_requests','${DEP}','CASHREQ-2660d454-14c0-49d9'),
 ('${G1}','2026-11-03 08:45:27+00','platform','agent_float_cash_offset','cash_out',1005000000,null,null,'deposit_requests','${DEP}',null),
 ('${G1}','2026-11-03 08:45:27+00','platform','cash_receipt_in_transit','cash_in',1005000000,null,null,'deposit_requests','${DEP}',null),
 ('${G1}','2026-11-03 08:45:27+00','platform','cash_custody_payable','cash_out',1005000000,null,null,'deposit_requests','${DEP}',null),
 ('${G2}','2026-11-03 08:50:40+00','wallet','agent_float_assignment','cash_out',900538843,'float','${OP}','finops_wallet_move',null,'ECW-3115252146'),
 ('${G2}','2026-11-03 08:50:40+00','platform','system_balance_correction','cash_in',900538843,null,null,'finops_wallet_move',null,'ECW-3115252146');
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const acct = async (code: string) => Number((await q<{ v: string }>(
  `select coalesce(round(sum(case when c.nature in ('asset','expense') then l.dr - l.cr else l.cr - l.dr end)),0) v
     from public.sofp_ledger_legs(now()) l join public.ledger_account_catalog c on c.code = l.account_code where l.account_code = '${code}'`))[0].v);
const groupResiduals = async () => q(`select transaction_group_id::text g, round(sum(dr - cr)) r from public.sofp_ledger_legs(now())
  where not is_legacy_counterpart group by 1 having abs(sum(dr - cr)) > 0.5`);
const UNSET = CORR.replace(/\('confirmed_real_amount', '\d+'\)/, `('confirmed_real_amount', null)`);
const withAmount = (amt: string) => UNSET.replace(`('confirmed_real_amount', null)`, `('confirmed_real_amount', '${amt}')`);

describe('DRAFT: correction of the over-recorded 1,005,000,000 cash deposit', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(RESOLVER);
  });

  it('reproduces production: A5 and L1 carry 1,005M, X6 carries a 900.5M loss, A2 is down 900.5M', async () => {
    expect(await acct('A5')).toBe(1_005_000_000);
    expect(await acct('L1')).toBe(1_005_000_000);
    expect(await acct('X6')).toBe(900_538_843);
    expect(await acct('A2')).toBe(-900_538_843);
    expect(await groupResiduals()).toEqual([]);
  });

  it('refuses to run before the X6 category migration', async () => {
    await expect(db.exec(withAmount('100000000'))).rejects.toThrow(/apply migration 20261111110000/);
    await db.exec('rollback');
    await db.exec(MIG);
    expect((await q(`select 'float_restatement_correction' = any(public.ledger_category_allowlist()) ok`))[0].ok).toBe(true);
  });

  it('refuses to run until the CFO confirms the real amount', async () => {
    await expect(db.exec(UNSET)).rejects.toThrow(/confirmed_real_amount is not set/);
    expect(UNSET).not.toBe(CORR);
    await db.exec('rollback');
    expect((await q(`select count(*)::int n from public.general_ledger where idempotency_key like 'acct_corr_202611_cash1005:%'`))[0].n).toBe(0);
  });

  it('with 100,000,000 confirmed: A5 and L1 = 100M, X6 = 0, A2 = 0, platform-only, every group balanced', async () => {
    await db.exec(withAmount('100000000'));
    expect(await acct('A5')).toBe(100_000_000);
    expect(await acct('L1')).toBe(100_000_000);
    expect(await acct('X6')).toBe(0);
    expect(await acct('A2')).toBe(0);
    expect(await groupResiduals()).toEqual([]);
    expect((await q(`select count(*)::int n from public.general_ledger where idempotency_key like 'acct_corr_202611_cash1005:%' and ledger_scope <> 'platform'`))[0].n).toBe(0);
    const reg = await q(`select correction_item, amount::numeric a, detail->>'residual_float_without_cash' r from public.accounting_correction_register order by 1`);
    expect(reg.map((r: any) => [r.correction_item, Number(r.a)])).toEqual([['C1', 905_000_000], ['C2', 900_538_843]]);
    expect(Number(reg[1].r)).toBe(4_461_157);
    expect((await q(`select count(*)::int n from public.money_in_report_exclusions`))[0].n).toBe(2);
  });

  it('cannot run twice', async () => {
    await expect(db.exec(withAmount('100000000'))).rejects.toThrow(/already posted/);
    await db.exec('rollback');
  });
});
