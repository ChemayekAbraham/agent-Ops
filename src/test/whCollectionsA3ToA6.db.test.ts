// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Draft batch docs/finance/corrections/2026-11-12_wh_collections_a3_to_a6.sql (NOT approved, NOT posted), run verbatim
 * on PGlite with PRODUCTION's resolver (src/test/fixtures/sofp_ledger_legs.live.sql). The 10 original Welile Homes
 * collection groups are seeded with their production leg shapes, ids and amounts (12 Nov 2026):
 *   wallet rent_payment_for_tenant (float, cash_out) + platform rent_repayment (cash_in) + 2% agent commission legs,
 * and each subscription's activation group (bridge landlord_receivable_created A6 / platform landlord_receivable_obligation L4).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');
const BATCH = read('docs/finance/corrections/2026-11-12_wh_collections_a3_to_a6.sql');

const LEGS: [string, number, string][] = [
  ['26ecb39b-3f14-46da-bf01-36219dd0eaeb', 60000, '2026-08-03 14:29:45+00'],
  ['2cf70ce5-9bc0-4077-aba8-f3a08b597a8b', 150000, '2026-08-06 06:28:46+00'],
  ['375ddd98-7672-426e-8081-6b38476cacff', 150000, '2026-08-06 06:30:40+00'],
  ['8bdaa331-5635-4320-8b0e-c3c9deec81b2', 160000, '2026-08-06 06:31:54+00'],
  ['c10e7a28-39a6-4294-8111-5fc3d7b8eae4', 40000, '2026-08-06 07:31:09+00'],
  ['c4d88237-ca58-4edd-8101-9423cf5a05af', 150000, '2026-08-07 09:30:48+00'],
  ['6457be26-b536-43ed-ad3c-76e32e631f76', 5000, '2026-08-07 09:33:14+00'],
  ['37d32a15-edef-4946-9855-1fc1f2b203f7', 110000, '2026-08-11 19:56:08+00'],
  ['2fc105ea-2708-4fac-b876-dac6949d7dd9', 150000, '2026-08-24 21:17:17+00'],
  ['59df060b-95f1-4737-aa76-b470b8f4b359', 100000, '2026-08-24 21:17:43+00'],
];

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid, reference_id text,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text, account_code text, debit_when text);
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','rent_repayment',null,'A3','cash_out'), ('platform','landlord_receivable_collected',null,'A6','cash_out'),
 ('wallet','rent_payment_for_tenant',null,'A2','cash_in'), ('bridge','landlord_receivable_created',null,'A6','cash_in'),
 ('platform','landlord_receivable_obligation',null,'L4','cash_in'), ('platform','agent_commission_payable',null,'X3','cash_out');
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
create table public.money_in_report_exclusions (transaction_group_id uuid primary key, reason text, correction_item text);
create table public.accounting_correction_register (
  id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null, action text not null,
  source_table text not null, source_id uuid not null, original_group_id uuid, original_leg_ids uuid[], correction_group_id uuid,
  amount numeric not null, before_value numeric, after_value numeric, detail jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, unique (correction_item, source_table, source_id, action));
create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  if idempotency_key is not null and exists (select 1 from public.general_ledger l where l.idempotency_key = create_ledger_transaction.idempotency_key) then
    raise exception 'duplicate idempotency key %', idempotency_key; end if;
  for e in select * from jsonb_array_elements(entries) loop
    if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
    insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket,
      reference_id, source_table, source_id, description, idempotency_key)
    values (g, (e->>'transaction_date')::timestamptz, e->>'ledger_scope', e->>'category', e->>'direction', (e->>'amount')::numeric,
      e->>'wallet_bucket', e->>'reference_id', e->>'source_table', (e->>'source_id')::uuid, e->>'description', idempotency_key);
  end loop;
  if abs(v_in - v_out) > 0.5 then raise exception 'raw group not balanced'; end if;
  return g;
