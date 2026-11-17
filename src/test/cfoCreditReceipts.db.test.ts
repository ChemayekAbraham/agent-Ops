// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * CFO direct credits booked against Legacy Opening Balance Adjustments (CFO decision 16 Nov 2026).
 *  - forward: withdrawableReceiptPlatformCategory (cfo-direct-credit) and the standing-order categories;
 *  - history: migration 20261125160000 and the DRAFT batch docs/finance/corrections/2026-11-16_cfo_credit_receipts.sql
 *    on PGlite against PRODUCTION's resolver (16 Nov 2026 fixture).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { withdrawableReceiptPlatformCategory } from '../../supabase/functions/_shared/depositBooking';
import { SCHEDULED_PAYOUT_CATEGORIES } from '../../supabase/functions/process-scheduled-payouts/categories';

vi.setConfig({ testTimeout: 60_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261125160000_cfo_credit_receipts_cash_flow.sql');
const BATCH = read('docs/finance/corrections/2026-11-16_cfo_credit_receipts.sql');
const FIX = ['sofp-ledger-legs-prod-2026-11-16d.sql', 'sofp-ledger-legs-window-prod-2026-11-16d.sql'].map((f) => read(`scripts/fixtures/${f}`)).join('\n');
const id = (p: string, k: number) => `00000000-0000-0000-${p}-${String(k).padStart(12, '0')}`;
const L = (k: number) => id('0dd0', k); const G = (k: number) => id('0cc0', k); const U = id('0aa0', 1); const GT = id('0ee0', 1);

describe('forward: CFO credit tool and standing orders', () => {
  const base = { platformCategory: 'system_balance_correction', walletBucket: 'withdrawable', isManualCredit: false, managedProxy: false, inboundReceiptMatches: true };
  it('an inbound receipt credited to a withdrawable balance is cash (wallet_deposit); everything else keeps its category', () => {
    expect(withdrawableReceiptPlatformCategory(base)).toBe('wallet_deposit');
    expect(withdrawableReceiptPlatformCategory({ ...base, inboundReceiptMatches: false })).toBe('system_balance_correction');
    expect(withdrawableReceiptPlatformCategory({ ...base, isManualCredit: true })).toBe('system_balance_correction');
    expect(withdrawableReceiptPlatformCategory({ ...base, walletBucket: 'float' })).toBe('system_balance_correction');
    expect(withdrawableReceiptPlatformCategory({ ...base, managedProxy: true })).toBe('system_balance_correction');
    expect(withdrawableReceiptPlatformCategory({ ...base, platformCategory: 'marketing_expense' })).toBe('marketing_expense');
  });
  it('standing orders post their real expense, never a balance correction', () => {
    expect(SCHEDULED_PAYOUT_CATEGORIES.operational_expense.platformCat).toBe('general_admin_expense');
    expect(SCHEDULED_PAYOUT_CATEGORIES.marketing_expenses.platformCat).toBe('marketing_expense');
    expect(SCHEDULED_PAYOUT_CATEGORIES.research_development.platformCat).toBe('research_development_expense');
    expect(SCHEDULED_PAYOUT_CATEGORIES.lunch_allowance.platformCat).toBe('payroll_expense');
    for (const k of ['operational_expense', 'marketing_expenses', 'research_development', 'lunch_allowance'] as const) {
      expect(SCHEDULED_PAYOUT_CATEGORIES[k].walletCat).toBe('wallet_deposit');
    }
  });
});

describe('history: batch acct_corr_202611_cfo_credits', () => {
  it('the production schedule is 107 receipts (137,088,344) and 71 standing orders (10,860,000)', () => {
    const rows = BATCH.slice(BATCH.indexOf('insert into _c'), BATCH.indexOf('\n;', BATCH.indexOf('insert into _c'))).split('\n').slice(1)
      .map((l) => l.match(/\('([0-9a-f-]{36})', '(cash|expense)', (\d+)\)/)!);
    expect(rows.every(Boolean)).toBe(true);
    const sum = (k: string) => rows.filter((m) => m[2] === k).reduce((s, m) => s + Number(m[3]), 0);
    expect([rows.filter((m) => m[2] === 'cash').length, sum('cash'), rows.filter((m) => m[2] === 'expense').length, sum('expense')])
      .toEqual([107, 137088344, 71, 10860000]);
  });

  it('a receipt credit moves from E3 to cash and a standing order to operating expense; nothing wallet-side', async () => {
    const db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin; create schema extensions;
      create table public.general_ledger (id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz,
        created_at timestamptz default now(), ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid,
        reference_id text, source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
      create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
        account_code text, debit_when text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
      create table public.merchandise_recovery_plans (id uuid, item_name text);
      create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
      create table public.fin_cash_flow_map (id serial primary key, account_code text, category text, section text, group_label text,
        group_sort int, line_in text, line_out text, sort int);
      insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
        ('wallet','wallet_deposit',null,'L1','cash_out'), ('platform','wallet_correction_reclass_a1',null,'A1','cash_in'),
        ('platform','wallet_correction_reclass_x1',null,'X1','cash_in'), ('platform','wallet_correction_reclass_e3',null,'E3','cash_in');
      create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
      returns uuid language plpgsql as $$
      declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
      begin
        for e in select * from jsonb_array_elements(entries) loop
          if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
          insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table, source_id,
            description, idempotency_key, classification)
          values (g, coalesce((e->>'transaction_date')::timestamptz, now()), e->>'ledger_scope', e->>'category', e->>'direction', (e->>'amount')::numeric,
                  e->>'source_table', (e->>'source_id')::uuid, e->>'description', create_ledger_transaction.idempotency_key, coalesce(e->>'classification','production'));
        end loop;
        if abs(v_in - v_out) > 0.5 then raise exception 'group not balanced'; end if;
        return g;
      end $$;
      create table public.email_credit_idempotency (id uuid primary key default gen_random_uuid(), gmail_transaction_id uuid, reference_id text);
      create table public.gmail_transactions (id uuid primary key, direction text, amount numeric, linked_deposit_request_id uuid);
      create table public.accounting_correction_register (id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null,
        action text not null, source_table text not null, source_id uuid not null, rent_request_id uuid, original_group_id uuid, original_leg_ids uuid[],
        correction_group_id uuid, rebook_group_id uuid, amount numeric not null, before_value numeric, after_value numeric, detail jsonb default '{}'::jsonb,
        created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz, rollback_group_id uuid,
        constraint accounting_correction_register_once unique (correction_item, source_table, source_id, action));
      create table public.money_in_report_exclusions (transaction_group_id uuid primary key, reason text, correction_item text, reverses_group_id uuid);
      create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, action_type text, action text, table_name text,
        record_id text, reason text, metadata jsonb, created_at timestamptz default now());
      insert into public.gmail_transactions values ('${GT}','in',500000,null);
      insert into public.email_credit_idempotency (gmail_transaction_id, reference_id) values ('${GT}','PAY-1');
      insert into public.general_ledger (id, transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, user_id, reference_id, source_table, classification) values
        ('${L(1)}','${G(1)}','2026-08-01 10:00+03','wallet','wallet_deposit','cash_in',500000,'withdrawable','${U}','PAY-1','cfo_direct_credit','production'),
        ('${L(2)}','${G(1)}','2026-08-01 10:00+03','platform','system_balance_correction','cash_out',500000,null,null,'PAY-1','cfo_direct_credit','admin_correction'),
        ('${L(3)}','${G(2)}','2026-10-01 10:00+03','wallet','wallet_deposit','cash_in',2000000,'withdrawable','${U}','PAY-2','cfo_direct_credit','production'),
        ('${L(4)}','${G(2)}','2026-10-01 10:00+03','platform','system_balance_correction','cash_out',2000000,null,null,'PAY-2','cfo_direct_credit','admin_correction');`);
    await db.exec(FIX);
    const accts = async () => Object.fromEntries((await db.query<{ a: string; v: string }>(
      `select account_code a, round(sum(dr - cr)) v from public.sofp_ledger_legs(now()) group by 1`)).rows.map((r) => [r.a, Number(r.v)]));
    const before = await accts();
    expect(before.E3).toBe(2500000);                                          // both credits charged to legacy adjustments
    await db.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    const s = BATCH.indexOf('insert into _c (leg, kind, amount) values'); const e = BATCH.indexOf('\n;', s);
    await db.exec((BATCH.slice(0, s) + `insert into _c (leg, kind, amount) values ('${L(1)}','cash',500000), ('${L(3)}','expense',2000000)` + BATCH.slice(e))
      .replace(/insert into _expected values \([^)]*\);/, 'insert into _expected values (1, 500000, 1, 2000000);'));
    const a = await accts();
    expect(a.E3 ?? 0).toBe(0);
    expect(a.A1).toBe(500000);
    expect(a.X1).toBe(2000000);
    expect(a.L1).toBe(before.L1);
    const resid = await db.query(`select transaction_group_id from public.sofp_ledger_legs(now()) where not is_legacy_counterpart group by 1 having abs(sum(dr-cr)) > 0.5`);
    expect(resid.rows).toEqual([]);
    expect((await db.query(`select count(*)::int n from public.money_in_report_exclusions`)).rows).toEqual([{ n: 1 }]);
    expect((await db.query(`select count(*)::int n from public.general_ledger where ledger_scope = 'wallet'`)).rows).toEqual([{ n: 2 }]);
    expect((await db.query(`select category, line_in from public.fin_cash_flow_map`)).rows)
      .toEqual([{ category: 'wallet_correction_reclass_e3', line_in: 'Customer funds received into wallets' }]);
    await db.close();
  });
});
