// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped JSON / rows returned by SQL */
/**
 * Promissory notes counted once (supabase/migrations/20261111100000_partner_note_settlement.sql), the correction batch
 * docs/finance/corrections/2026-11-10_partner_note_settlement.sql and both rollbacks, run verbatim on PGlite.
 *
 * The recognition function and its triggers are production's (10 Nov 2026), taken from the migration rollback, so the
 * test starts from the live behaviour. create_ledger_transaction is a stand-in that inserts legs, requires each group
 * to balance and refuses a reused idempotency key (as production does). plpgsql.variable_conflict is left at the
 * production setting (error).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261111100000_partner_note_settlement.sql');
const RB = read('supabase/rollbacks/20261111100000_partner_note_settlement.rollback.sql');
const BATCH = read('docs/finance/corrections/2026-11-10_partner_note_settlement.sql');
const BATCH_RB = read('docs/finance/corrections/2026-11-10_partner_note_settlement_rollback.sql');
const RECOGNISE_LIVE = RB.slice(RB.indexOf('CREATE OR REPLACE FUNCTION public.recognise_partner_receivable'),
  RB.indexOf('-- fin_balance_sheet: the 20261111090000 version'));

const CFO = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
const id = (p: string, n: number) => `00000000-0000-0000-${p}-${String(n).padStart(12, '0')}`;
const NOTE = (n: number) => id('0a07', n);
const PF = (n: number) => id('0bf0', n);
const SUP = (n: number) => id('05e0', n);

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function public._fin_can_view() returns boolean language sql stable as $$ select auth.uid() = '${CFO}'::uuid $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;

create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz default now(), created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid,
  source_table text, source_id uuid, reference_id text, classification text default 'production', description text, idempotency_key text);
create table public._fail (x int);
create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  if exists (select 1 from public._fail) then raise exception 'simulated ledger failure'; end if;
  if idempotency_key is not null and exists (select 1 from public.general_ledger x where x.idempotency_key = create_ledger_transaction.idempotency_key) then
    raise exception 'duplicate idempotency key %', idempotency_key;
  end if;
  for e in select * from jsonb_array_elements(entries) loop
    if (e->>'amount')::numeric <= 0 then raise exception 'non-positive leg'; end if;
    if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
    insert into public.general_ledger (transaction_group_id, ledger_scope, category, direction, amount, source_table, source_id, reference_id, description, idempotency_key)
    values (g, e->>'ledger_scope', e->>'category', e->>'direction', (e->>'amount')::numeric, e->>'source_table', (e->>'source_id')::uuid,
            e->>'reference_id', e->>'description', create_ledger_transaction.idempotency_key);
  end loop;
  if abs(v_in - v_out) > 0.5 then raise exception 'group not balanced'; end if;
  return g;
end $$;

create table public.promissory_notes (id uuid primary key, partner_name text, status text, amount numeric, total_collected numeric default 0,
  partner_user_id uuid, agent_id uuid, created_at timestamptz default now());
create table public.commission_fund_ins (id uuid primary key default gen_random_uuid(), note_id uuid, portfolio_id uuid, amount numeric, status text);
create table public.funder_pending_portfolios (id uuid primary key default gen_random_uuid(), promissory_note_id uuid, portfolio_id uuid, amount numeric, status text);
create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, actor_id uuid, performed_by uuid, action_type text, action text,
  table_name text, record_id text, reason text, metadata jsonb, created_at timestamptz default now());
create table public.investor_portfolios (id uuid primary key, investor_id uuid, status text, investment_amount numeric, created_at timestamptz default now());
create table public.accounting_correction_register (id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null,
  action text not null, source_table text not null, source_id uuid not null, rent_request_id uuid, original_group_id uuid, original_leg_ids uuid[],
  correction_group_id uuid, rebook_group_id uuid, amount numeric not null, before_value numeric, after_value numeric, detail jsonb default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz);
create table public.money_in_report_exclusions (transaction_group_id uuid primary key, reason text, correction_item text, reverses_group_id uuid);
create table public.wallets_physical (user_id uuid, locked_balance numeric);
create table public.wallet_balances_projection (user_id uuid, withdrawable numeric);
insert into public.wallets_physical values ('${SUP(1)}', 0); insert into public.wallet_balances_projection values ('${SUP(1)}', 500);

-- Balance Sheet inputs (A7 / L2 straight from the ledger)
create function public.get_statement_of_financial_position(p_as_at timestamptz) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'assets', jsonb_build_object('current', jsonb_build_array(jsonb_build_object('label','Partner Product Receivables','source','general_ledger trial balance — account A7',
       'value', (select coalesce(sum(case when direction='cash_in' then amount else -amount end),0) from public.general_ledger where category='partner_receivable_created')))),
    'liabilities', jsonb_build_object('non_current', jsonb_build_array(jsonb_build_object('label','Partner Portfolios','source','general_ledger trial balance — account L2',
       'value', (select coalesce(sum(case when direction='cash_out' then amount else -amount end),0) from public.general_ledger where category='partner_receivable_capital')))),
    'reconciliation', jsonb_build_object('memo_sub_ledgers', '[]'::jsonb)) $$;
create table public.wallets (withdrawable_balance numeric, locked_balance numeric, float_balance numeric, advance_balance numeric);
create table public.rent_requests (status text, total_repayment numeric, amount_repaid numeric, created_at timestamptz);
create table public.agent_advances (status text, outstanding_balance numeric, arrears_balance numeric, created_at timestamptz);
create table public.merchandise_sales (order_status text, amount_outstanding numeric, created_at timestamptz);
`;

const LIVE_TRIGGERS = `
CREATE OR REPLACE FUNCTION public.trg_recognise_partner_receivable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ BEGIN PERFORM public.recognise_partner_receivable(NEW.id); RETURN NEW; END; $function$;
CREATE TRIGGER recognise_partner_receivable_on_activation AFTER UPDATE OF status ON public.promissory_notes FOR EACH ROW
  WHEN (((new.status = 'activated'::text) AND (COALESCE(old.status, ''::text) <> 'activated'::text))) EXECUTE FUNCTION trg_recognise_partner_receivable();
CREATE TRIGGER recognise_partner_receivable_on_insert AFTER INSERT ON public.promissory_notes FOR EACH ROW
  WHEN ((new.status = 'activated'::text)) EXECUTE FUNCTION trg_recognise_partner_receivable();
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const a7 = async (note: string) => Number((await q<{ v: string }>(
  `select coalesce(sum(case when direction='cash_in' then amount else -amount end),0) v from public.general_ledger where category='partner_receivable_created' and source_id='${note}'`))[0].v);
const l2 = async (note: string) => Number((await q<{ v: string }>(
  `select coalesce(sum(case when direction='cash_out' then amount else -amount end),0) v from public.general_ledger where category='partner_receivable_capital' and source_id='${note}'`))[0].v);
const legs = async () => Number((await q<{ n: number }>(`select count(*)::int n from public.general_ledger`))[0].n);
const note = (n: number, amount: number, status = 'activated') =>
  db.exec(`insert into public.promissory_notes (id, partner_name, status, amount, partner_user_id) values ('${NOTE(n)}','Supporter ${n}','${status}',${amount},'${SUP(n)}')`);

describe('promissory notes: Supporter capital counted once', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(RECOGNISE_LIVE + ';');
    await db.exec(LIVE_TRIGGERS);
  });

  it('production today: a note stays recognised after the Supporter funds it, and re-activation tops it back up', async () => {
    await note(90, 1_000_000);
    expect(await a7(NOTE(90))).toBe(1_000_000);
    await db.exec(`insert into public.commission_fund_ins (note_id, amount, status) values ('${NOTE(90)}', 1000000, 'paid')`);
    expect(await a7(NOTE(90))).toBe(1_000_000); // nothing releases it: capital counted twice
  });

  it('applies cleanly', async () => {
    await db.exec(MIG);
    const t = await q(`select count(*)::int n from pg_trigger where tgname like '%settle_partner_receivable%'`);
    expect(t[0].n).toBe(4);
  });

  it('recognises a new activated note in full, as before', async () => {
    await note(1, 500_000);
    expect(await a7(NOTE(1))).toBe(500_000);
    expect(await l2(NOTE(1))).toBe(500_000);
  });

  it('a fund-in attributed to the note releases it: A7 and the note capital in L2 go to zero, no wallet leg', async () => {
    const before = await legs();
    await db.exec(`insert into public.commission_fund_ins (note_id, portfolio_id, amount, status) values ('${NOTE(1)}','${PF(1)}', 500000, 'paid')`);
    expect(await a7(NOTE(1))).toBe(0);
    expect(await l2(NOTE(1))).toBe(0);
    expect(await legs()).toBe(before + 2);
    const g = await q(`select ledger_scope, category, direction, idempotency_key from public.general_ledger where idempotency_key like 'partner_recv_settle:%' and source_id='${NOTE(1)}' order by ledger_scope`);
    expect(g.map((r: any) => `${r.ledger_scope}/${r.category}/${r.direction}`)).toEqual(
      ['bridge/partner_receivable_created/cash_out', 'platform/partner_receivable_capital/cash_in']);
    expect(g[0].idempotency_key).toBe(`partner_recv_settle:${NOTE(1)}:0`);
    expect((await q(`select count(*)::int n from public.general_ledger where ledger_scope = 'wallet'`))[0].n).toBe(0);
  });

  it('repeated events post nothing more', async () => {
    const before = await legs();
    await db.exec(`update public.commission_fund_ins set status = 'paid' where note_id = '${NOTE(1)}'`);
    await db.exec(`update public.promissory_notes set total_collected = 500000 where id = '${NOTE(1)}'`);
    await q(`select public.settle_partner_receivables(array['${NOTE(1)}'::uuid])`);
    expect(await legs()).toBe(before);
  });

  it('a settled note is never recognised again when re-activated', async () => {
    await db.exec(`update public.promissory_notes set total_collected = 0 where id = '${NOTE(1)}'`);
    await db.exec(`update public.promissory_notes set status = 'pending' where id = '${NOTE(1)}'`);
    await db.exec(`update public.promissory_notes set status = 'activated' where id = '${NOTE(1)}'`);
    expect(await a7(NOTE(1))).toBe(0);
  });

  it('a partial fund-in releases only the funded part; fund-ins above the note are capped', async () => {
    await note(2, 1_000_000);
    await db.exec(`insert into public.commission_fund_ins (note_id, amount, status) values ('${NOTE(2)}', 300000, 'paid')`);
    expect(await a7(NOTE(2))).toBe(700_000);
    await db.exec(`insert into public.commission_fund_ins (note_id, amount, status) values ('${NOTE(2)}', 2000000, 'paid')`);
    expect(await a7(NOTE(2))).toBe(0);
    expect(await l2(NOTE(2))).toBe(0);
  });

  it('a note funded before it is activated is recognised only for the unpaid part', async () => {
    await note(3, 800_000, 'pending');
    await db.exec(`insert into public.commission_fund_ins (note_id, amount, status) values ('${NOTE(3)}', 500000, 'paid')`);
    expect(await a7(NOTE(3))).toBe(0);
    await db.exec(`update public.promissory_notes set status = 'activated' where id = '${NOTE(3)}'`);
    expect(await a7(NOTE(3))).toBe(300_000);
  });

  it('a CFO confirmation releases a note the system never linked', async () => {
    await note(4, 250_000);
    await db.exec(`insert into public.partner_note_settlements (note_id, portfolio_id, amount, basis, evidence, confirmed_by)
                   values ('${NOTE(4)}','${PF(4)}',250000,'cfo_confirmed','CFO confirmed funded portfolio','${CFO}')`);
    expect(await a7(NOTE(4))).toBe(0);
  });

  it('a settlement failure never blocks the fund-in: it is logged and the sweep settles it later', async () => {
    await note(5, 400_000);
    await db.exec(`insert into public._fail values (1)`);
    await db.exec(`insert into public.commission_fund_ins (note_id, amount, status) values ('${NOTE(5)}', 400000, 'paid')`);
    expect((await q(`select count(*)::int n from public.commission_fund_ins where note_id='${NOTE(5)}'`))[0].n).toBe(1);
    expect(await a7(NOTE(5))).toBe(400_000);
    expect((await q(`select count(*)::int n from public.audit_logs where action_type='a7_settlement_failed' and record_id='${NOTE(5)}'`))[0].n).toBe(1);
    await db.exec(`delete from public._fail`);
    const r = (await q(`select public.settle_partner_receivables(null) r`))[0].r;
    expect(r.notes_released).toBe(2); // note 5, and note 90 from the production-behaviour test
    expect(await a7(NOTE(5))).toBe(0);
    expect(await a7(NOTE(90))).toBe(0);
  });

  it('the Balance Sheet compares A7 with notes not yet settled', async () => {
    await db.exec(`select set_config('test.uid', '${CFO}', false)`);
    const bs = (await q(`select public.fin_balance_sheet() r`))[0].r;
    const tie = bs.subledger_ties.find((t: any) => t.key === 'promissory_notes');
    expect(tie.label).toBe('Promissory notes (A7) vs activated notes not yet settled');
    expect(Number(tie.operational)).toBe(300_000); // note 3
    expect(Number(tie.difference)).toBe(0);
    const memo = bs.reconciliation.memo_sub_ledgers.find((e: any) => e.label === 'Promissory notes activated, not yet settled');
    expect(Number(memo.value)).toBe(300_000);
  });

  it('the correction batch releases the confirmed notes once, checks money safety, and refuses to run twice', async () => {
    await note(10, 600_000); await note(11, 150_000);
    await db.exec(`insert into public.investor_portfolios values ('${PF(10)}','${SUP(10)}','active',600000, now()), ('${PF(11)}','${SUP(11)}','active',150000, now())`);
    const start = BATCH.indexOf('insert into _confirm (note_id, portfolio_id, amount) values');
    const end = BATCH.indexOf(';', start);
    const batch = (BATCH.slice(0, start) + `insert into _confirm (note_id, portfolio_id, amount) values ('${NOTE(10)}','${PF(10)}',600000), ('${NOTE(11)}','${PF(11)}',150000)` + BATCH.slice(end))
      .replace(/insert into _expected values \('N1', 67, \d+\)/, `insert into _expected values ('N1', 2, 750000)`);
    expect(batch).not.toBe(BATCH);
    await db.exec(batch);
    expect(await a7(NOTE(10))).toBe(0);
    expect(await a7(NOTE(11))).toBe(0);
    const reg = await q(`select correction_item, amount from public.accounting_correction_register where batch='acct_corr_202611_notes' order by amount`);
    expect(reg.map((r: any) => [r.correction_item, Number(r.amount)])).toEqual([['N1', 150000], ['N1', 600000]]);
    expect((await q(`select count(*)::int n from public.money_in_report_exclusions`))[0].n).toBe(2);
    await expect(db.exec(batch)).rejects.toThrow(/already posted/);
    await db.exec('rollback'); // the refused run leaves its transaction open, as psql would
  });

  it('the batch rollback restores the notes with counter-entries and revokes the confirmations', async () => {
    const before = await legs();
    await db.exec(BATCH_RB);
    expect(await a7(NOTE(10))).toBe(600_000);
    expect(await a7(NOTE(11))).toBe(150_000);
    expect(await legs()).toBe(before + 4);
    expect((await q(`select count(*)::int n from public.partner_note_settlements where revoked_at is not null`))[0].n).toBe(2);
  });

  it('the migration rollback restores production recognition and removes the mechanism', async () => {
    await db.exec(RB);
    expect((await q(`select count(*)::int n from pg_trigger where tgname like '%settle_partner_receivable%'`))[0].n).toBe(0);
    expect((await q(`select count(*)::int n from pg_class where relname in ('partner_note_settlements','v_partner_note_settlement')`))[0].n).toBe(0);
    const def = (await q(`select pg_get_functiondef('public.recognise_partner_receivable(uuid)'::regprocedure) d`))[0].d;
    expect(def).toContain('GREATEST(COALESCE(n.amount,0) - COALESCE(n.total_collected,0), 0)');
  });
});