end $$;
`;

const SEED = LEGS.map(([leg, amt, td], i) => {
  const sub = `00000000-0000-0000-0000-0000000005${String(i).padStart(2, '0')}`;
  return `
  insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table, source_id, description) values
   ('${sub}', '2026-08-01', 'bridge', 'landlord_receivable_created', 'cash_in', 1800000, 'welile_homes_subscriptions', '${sub}', 'Landlord receivable recognised'),
   ('${sub}', '2026-08-01', 'platform', 'landlord_receivable_obligation', 'cash_out', 1800000, 'welile_homes_subscriptions', '${sub}', 'Landlord payout obligation');
  insert into public.general_ledger (id, transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, source_table, source_id, description) values
   (gen_random_uuid(), '00000000-0000-0000-0000-0000000006${String(i).padStart(2, '0')}', '${td}', 'wallet', 'rent_payment_for_tenant', 'cash_out', ${amt}, 'float', 'welile_homes_monthly_dues', gen_random_uuid(), 'Welile Homes rent allocated from agent float'),
   ('${leg}', '00000000-0000-0000-0000-0000000006${String(i).padStart(2, '0')}', '${td}', 'platform', 'rent_repayment', 'cash_in', ${amt}, null, 'welile_homes_subscriptions', '${sub}', 'Welile Homes rent received (agent-allocated)'),
   (gen_random_uuid(), '00000000-0000-0000-0000-0000000006${String(i).padStart(2, '0')}', '${td}', 'wallet', 'agent_commission_earned', 'cash_in', ${amt * 0.02}, 'withdrawable', 'welile_homes_subscriptions', '${sub}', 'Welile Homes 2% agent commission'),
   (gen_random_uuid(), '00000000-0000-0000-0000-0000000006${String(i).padStart(2, '0')}', '${td}', 'platform', 'agent_commission_payable', 'cash_out', ${amt * 0.02}, null, 'welile_homes_subscriptions', '${sub}', 'Welile Homes 2% agent commission (platform)');`;
}).join('\n');

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const acct = async (code: string) =>
  Number((await q<{ v: string }>(`select coalesce(round(sum(dr - cr)),0) v from public.sofp_ledger_legs(now()) where account_code = '${code}'`))[0].v);
const fails = async (sql: string, re: RegExp) => {
  let msg = '';
  try { await db.exec(sql); } catch (e: any) { msg = String(e?.message ?? e); }
  await db.exec('rollback').catch(() => undefined);
  expect(msg).toMatch(re);
};
const fresh = async () => {
  db = new PGlite();
  await db.exec(`set timezone = 'UTC'`);
  await db.exec(SCHEMA);
  await db.exec(RESOLVER);
  await db.exec(SEED);
};

describe('draft batch: Welile Homes August collections A3 -> A6', () => {
  let before: Record<string, number>; let walletBefore: string;
  beforeAll(async () => {
    await fresh();
    before = { A3: await acct('A3'), A6: await acct('A6'), A2: await acct('A2'), L4: await acct('L4') };
    walletBefore = JSON.stringify(await q(`select * from public.general_ledger where ledger_scope = 'wallet' order by id`));
    await db.exec(BATCH);
  });

  it('before: the 10 August collections reduced A3 (Rent Plans), not A6, exactly as in production', () => {
    expect(before.A3).toBe(-1075000);
    expect(before.A6).toBe(18000000);
  });

  it('after: A3 +1,075,000 and A6 -1,075,000; agent float (A2) and L4 unchanged', async () => {
    expect(await acct('A3') - before.A3).toBe(1075000);
    expect(await acct('A6') - before.A6).toBe(-1075000);
    expect(await acct('A2')).toBe(before.A2);
    expect(await acct('L4')).toBe(before.L4);
  });

  it('10 balanced platform-only groups, dated to each original entry, excluded from Money In, registered', async () => {
    const reg = await q(`select count(*)::int n, sum(amount)::numeric s from public.accounting_correction_register where batch = 'acct_corr_202611_wh_a3_a6'`);
    expect(reg[0].n).toBe(10); expect(Number(reg[0].s)).toBe(1075000);
    expect(Number((await q(`select count(*) n from public.money_in_report_exclusions where correction_item = 'WH1'`))[0].n)).toBe(10);
    const off = await q(`select transaction_group_id from public.sofp_ledger_legs(now()) where transaction_group_id in
      (select correction_group_id from public.accounting_correction_register) group by 1 having abs(sum(dr - cr)) > 0.5`);
    expect(off).toEqual([]);
    const dates = await q(`select count(*) n from public.general_ledger c join public.accounting_correction_register r on r.correction_group_id = c.transaction_group_id
      join public.general_ledger o on o.id = r.source_id where c.transaction_date <> o.transaction_date`);
    expect(Number(dates[0].n)).toBe(0);
    expect(Number((await q(`select count(*) n from public.general_ledger g join public.accounting_correction_register r on r.correction_group_id = g.transaction_group_id where g.ledger_scope <> 'platform'`))[0].n)).toBe(0);
  });

  it('wallet legs are untouched', async () => {
    expect(JSON.stringify(await q(`select * from public.general_ledger where ledger_scope = 'wallet' order by id`))).toBe(walletBefore);
  });

  it('cannot be posted twice', async () => {
    await fails(BATCH, /already posted/);
  });
});

describe('draft batch stops when the evidence changed', () => {
  it('refuses if an entry no longer matches', async () => {
    await fresh();
    await db.exec(`update public.general_ledger set amount = 61000 where id = '26ecb39b-3f14-46da-bf01-36219dd0eaeb'`);
    await fails(BATCH, /no longer matches the evidence/);
    expect(Number((await q(`select count(*) n from public.accounting_correction_register`))[0].n)).toBe(0);
  });
});
