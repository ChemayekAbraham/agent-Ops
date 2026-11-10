// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped JSON / rows returned by SQL */
/**
 * Permanent booking rule for deposits credited to float (supabase/functions/_shared/depositBooking.ts, used by
 * approve-deposit): unit tests of the rule, then the exact legs approve-deposit now writes, posted on PGlite against
 * PRODUCTION's ledger resolver (fixture sofp_ledger_legs.live.sql) with production mappings.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { customerMoneyFloatPlatformLegs, isCustomerMoneyFloatDeposit } from '../../supabase/functions/_shared/depositBooking';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

describe('booking rule', () => {
  const base = { isFloatDeposit: true, isPhysicalCashChannel: false, isAgent: false, purpose: 'operational_float' };
  it('a non-agent mobile-money float deposit is the payer\'s money received', () => {
    expect(isCustomerMoneyFloatDeposit(base)).toBe(true);
    expect(isCustomerMoneyFloatDeposit({ ...base, purpose: 'other' })).toBe(true);
    expect(isCustomerMoneyFloatDeposit({ ...base, purpose: '' })).toBe(true);
  });
  it('a partnership deposit is the payer\'s money for everyone, agents included', () => {
    expect(isCustomerMoneyFloatDeposit({ ...base, isAgent: true, purpose: 'partnership_deposit' })).toBe(true);
    expect(isCustomerMoneyFloatDeposit({ ...base, isAgent: true, purpose: ' Partnership_Deposit ' })).toBe(true);
  });
  it('agents\' own float deposits keep the existing booking (pending CFO policy)', () => {
    expect(isCustomerMoneyFloatDeposit({ ...base, isAgent: true })).toBe(false);
    expect(isCustomerMoneyFloatDeposit({ ...base, isAgent: true, purpose: 'other' })).toBe(false);
  });
  it('physical cash and withdrawable deposits are not handled here', () => {
    expect(isCustomerMoneyFloatDeposit({ ...base, isPhysicalCashChannel: true })).toBe(false);
    expect(isCustomerMoneyFloatDeposit({ ...base, isFloatDeposit: false })).toBe(false);
  });
  it('legs: three platform legs, raw-balanced with the wallet leg, carrying the receipt reference', () => {
    const legs = customerMoneyFloatPlatformLegs({ depositId: 'd1', amount: 250000, provider: 'mtn', transactionId: 'TID123', transactionDate: '2026-11-10T10:00:00Z' });
    expect(legs.map((l: any) => [l.ledger_scope, l.category, l.direction])).toEqual([
      ['platform', 'agent_float_cash_offset', 'cash_out'],
      ['platform', 'verified_bank_cash_recognised', 'cash_in'],
      ['platform', 'cash_custody_payable', 'cash_out'],
    ]);
    const net = 250000 /* wallet cash_in */ + legs.reduce((s: number, l: any) => s + (l.direction === 'cash_in' ? l.amount : -l.amount), 0);
    expect(net).toBe(0);
    expect(legs.every((l: any) => l.reference_id === 'TID123' && l.source_id === 'd1' && l.amount === 250000)).toBe(true);
  });
});

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');
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
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const acct = async (code: string) => Number((await q<{ v: string }>(
  `select coalesce(round(sum(case when c.nature in ('asset','expense') then l.dr - l.cr else l.cr - l.dr end)),0) v
     from public.sofp_ledger_legs(now()) l join public.ledger_account_catalog c on c.code = l.account_code where l.account_code = '${code}'`))[0].v);
const post = async (gid: string, legs: any[]) => {
  for (const l of legs) {
    await db.query(`insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, source_table, source_id)
      values ($1, '2026-11-10 10:00+03', $2, $3, $4, $5, $6, 'deposit_requests', null)`, [gid, l.ledger_scope, l.category, l.direction, l.amount, l.wallet_bucket ?? null]);
  }
};
const walletLeg = (amount: number) => ({ ledger_scope: 'wallet', category: 'agent_float_deposit', direction: 'cash_in', amount, wallet_bucket: 'float' });

describe('ledger effect on the production resolver', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(RESOLVER);
  });

  it('a Supporter\'s mobile-money float deposit books DR A1 / CR L1 (no agent float, no float cycle)', async () => {
    const legs = customerMoneyFloatPlatformLegs({ depositId: 'd1', amount: 400000, provider: 'mtn', transactionId: 'TID1', transactionDate: '2026-11-10T07:00:00Z' });
    await post('00000000-0000-0000-0001-000000000001', [walletLeg(400000), ...legs]);
    expect([await acct('A1'), await acct('L1'), await acct('A2'), await acct('A8')]).toEqual([400000, 400000, 0, 0]);
  });

  it('funding the Supporter\'s portfolio from that float then nets to cash received against Supporter capital', async () => {
    await post('00000000-0000-0000-0001-000000000002', [
      { ledger_scope: 'wallet', category: 'partner_funding', direction: 'cash_out', amount: 400000, wallet_bucket: 'float' },
      { ledger_scope: 'platform', category: 'partner_funding', direction: 'cash_in', amount: 400000 },
    ]);
    expect([await acct('A1'), await acct('L1'), await acct('L2'), await acct('A2'), await acct('A8')]).toEqual([400000, 0, 400000, 0, 0]);
  });

  it('an agent\'s float deposit keeps the existing shape (DR A2 / CR A8)', async () => {
    await post('00000000-0000-0000-0001-000000000003', [
      walletLeg(150000), { ledger_scope: 'platform', category: 'agent_float_deposit', direction: 'cash_out', amount: 150000 },
    ]);
    expect([await acct('A2'), await acct('A8')]).toEqual([150000, -150000]);
  });

  it('every group balances through the resolver', async () => {
    const r = await q(`select transaction_group_id g, round(sum(dr - cr)) r from public.sofp_ledger_legs(now()) where not is_legacy_counterpart group by 1 having abs(sum(dr - cr)) > 0.5`);
    expect(r).toEqual([]);
  });
});
