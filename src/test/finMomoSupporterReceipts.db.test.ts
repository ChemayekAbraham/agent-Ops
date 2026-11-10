// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped JSON / rows returned by SQL */
/**
 * DRAFT correction docs/finance/corrections/2026-11-10_momo_supporter_receipts.sql, run verbatim (schedule replaced by
 * two sample deposits) on PGlite against PRODUCTION's ledger resolver (fixture sofp_ledger_legs.live.sql), with the
 * production leg shapes: a mobile-money deposit routed to float (wallet agent_float_deposit DR A2 / platform
 * agent_float_deposit CR A8) and the payer's own portfolio paid from that float (wallet partner_funding DR L1 /
 * platform partner_funding CR L2).
 * Proves: after the correction the receipt is cash (A1) and the portfolio is funded from it (net DR A1 / CR L2); A8, A2
 * and L1 are released by exactly the corrected amount; the unused part of a deposit stays as float; every group is
 * balanced, platform-only, excluded from Money In; the batch cannot run twice.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');
const BATCH = read('docs/finance/corrections/2026-11-10_momo_supporter_receipts.sql');
const id = (p: string, k: number) => `00000000-0000-0000-${p}-${String(k).padStart(12, '0')}`;
const DEP = (k: number) => id('0de0', k); const OG = (k: number) => id('0060', k); const PG = (k: number) => id('0070', k);
const SUP = (k: number) => id('05e0', k); const PF = (k: number) => id('0bf0', k);

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
insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values
 ('A1','Cash','current_asset','asset',1), ('A2','Float','current_asset','asset',2), ('A8','Float cycle','current_asset','asset',8),
 ('A9','Suspense','current_asset','asset',9), ('L1','Wallet custody','current_liability','liability',31),
 ('L2','Supporter capital','non_current_liability','liability',32), ('E3','Legacy','equity','equity',43);
-- production mapping rows (10 Nov 2026)
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('wallet','agent_float_deposit',null,'A2','cash_in'), ('platform','agent_float_deposit',null,'A8','cash_in'),
 ('wallet','partner_funding','float','L1','cash_out'), ('wallet','partner_funding',null,'L1','cash_out'),
 ('platform','partner_funding',null,'L2','cash_out'), ('platform','verified_bank_cash_recognised',null,'A1','cash_in'),
 ('platform','cash_custody_payable',null,'L1','cash_in'), ('platform','agent_float_cash_offset',null,'A2','cash_in');
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
create table public.deposit_requests (id uuid primary key, status text, provider text, amount numeric, transaction_id text);
create table public.gmail_transactions (id uuid primary key default gen_random_uuid(), linked_deposit_request_id uuid);
create table public.investor_portfolios (id uuid primary key, investor_id uuid, investment_amount numeric, status text);
create table public.accounting_correction_register (id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null,
  action text not null, source_table text not null, source_id uuid not null, rent_request_id uuid, original_group_id uuid, original_leg_ids uuid[],
  correction_group_id uuid, rebook_group_id uuid, amount numeric not null, before_value numeric, after_value numeric, detail jsonb default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz);
create table public.money_in_report_exclusions (transaction_group_id uuid primary key, reason text, correction_item text, reverses_group_id uuid);
create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, action_type text, action text, table_name text,
  record_id text, reason text, metadata jsonb, created_at timestamptz default now());

-- deposit 1: 1,000,000, all of it funds the payer's portfolio; deposit 2: 500,000, 300,000 funds the portfolio
insert into public.deposit_requests values ('${DEP(1)}','approved','mtn',1000000,'MTN-1'), ('${DEP(2)}','approved','airtel',500000,'AIR-2');
insert into public.gmail_transactions (linked_deposit_request_id) values ('${DEP(1)}'), ('${DEP(2)}');
insert into public.investor_portfolios values ('${PF(1)}','${SUP(1)}',1000000,'active'), ('${PF(2)}','${SUP(2)}',300000,'active');
insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, user_id, source_table, source_id) values
 ('${OG(1)}','2026-09-01 10:00+03','wallet','agent_float_deposit','cash_in',1000000,'float','${SUP(1)}','deposit_requests','${DEP(1)}'),
 ('${OG(1)}','2026-09-01 10:00+03','platform','agent_float_deposit','cash_out',1000000,null,null,'deposit_requests','${DEP(1)}'),
 ('${PG(1)}','2026-09-01 11:00+03','wallet','partner_funding','cash_out',1000000,'float','${SUP(1)}','investor_portfolios','${PF(1)}'),
 ('${PG(1)}','2026-09-01 11:00+03','platform','partner_funding','cash_in',1000000,null,null,'investor_portfolios','${PF(1)}'),
 ('${OG(2)}','2026-10-01 10:00+03','wallet','agent_float_deposit','cash_in',500000,'float','${SUP(2)}','deposit_requests','${DEP(2)}'),
 ('${OG(2)}','2026-10-01 10:00+03','platform','agent_float_deposit','cash_out',500000,null,null,'deposit_requests','${DEP(2)}'),
 ('${PG(2)}','2026-10-01 11:00+03','wallet','partner_funding','cash_out',300000,'float','${SUP(2)}','investor_portfolios','${PF(2)}'),
 ('${PG(2)}','2026-10-01 11:00+03','platform','partner_funding','cash_in',300000,null,null,'investor_portfolios','${PF(2)}');
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const acct = async (code: string) => Number((await q<{ v: string }>(
  `select coalesce(round(sum(case when c.nature in ('asset','expense') then l.dr - l.cr else l.cr - l.dr end)),0) v
     from public.sofp_ledger_legs(now()) l join public.ledger_account_catalog c on c.code = l.account_code where l.account_code = '${code}'`))[0].v);
const residuals = async () => q(`select transaction_group_id::text g, round(sum(dr - cr)) r from public.sofp_ledger_legs(now())
  where not is_legacy_counterpart group by 1 having abs(sum(dr - cr)) > 0.5`);
const sample = (rows: string, n: number, amount: number) => {
  const start = BATCH.indexOf('insert into _s (deposit_id, amount, orig_group) values');
  const end = BATCH.indexOf('\n;', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  return (BATCH.slice(0, start) + `insert into _s (deposit_id, amount, orig_group) values ${rows}` + BATCH.slice(end))
    .replace('insert into _expected values (648, 606941585)', `insert into _expected values (${n}, ${amount})`);
};
const SAMPLE = sample(`('${DEP(1)}', 1000000, '${OG(1)}'), ('${DEP(2)}', 300000, '${OG(2)}')`, 2, 1300000);

describe('DRAFT: Supporters\' mobile-money payments booked as agent float', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(RESOLVER);
  });

  it('the production schedule is 648 deposits / 606,941,585 and every row is well formed', () => {
    const rows = BATCH.slice(BATCH.indexOf('insert into _s'), BATCH.indexOf('\n;', BATCH.indexOf('insert into _s')))
      .split('\n').slice(1).map((l) => l.match(/\('([0-9a-f-]{36})', (\d+), '([0-9a-f-]{36})'\)/));
    expect(rows.every(Boolean)).toBe(true);
    expect(rows.length).toBe(648);
    expect(rows.reduce((s, m) => s + Number(m![2]), 0)).toBe(606941585);
    expect(new Set(rows.map((m) => m![1])).size).toBe(648);
  });

  it('reproduces production: receipts sit in agent float / float clearing, portfolios debit L1, no cash', async () => {
    expect(await acct('A1')).toBe(0);
    expect(await acct('A2')).toBe(1_500_000);
    expect(await acct('A8')).toBe(-1_500_000);
    expect(await acct('L1')).toBe(-1_300_000);
    expect(await acct('L2')).toBe(1_300_000);
    expect(await residuals()).toEqual([]);
  });

  it('after the correction: cash received, Supporter capital funded from it; unused float stays as float', async () => {
    await db.exec(SAMPLE);
    expect(await acct('A1')).toBe(1_300_000);   // money received on the company's mobile-money line
    expect(await acct('L2')).toBe(1_300_000);   // Supporter capital unchanged
    expect(await acct('L1')).toBe(0);           // custody opened and closed by the existing portfolio leg
    expect(await acct('A8')).toBe(-200_000);    // only the unused part of deposit 2 remains in the float cycle
    expect(await acct('A2')).toBe(200_000);     // and as float
    expect(await residuals()).toEqual([]);
    const legs = await q(`select ledger_scope, count(*)::int n from public.general_ledger where idempotency_key like 'acct_corr_202611_momo_supporter:%' group by 1`);
    expect(legs).toEqual([{ ledger_scope: 'platform', n: 8 }]);
    expect((await q(`select count(*)::int n from public.money_in_report_exclusions`))[0].n).toBe(2);
    const reg = await q(`select sum(amount)::numeric s, count(*)::int n from public.accounting_correction_register where batch = 'acct_corr_202611_momo_supporter'`);
    expect([reg[0].n, Number(reg[0].s)]).toEqual([2, 1300000]);
  });

  it('cannot run twice, and refuses a deposit that no longer matches the evidence', async () => {
    await expect(db.exec(SAMPLE)).rejects.toThrow(/already posted/);
    await db.exec('rollback');
    await db.exec(`delete from public.accounting_correction_register`);
    const bad = sample(`('${DEP(2)}', 600000, '${OG(2)}')`, 1, 600000); // more than the deposit
    await expect(db.exec(bad)).rejects.toThrow(/no longer matches the evidence/);
    await db.exec('rollback');
  });
});
