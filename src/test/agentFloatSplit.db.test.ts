// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Agent float split into four lines (CFO decision 17 Nov 2026: agent float = what agents hold in float wallets).
 *  - migration 20261127120000 on PGlite against PRODUCTION's resolver, resolver window and allowlist (17 Nov 2026);
 *  - the DRAFT batch docs/finance/corrections/2026-11-17_agent_float_to_reconcile.sql.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261127120000_agent_float_four_line_split.sql');
const RB = read('supabase/rollbacks/20261127120000_agent_float_four_line_split.rollback.sql');
const BATCH = read('docs/finance/corrections/2026-11-17_agent_float_to_reconcile.sql');
const PROD = ['sofp-ledger-legs-prod-2026-11-16d.sql', 'sofp-ledger-legs-window-prod-2026-11-16d.sql', 'ledger-allowlist-prod-2026-11-17.sql']
  .map((f) => read(`scripts/fixtures/${f}`)).join('\n');
const G = (k: number) => `00000000-0000-0000-0cc0-${String(k).padStart(12, '0')}`;
const AGENT = '00000000-0000-0000-0aa0-000000000001';

async function setup() {
  const db = new PGlite();
  await db.exec(`set timezone = 'UTC'`);
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin; create schema extensions;
    create table public.general_ledger (id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz,
      created_at timestamptz default now(), ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid,
      reference_id text, source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
    create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
      account_code text, debit_when text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
    create table public.ledger_account_catalog (code text primary key, label text, section text, nature text, sort_order int, created_at timestamptz default now());
    create table public.fin_cash_flow_map (id serial primary key, account_code text, category text, section text, group_label text,
      group_sort int, line_in text, line_out text, sort int, unique (account_code, category));
    create table public.merchandise_recovery_plans (id uuid, item_name text);
    create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
    create function public.ledger_category_allowlist_base() returns text[] language sql immutable as $$ select array['x']::text[] $$;
    create table public.wallet_balances_projection (user_id uuid primary key, float_balance numeric);
    create table public.accounting_correction_register (id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null,
      action text not null, source_table text not null, source_id uuid not null, rent_request_id uuid, original_group_id uuid, original_leg_ids uuid[],
      correction_group_id uuid, rebook_group_id uuid, amount numeric not null, before_value numeric, after_value numeric, detail jsonb default '{}'::jsonb,
      created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz, rollback_group_id uuid,
      constraint accounting_correction_register_once unique (correction_item, source_table, source_id, action));
    create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, action_type text, action text, table_name text,
      record_id text, reason text, metadata jsonb, created_at timestamptz default now());
    create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
    returns uuid language plpgsql as $$
    declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
    begin
      for e in select * from jsonb_array_elements(entries) loop
        if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
        insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table,
          reference_id, description, idempotency_key, classification)
        values (g, coalesce((e->>'transaction_date')::timestamptz, now()), e->>'ledger_scope', e->>'category', e->>'direction',
                (e->>'amount')::numeric, e->>'source_table', e->>'reference_id', e->>'description', create_ledger_transaction.idempotency_key,
                coalesce(e->>'classification','production'));
      end loop;
      if abs(v_in - v_out) > 0.5 then raise exception 'group not balanced'; end if;
      return g;
    end $$;
    insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
      ('wallet','agent_float_deposit',null,'A2','cash_in'), ('wallet','partner_funding',null,'L1','cash_out'),
      ('wallet','partner_funding','float','L1','cash_out'), ('platform','partner_funding',null,'L2','cash_out'),
      ('platform','agent_float_cash_offset',null,'A2','cash_in'), ('platform','agent_facilitated_capital_receivable',null,'A2','cash_out'),
      ('platform','agent_float_deposit',null,'A8','cash_in'), ('platform','treasury_bank_deposit',null,'A1','cash_in'),
      ('platform','cash_custody_payable',null,'L1','cash_in'), ('bridge','rent_receivable_created',null,'A3','cash_in');
    insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values ('A2','Cash at Hand — Float with Agents','current_asset','asset',20);
    insert into public.wallet_balances_projection values ('${AGENT}', 200);
    insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, user_id, source_table) values
      -- C: Partner cash received through the agent (custody), credited to the agent's float
      ('${G(1)}','2026-10-01 10:00+03','wallet','agent_float_deposit','cash_in',600,'float','${AGENT}','deposit_requests'),
      ('${G(1)}','2026-10-01 10:00+03','platform','treasury_bank_deposit','cash_in',600,null,null,'deposit_requests'),
      ('${G(1)}','2026-10-01 10:00+03','platform','cash_custody_payable','cash_out',600,null,null,'deposit_requests'),
      ('${G(1)}','2026-10-01 10:00+03','platform','agent_float_cash_offset','cash_out',600,null,null,'deposit_requests'),
      -- T: Partner top-up paid from the agent's float
      ('${G(2)}','2026-10-02 10:00+03','wallet','partner_funding','cash_out',400,'float','${AGENT}','investor_portfolios'),
      ('${G(2)}','2026-10-02 10:00+03','platform','partner_funding','cash_in',400,null,null,'investor_portfolios'),
      -- R: tenant collection restated on 22 Sep 2026 against agent float
      ('${G(3)}','2026-09-22 10:00+03','bridge','rent_receivable_created','cash_out',300,null,null,'agent_collections'),
      ('${G(3)}','2026-09-22 10:00+03','platform','agent_float_cash_offset','cash_in',300,null,null,'agent_collections'),
      -- F: agent-facilitated capital receivable
      ('${G(4)}','2026-10-03 10:00+03','platform','agent_facilitated_capital_receivable','cash_out',50,null,null,'general_ledger'),
      ('${G(4)}','2026-10-03 10:00+03','platform','partner_funding','cash_in',50,null,null,'general_ledger'),
      -- U: April float deposit with no bucket label (agent float without a float wallet)
      ('${G(5)}','2026-04-20 10:00+03','wallet','agent_float_deposit','cash_in',100,null,'${AGENT}','deposit_requests'),
      ('${G(5)}','2026-04-20 10:00+03','platform','agent_float_deposit','cash_out',100,null,null,'deposit_requests');`);
  await db.exec(PROD);
  return db;
}

const accts = async (db: PGlite, fn = 'public.sofp_ledger_legs(now())') => Object.fromEntries((await db.query<{ a: string; v: string }>(
  `select account_code a, round(sum(dr - cr)) v from ${fn} group by 1`)).rows.map((r) => [r.a, Number(r.v)]));
const md5s = async (db: PGlite) => (await db.query<{ m: string }>(
  `select string_agg(md5(prosrc), ',' order by proname) m from pg_proc where proname in ('sofp_ledger_legs','sofp_ledger_legs_window','ledger_category_allowlist')`)).rows[0].m;

describe('agent float four-line split', () => {
  it('pins production, applies once, and the rollback restores production exactly', async () => {
    const db = await setup();
    const before = await md5s(db);
    expect(before.split(',').sort()).toEqual(['b9cc5024e7aad384bd2c5b2be9607cdf', 'c9551dca56139130f3b2e0a60761c815', 'ecb8b23e0ca8ade5e8bbf8e038fc93b3'].sort());
    await db.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    expect(await md5s(db)).not.toBe(before);
    await expect(db.exec(`BEGIN;\n${MIG}\nCOMMIT;`)).rejects.toThrow(/precondition failed/);
    await db.exec('ROLLBACK').catch(() => {});
    expect((await db.query(`select 'agent_float_to_reconcile' = any(public.ledger_category_allowlist()) ok`)).rows).toEqual([{ ok: true }]);
    await db.exec(`BEGIN;\n${RB}\nCOMMIT;`);
    expect(await md5s(db)).toBe(before);
    expect((await db.query(`select count(*)::int n from public.ledger_account_catalog where code in ('A28','A29','A30','A31')`)).rows).toEqual([{ n: 0 }]);
    await db.close();
  });

  it('top-ups, custody receipts, restated collections and the receivable leave agent float; nothing else changes', async () => {
    const db = await setup();
    const before = await accts(db);
    expect(before.A2).toBe(600 - 600 + 300 + 50 + 100);                   // 450, against float wallets of 200
    expect(Object.values(before).reduce((s, v) => s + v, 0)).toBe(0);
    await db.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    for (const fn of ['public.sofp_ledger_legs(now())', `public.sofp_ledger_legs_window('2026-01-01', now())`]) {
      const a = await accts(db, fn);
      expect(a.A2).toBe(600 - 400 + 100);                                  // float wallets (200) + the unlabelled April deposit (100)
      expect(a.A28).toBe(400 - 600);
      expect(a.A29).toBe(300);
      expect(a.A31).toBe(50);
      for (const k of ['A1', 'A3', 'A8', 'L1', 'L2']) expect(a[k] ?? 0).toBe(before[k] ?? 0);
      expect(a.E4 ?? 0).toBe(0);
      const total = Object.values(a).reduce((s, v) => s + v, 0);
      expect(total).toBe(0);
    }
    const resid = await db.query(`select transaction_group_id from public.sofp_ledger_legs(now()) group by 1 having abs(sum(dr-cr)) > 0.5`);
    expect(resid.rows).toEqual([]);
    await db.close();
  });

  it('the batch moves the rest to Agent float to be reconciled, platform-only, and agent float then equals the float wallets', async () => {
    const db = await setup();
    await db.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    const batch = BATCH
      .replace(/\('apr_jul',\s+140596097,/, "('apr_jul', 60,").replace(/\('corrections', 178061884,/, "('corrections', 30,")
      .replace(/\('other',\s+26022600,/, "('other', 10,").replace(/344680581/g, '100');
    await db.exec(batch);
    const a = await accts(db);
    expect(a.A2).toBe(200);
    expect(a.A30).toBe(100);
    expect((await db.query(`select count(*)::int n from public.general_ledger where ledger_scope = 'wallet'`)).rows).toEqual([{ n: 3 }]);
    expect((await db.query(`select correction_item, amount::int from public.accounting_correction_register order by 1`)).rows)
      .toEqual([{ correction_item: 'apr_jul', amount: 60 }, { correction_item: 'corrections', amount: 30 }, { correction_item: 'other', amount: 10 }]);
    expect((await db.query(`select min(transaction_date)::date::text d from public.general_ledger where idempotency_key like 'acct_corr_202611_agent_float_a30:apr_jul'`)).rows)
      .toEqual([{ d: '2026-07-31' }]);
    await expect(db.exec(batch)).rejects.toThrow(/already posted/);
    await db.close();
  });
});
