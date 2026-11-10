// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped JSON / rows returned by SQL */
/**
 * DRAFT correction docs/finance/corrections/2026-11-10_cfo_routed_receipts.sql, run verbatim (schedule replaced by two
 * sample credits) on PGlite against PRODUCTION's ledger resolver (fixture sofp_ledger_legs.live.sql), with the production
 * leg shapes: a CFO Direct Credit routing an inbound receipt into a non-agent's float (wallet agent_float_deposit DR A2 /
 * platform agent_float_deposit CR A8) and the payer's own portfolio paid from it (wallet partner_funding DR L1 / platform
 * partner_funding CR L2).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');
const BATCH = read('docs/finance/corrections/2026-11-10_cfo_routed_receipts.sql');
const id = (p: string, k: number) => `00000000-0000-0000-${p}-${String(k).padStart(12, '0')}`;
const WL = (k: number) => id('0a11', k); const OG = (k: number) => id('0060', k); const PG = (k: number) => id('0070', k);
const SUP = (k: number) => id('05e0', k); const GT = (k: number) => id('0e4a', k);

const SCHEMA = `
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
    insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table, reference_id, description, idempotency_key)
    values (g, coalesce((e->>'transaction_date')::timestamptz, now()), e->>'ledger_scope', e->>'category', e->>'direction', (e->>'amount')::numeric,
            e->>'source_table', e->>'reference_id', e->>'description', create_ledger_transaction.idempotency_key);
  end loop;
  if abs(v_in - v_out) > 0.5 then raise exception 'group not balanced'; end if;
  return g;
end $$;
create table public.user_roles (user_id uuid, role text);
create table public.gmail_transactions (id uuid primary key, direction text, amount numeric);
create table public.email_credit_idempotency (reference_id text, operation text, gmail_transaction_id uuid, target_user_id uuid);
create table public.investor_portfolios (id uuid primary key, investor_id uuid, investment_amount numeric, status text);
create table public.accounting_correction_register (id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null,
  action text not null, source_table text not null, source_id uuid not null, rent_request_id uuid, original_group_id uuid, original_leg_ids uuid[],
  correction_group_id uuid, rebook_group_id uuid, amount numeric not null, before_value numeric, after_value numeric, detail jsonb default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz);
create table public.money_in_report_exclusions (transaction_group_id uuid primary key, reason text, correction_item text, reverses_group_id uuid);
create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, action_type text, action text, table_name text,
  record_id text, reason text, metadata jsonb, created_at timestamptz default now());

insert into public.user_roles values ('${SUP(1)}','supporter'), ('${SUP(2)}','supporter'), ('${SUP(3)}','agent');
insert into public.gmail_transactions values ('${GT(1)}','in',2000000), ('${GT(2)}','in',100000), ('${GT(3)}','in',500000);
insert into public.email_credit_idempotency values ('PAY-1','credit','${GT(1)}','${SUP(1)}'), ('PAY-2','credit','${GT(2)}','${SUP(2)}'), ('PAY-3','credit','${GT(3)}','${SUP(3)}');
insert into public.general_ledger (id, transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, user_id, source_table, reference_id) values
 ('${WL(1)}','${OG(1)}','2026-09-28 10:00+03','wallet','agent_float_deposit','cash_in',2000000,'float','${SUP(1)}','cfo_direct_credit','PAY-1'),
 (gen_random_uuid(),'${OG(1)}','2026-09-28 10:00+03','platform','agent_float_deposit','cash_out',2000000,null,null,'cfo_direct_credit','PAY-1'),
 (gen_random_uuid(),'${PG(1)}','2026-09-28 11:00+03','wallet','partner_funding','cash_out',2000000,'float','${SUP(1)}','investor_portfolios',null),
 (gen_random_uuid(),'${PG(1)}','2026-09-28 11:00+03','platform','partner_funding','cash_in',2000000,null,null,'investor_portfolios',null),
 ('${WL(2)}','${OG(2)}','2026-10-16 10:00+03','wallet','agent_float_deposit','cash_in',100000,'float','${SUP(2)}','cfo_direct_credit','PAY-2'),
 (gen_random_uuid(),'${OG(2)}','2026-10-16 10:00+03','platform','agent_float_deposit','cash_out',100000,null,null,'cfo_direct_credit','PAY-2'),
 (gen_random_uuid(),'${PG(2)}','2026-10-16 11:00+03','wallet','partner_funding','cash_out',100000,'float','${SUP(2)}','investor_portfolios',null),
 (gen_random_uuid(),'${PG(2)}','2026-10-16 11:00+03','platform','partner_funding','cash_in',100000,null,null,'investor_portfolios',null),
 ('${WL(3)}','${OG(3)}','2026-10-20 10:00+03','wallet','agent_float_deposit','cash_in',500000,'float','${SUP(3)}','cfo_direct_credit','PAY-3'),
 (gen_random_uuid(),'${OG(3)}','2026-10-20 10:00+03','platform','agent_float_deposit','cash_out',500000,null,null,'cfo_direct_credit','PAY-3');
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const acct = async (code: string) => Number((await q<{ v: string }>(
  `select coalesce(round(sum(case when c.nature in ('asset','expense') then l.dr - l.cr else l.cr - l.dr end)),0) v
     from public.sofp_ledger_legs(now()) l join public.ledger_account_catalog c on c.code = l.account_code where l.account_code = '${code}'`))[0].v);
const sample = (rows: string, n: number, amount: number) => {
  const start = BATCH.indexOf('insert into _s (wallet_leg, orig_group, amount) values');
  const end = BATCH.indexOf('\n;', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  return (BATCH.slice(0, start) + `insert into _s (wallet_leg, orig_group, amount) values ${rows}` + BATCH.slice(end))
    .replace(/insert into _expected values \(\d+, \d+\)/, `insert into _expected values (${n}, ${amount})`);
};

describe('DRAFT: inbound payments routed by CFO Direct Credit to non-agents\' float', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(RESOLVER);
  });

  it('the production schedule is 13 credits / 14,720,000, each row well formed', () => {
    const body = BATCH.slice(BATCH.indexOf('insert into _s'), BATCH.indexOf('\n;', BATCH.indexOf('insert into _s')));
    const rows = body.split('\n').slice(1).map((l) => l.match(/\('([0-9a-f-]{36})', '([0-9a-f-]{36})', (\d+)\)/));
    expect(rows.every(Boolean)).toBe(true);
    expect(rows.length).toBe(13);
    expect(rows.reduce((s, m) => s + Number(m![3]), 0)).toBe(14720000);
    expect(BATCH).toContain('insert into _expected values (13, 14720000)');
    expect(BATCH).toContain('begin isolation level repeatable read;');
  });

  it('refuses a credit whose payer is an agent', async () => {
    await expect(db.exec(sample(`('${WL(3)}', '${OG(3)}', 500000)`, 1, 500000))).rejects.toThrow(/no longer matches the evidence/);
    await db.exec('rollback');
  });

  it('after the correction: cash received against Supporter capital; float, float cycle and L1 released exactly', async () => {
    const before = { A1: await acct('A1'), A2: await acct('A2'), A8: await acct('A8'), L1: await acct('L1'), L2: await acct('L2') };
    expect(before).toEqual({ A1: 0, A2: 2600000, A8: -2600000, L1: -2100000, L2: 2100000 });
    await db.exec(sample(`('${WL(1)}', '${OG(1)}', 2000000), ('${WL(2)}', '${OG(2)}', 100000)`, 2, 2100000));
    expect({ A1: await acct('A1'), A2: await acct('A2'), A8: await acct('A8'), L1: await acct('L1'), L2: await acct('L2') })
      .toEqual({ A1: 2100000, A2: 500000, A8: -500000, L1: 0, L2: 2100000 }); // only the agent's credit stays as float
    const legs = await q(`select ledger_scope, count(*)::int n from public.general_ledger where idempotency_key like 'acct_corr_202611_cfo_routed:%' group by 1`);
    expect(legs).toEqual([{ ledger_scope: 'platform', n: 8 }]);
    expect((await q(`select count(*)::int n from public.money_in_report_exclusions`))[0].n).toBe(2);
    const r = await q(`select transaction_group_id g from public.sofp_ledger_legs(now()) where not is_legacy_counterpart group by 1 having abs(sum(dr - cr)) > 0.5`);
    expect(r).toEqual([]);
  });

  it('cannot run twice', async () => {
    await expect(db.exec(sample(`('${WL(1)}', '${OG(1)}', 2000000), ('${WL(2)}', '${OG(2)}', 100000)`, 2, 2100000))).rejects.toThrow(/already posted/);
    await db.exec('rollback');
  });
});
