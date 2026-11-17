// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Items 4 and 5 — migration 20261125110000 and the DRAFT batch
 * docs/finance/corrections/2026-11-16_wallet_corrections_and_company_float.sql, on PGlite against PRODUCTION's
 * resolver, resolver window and category allowlist as they stand after items 1-2 (16 Nov 2026 fixtures), with
 * production leg shapes. Sample book:
 *  - a commission credit of 100,000 (DR X3 / CR L1) later taken back by a CFO wallet debit (admin_correction);
 *  - a 300,000 mobile-money float deposit (DR A2 / CR A8) spent on a Partner top-up (DR L1 / CR L2);
 *  - 200,000 of merchant (company) float (DR A2 / CR A8) spent on a Partner top-up (DR L1 / CR L2).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261125110000_wallet_corrections_in_statements.sql');
const FIXMIG = read('supabase/migrations/20261125120000_resolver_route_repair_orphan_reversal.sql');
const BATCH = read('docs/finance/corrections/2026-11-16_wallet_corrections_and_company_float.sql');
const FIX = ['sofp-ledger-legs-prod-2026-11-16c.sql', 'sofp-ledger-legs-window-prod-2026-11-16c.sql', 'ledger-allowlist-prod-2026-11-16c.sql']
  .map((f) => read(`scripts/fixtures/${f}`)).join('\n');
// fin_controls (also replaced) is loaded verbatim: a PL/pgSQL body is not checked against tables when created, so the
// preflight sees production's definition; its C21 change is checked textually below.
const CTRL = read('scripts/fixtures/fin-controls-prod-2026-11-16.sql');

const id = (p: string, k: number) => `00000000-0000-0000-${p}-${String(k).padStart(12, '0')}`;
const U = (k: number) => id('0aa0', k); const G = (k: number) => id('0cc0', k); const L = (k: number) => id('0dd0', k);
const DEP = id('0de0', 1); const DEP2 = id('0de0', 2); const PF = (k: number) => id('0bf0', k);

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function public._fin_can_view() returns boolean language sql stable as $$ select true $$;
create function public.ledger_category_allowlist_base() returns text[] language sql immutable as $$ select array[]::text[] $$;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid, reference_id text,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
  account_code text, debit_when text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','agent_commission_payable',null,'X3','cash_out'),
 ('wallet','agent_float_deposit',null,'A2','cash_in'), ('platform','agent_float_deposit',null,'A8','cash_in'),
 ('wallet','partner_funding','float','L1','cash_out'), ('platform','partner_funding',null,'L2','cash_out'),
 ('platform','verified_bank_cash_recognised',null,'A1','cash_in'), ('platform','cash_custody_payable',null,'L1','cash_in'),
 ('platform','agent_float_cash_offset',null,'A2','cash_in');
create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  if idempotency_key is not null and exists (select 1 from public.general_ledger x where x.idempotency_key = create_ledger_transaction.idempotency_key) then
    raise exception 'duplicate idempotency key %', idempotency_key; end if;
  for e in select * from jsonb_array_elements(entries) loop
    if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
    if not ((e->>'category') = any (public.ledger_category_allowlist()) or (e->>'category') in
       (select category from public.ledger_account_map)) then raise exception 'category % not allowed', e->>'category'; end if;
    insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table, source_id,
      reference_id, description, idempotency_key, classification)
    values (g, coalesce((e->>'transaction_date')::timestamptz, now()), e->>'ledger_scope', e->>'category', e->>'direction', (e->>'amount')::numeric,
            e->>'source_table', (e->>'source_id')::uuid, e->>'reference_id', e->>'description', create_ledger_transaction.idempotency_key,
            coalesce(e->>'classification', 'production'));
  end loop;
  if abs(v_in - v_out) > 0.5 then raise exception 'group not balanced'; end if;
  return g;
end $$;
create table public.deposit_requests (id uuid primary key, status text, provider text, amount numeric, transaction_id text);
create table public.investor_portfolios (id uuid primary key, status text);
create table public.accounting_correction_register (id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null,
  action text not null, source_table text not null, source_id uuid not null, rent_request_id uuid, original_group_id uuid, original_leg_ids uuid[],
  correction_group_id uuid, rebook_group_id uuid, amount numeric not null, before_value numeric, after_value numeric, detail jsonb default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz, rollback_group_id uuid,
  constraint accounting_correction_register_once unique (correction_item, source_table, source_id, action));
create table public.money_in_report_exclusions (transaction_group_id uuid primary key, reason text, correction_item text, reverses_group_id uuid);
create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, action_type text, action text, table_name text,
  record_id text, reason text, metadata jsonb, created_at timestamptz default now());

insert into public.deposit_requests values ('${DEP}','approved','mtn',200000,'MTN-1'), ('${DEP2}','approved','airtel',100000,'AIR-2');
insert into public.investor_portfolios values ('${PF(1)}','active'), ('${PF(2)}','active');
insert into public.general_ledger (id, transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, user_id, source_table, source_id, classification) values
 -- commission credit (production) and its CFO retraction (admin_correction)
 ('${L(1)}','${G(1)}','2026-06-01 09:00+03','wallet','agent_commission_earned','cash_in',100000,'withdrawable','${U(1)}','cfo_direct_credit',null,'production'),
 ('${L(2)}','${G(1)}','2026-06-01 09:00+03','platform','agent_commission_payable','cash_out',100000,null,null,'cfo_direct_credit',null,'production'),
 ('${L(3)}','${G(2)}','2026-06-20 09:00+03','wallet','system_balance_correction','cash_out',100000,'withdrawable','${U(1)}','cfo_direct_credit',null,'admin_correction'),
 ('${L(4)}','${G(2)}','2026-06-20 09:00+03','platform','system_balance_correction','cash_in',100000,null,null,'cfo_direct_credit',null,'admin_correction'),
 -- mobile-money float deposit 300,000 and the Partner top-up it paid
 ('${L(5)}','${G(3)}','2026-09-01 10:00+03','wallet','agent_float_deposit','cash_in',300000,'float','${U(2)}','deposit_requests','${DEP}','production'),
 ('${L(6)}','${G(3)}','2026-09-01 10:00+03','platform','agent_float_deposit','cash_out',300000,null,null,'deposit_requests','${DEP}','production'),
 ('${L(7)}','${G(4)}','2026-09-02 10:00+03','wallet','partner_funding','cash_out',300000,'float','${U(2)}','investor_portfolios','${PF(1)}','production'),
 ('${L(8)}','${G(4)}','2026-09-02 10:00+03','platform','partner_funding','cash_in',300000,null,null,'investor_portfolios','${PF(1)}','production'),
 -- merchant float 200,000 and the Partner top-up it paid
 ('${L(9)}','${G(5)}','2026-09-05 10:00+03','wallet','agent_float_deposit','cash_in',200000,'float','${U(3)}','merchant_float_deliveries',null,'production'),
 ('${L(10)}','${G(5)}','2026-09-05 10:00+03','platform','agent_float_deposit','cash_out',200000,null,null,'merchant_float_deliveries',null,'production'),
 ('${L(11)}','${G(6)}','2026-09-06 10:00+03','wallet','partner_funding','cash_out',200000,'float','${U(3)}','investor_portfolios','${PF(2)}','production'),
 ('${L(12)}','${G(6)}','2026-09-06 10:00+03','platform','partner_funding','cash_in',200000,null,null,'investor_portfolios','${PF(2)}','production');
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const accts = async () => Object.fromEntries((await q<{ a: string; v: string }>(
  `select account_code a, round(sum(dr - cr)) v from public.sofp_ledger_legs(now()) group by 1`)).map((r) => [r.a, Number(r.v)]));
const residuals = async () => q(`select transaction_group_id::text g from public.sofp_ledger_legs(now())
  where not is_legacy_counterpart group by 1 having abs(sum(dr - cr)) > 0.5`);
const sample = () => {
  const ws = BATCH.indexOf('insert into _w (leg, amount, legs) values'); const we = BATCH.indexOf('\n;', ws);
  const fs = BATCH.indexOf('insert into _f (payment_leg, kind, deposit_id, amount, classes) values'); const fe = BATCH.indexOf('\n;', fs);
  return (BATCH.slice(0, ws) + `insert into _w (leg, amount, legs) values ('${L(3)}', 100000, '[["E3","cash_in",100000],["X3","cash_out",100000]]'::jsonb)`
    + BATCH.slice(we, fs) + `insert into _f (payment_leg, kind, deposit_id, amount, classes) values ('${L(7)}','momo','${DEP}',200000,'B-momo'), ('${L(7)}','momo','${DEP2}',100000,'B-momo'), ('${L(11)}','float',null,200000,'B-merchant')`
    + BATCH.slice(fe)).replace(/insert into _expected values \([^)]*\);/, 'insert into _expected values (1, 100000, 3, 500000);');
};

describe('items 4 and 5: wallet corrections in the statements; company float used for Partner top-ups', () => {
  let before: Record<string, number>;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(FIX);
    await db.exec(CTRL);
    before = await accts();
  });

  it('the production schedules are well formed: W 137 / 239,348,299 (every group balanced), F 247 / 449,486,202', () => {
    const w = BATCH.slice(BATCH.indexOf('insert into _w'), BATCH.indexOf('\n;', BATCH.indexOf('insert into _w'))).split('\n').slice(1);
    expect(w.length).toBe(137);
    let tot = 0;
    for (const line of w) {
      const m = line.match(/\('([0-9a-f-]{36})', (\d+), '(.*)'::jsonb\)/)!;
      expect(m).toBeTruthy();
      const legs = JSON.parse(m[3]) as [string, string, number][];
      const cin = legs.filter((l) => l[1] === 'cash_in').reduce((s, l) => s + l[2], 0);
      const cout = legs.filter((l) => l[1] === 'cash_out').reduce((s, l) => s + l[2], 0);
      expect(cin).toBe(cout);
      expect(legs.find((l) => l[0] === 'E3')?.[2]).toBe(Number(m[2]));
      tot += Number(m[2]);
    }
    expect(tot).toBe(239348299);
    const f = BATCH.slice(BATCH.indexOf('insert into _f'), BATCH.indexOf('\n;', BATCH.indexOf('insert into _f'))).split('\n').slice(1);
    expect(f.length).toBe(247);
    expect(f.reduce((s, l) => s + Number(l.match(/, (\d+), '[^']*'\)/)![1]), 0)).toBe(449486202);
    expect(BATCH).toMatch(/insert into _expected values \(137, 239348299, 247, 449486202\);/);
  });

  it('today: the CFO debit is left out of the statements; company float spent on top-ups reduces Wallet Custody', () => {
    expect(before.L1).toBe(-100000 + 300000 + 200000);   // DR L1 for the two top-ups, CR L1 for the commission credit
    expect(before.X3).toBe(100000);
    expect(before.E3 ?? 0).toBe(0);
  });

  it('the migration brings the CFO debit into the statements (DR L1 / CR E3); C21 counts only what is still left out', async () => {
    await db.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    const a = await accts();
    expect(a.L1).toBe(before.L1 + 100000);
    expect(a.E3).toBe(-100000);
    expect(await residuals()).toEqual([]);
    expect(MIG).toMatch(/AND COALESCE\(gl\.wallet_bucket, ''\) NOT IN \('withdrawable', 'locked'\)/);
    expect((await q(`select count(*)::int n from public.ledger_account_map where category like 'wallet_correction_reclass_%'`))[0].n).toBe(10);
  });

  it('the batch: the debit moves to the commission it reversed; mobile-money float becomes cash held for the Supporter; company float closes the float cycle', async () => {
    const mid = await accts();
    const wallet = await q(`select count(*)::int n, coalesce(sum(amount),0)::int s from public.general_ledger where ledger_scope = 'wallet'`);
    await db.exec(sample());
    const a = await accts();
    expect(a.E3 ?? 0).toBe(0);                                         // back out of legacy adjustments
    expect(a.X3).toBe(mid.X3 - 100000);                                // commission expense reversed
    expect(a.A1).toBe((mid.A1 ?? 0) + 300000);                         // mobile-money receipt recognised as cash
    expect(a.A8).toBe(mid.A8 + 300000 + 200000);                       // float cycle closed for both
    expect(a.A2).toBe(mid.A2 - 300000);                                // the mobile-money money was never with an agent
    expect(a.L1).toBe(mid.L1 - 500000);                                // custody restored (credit) for both top-ups
    expect(a.L1).toBe(-100000 + 100000);                               // = what the wallets now owe: nothing (all spent / retracted)
    expect(await residuals()).toEqual([]);
    expect(await q(`select count(*)::int n, coalesce(sum(amount),0)::int s from public.general_ledger where ledger_scope = 'wallet'`)).toEqual(wallet);
    expect((await q(`select count(*)::int n from public.money_in_report_exclusions`))[0].n).toBe(2);
    expect((await q(`select correction_item i, count(*)::int n, sum(amount)::int s from public.accounting_correction_register group by 1 order by 1`)))
      .toEqual([{ i: 'F', n: 3, s: 500000 }, { i: 'W', n: 1, s: 100000 }]);
    await expect(db.exec(sample())).rejects.toThrow(/already posted/);
  });
  it('follow-up 20261125120000: a wallet route repair and a platform orphan reversal, now reportable, balance (credit E3)', async () => {
    await db.exec('ROLLBACK').catch(() => {});                      // the refused second batch run above
    await q(`insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, user_id, source_table, classification) values
      ('${G(20)}','2026-07-01 09:00+03','wallet','agent_float_deposit','cash_in',353000,'float','${U(4)}','wallet_route_repair','admin_correction'),
      ('${G(20)}','2026-07-01 09:00+03','platform','system_balance_correction','cash_in',353000,null,null,'wallet_route_repair','admin_correction'),
      ('${G(20)}','2026-07-01 09:00+03','platform','agent_float_deposit','cash_out',353000,null,null,'wallet_route_repair','admin_correction'),
      ('${G(20)}','2026-07-01 09:00+03','wallet','system_balance_correction','cash_out',353000,'withdrawable','${U(4)}','wallet_route_repair','admin_correction'),
      ('${G(21)}','2026-07-02 09:00+03','wallet','orphan_reversal','cash_out',10000,'withdrawable','${U(5)}','rent_requests','admin_correction'),
      ('${G(21)}','2026-07-02 09:00+03','platform','orphan_reversal','cash_in',10000,null,null,'rent_requests','admin_correction')`);
    expect((await residuals()).length).toBe(2);                         // as found in production after 20261125110000
    await db.exec(`BEGIN;
${FIXMIG}
COMMIT;`);
    expect(await residuals()).toEqual([]);
    const legs = await q(`select category c, account_code a, dr::int dr, cr::int cr from public.sofp_ledger_legs(now())
      where transaction_group_id in ('${G(20)}','${G(21)}') and ledger_scope = 'platform' order by 1, 2`);
    expect(legs).toEqual([{ c: 'agent_float_deposit', a: 'A8', dr: 0, cr: 353000 }, { c: 'orphan_reversal', a: 'E3', dr: 0, cr: 10000 },
      { c: 'system_balance_correction', a: 'E3', dr: 0, cr: 353000 }]);
  });
});
