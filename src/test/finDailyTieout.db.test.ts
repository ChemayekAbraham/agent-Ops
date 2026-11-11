// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Nightly financial statements tie-out (supabase/migrations/20261115140000_fin_daily_tieout.sql), run verbatim on
 * PGlite. fin_balance_sheet / fin_cash_flow are stand-ins that, like production, refuse to run unless auth.uid() is a
 * finance user; their payload has the production shape (11 Nov 2026 figures).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIGRATION = read('supabase/migrations/20261115140000_fin_daily_tieout.sql');
const ROLLBACK = read('supabase/rollbacks/20261115140000_fin_daily_tieout.rollback.sql');

const CFO = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
const MANAGER = '00000000-0000-0000-0000-0000000000b1';
const TENANT = '00000000-0000-0000-0000-0000000000b2';

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub', '')::uuid $$;
create table public.user_roles (user_id uuid, role text);
insert into public.user_roles values ('${CFO}','cfo'), ('${MANAGER}','manager');
create function public._fin_can_view() returns boolean language sql stable security definer as
  $$ select auth.uid() is not null and exists (select 1 from public.user_roles where user_id = auth.uid() and role in ('cfo','manager')) $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
create table public._calls (fn text, uid uuid);
create table public._stub (bs_fail boolean default false, rent_diff numeric default 10288508, cf_ties boolean default true);
insert into public._stub default values;
create function public.fin_balance_sheet(p_as_at timestamptz) returns jsonb language plpgsql security definer as $$
begin
  if not public._fin_can_view() then raise exception 'Not authorised to view the balance sheet'; end if;
  insert into public._calls values ('bs', auth.uid());
  if (select bs_fail from public._stub) then raise exception 'canceling statement due to statement timeout'; end if;
  return jsonb_build_object(
    'assets', jsonb_build_object('total', 4912449546.08, 'current', jsonb_build_array(
      jsonb_build_object('label','Cash and Bank Balances','value',-3141003693,'source','general_ledger trial balance — account A1'),
      jsonb_build_object('label','Partner Product Receivables','value',3891082106,'source','general_ledger trial balance — account A7'),
      jsonb_build_object('label','Staff loans and salary advances receivable','value',1453200,'source','general_ledger trial balance — account A27')),
      'non_current', '[]'::jsonb),
    'balance_check', jsonb_build_object('difference', 0),
    'trial_balance', jsonb_build_object('difference', 0),
    'subledger_ties', jsonb_build_array(
      jsonb_build_object('key','rent_plans','label','Rent Plan receivables (A3) vs Rent Plan book','ledger',447180894,'operational',436892386,'difference',(select rent_diff from public._stub)),
      jsonb_build_object('key','promissory_notes','label','Promissory notes (A7) vs activated notes not yet settled','ledger',3891082106,'operational',3891082106,'difference',0)));
end $$;
create function public.fin_cash_flow(p_from timestamptz, p_to timestamptz) returns jsonb language plpgsql security definer as $$
begin
  if not public._fin_can_view() then raise exception 'Not authorised to view the statement of cash flows'; end if;
  insert into public._calls values ('cf', auth.uid());
  return jsonb_build_object('opening_cash', 1984266160, 'closing_cash', 1958738713, 'balance_sheet_cash', 1958738713,
    'ties_to_balance_sheet', (select cf_ties from public._stub), 'unexplained_difference', 0);
end $$;
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const asUser = (uid: string) => db.exec(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false)`);
const asCron = () => db.exec(`select set_config('request.jwt.claims', '', false)`);
const today = async () => (await q(`select (now() at time zone 'Africa/Kampala')::date::text d`))[0].d as string;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`set timezone = 'UTC'`);
  await db.exec(SCHEMA);
  await db.exec(MIGRATION); // pg_cron absent in PGlite: the schedule step is skipped
});

describe('nightly tie-out', () => {
  it('scheduled run: takes the CFO identity for the run only, records everything, status ok', async () => {
    await asCron();
    await db.exec(`select public.fin_run_daily_tieout('cron')`);
    const [r] = await q(`select * from public.fin_daily_tieout`);
    expect(r.run_date.toISOString().slice(0, 10)).toBe(await today());
    expect(r.status).toBe('ok');
    expect(r.run_as).toBe(CFO);
    expect(Number(r.total_assets)).toBeCloseTo(4912449546.08, 2);
    expect(r.assets).toEqual({ A1: -3141003693, A7: 3891082106, A27: 1453200 });
    expect(r.ties).toHaveLength(2);
    expect(r.cash_flow.ties).toBe(true);
    expect(r.changes).toEqual([]);
    expect(await q(`select fn, uid::text from public._calls order by fn`)).toEqual([{ fn: 'bs', uid: CFO }, { fn: 'cf', uid: CFO }]);
    // identity restored after the run
    expect((await q(`select coalesce(current_setting('request.jwt.claims', true), '') c`))[0].c).toBe('');
  });

  it('flags a tie whose difference moved since the previous night', async () => {
    await db.exec(`insert into public.fin_daily_tieout (run_date, as_at, status, ties) values
      ((now() at time zone 'Africa/Kampala')::date - 1, now() - interval '1 day', 'ok',
       '[{"key":"rent_plans","difference":10000000},{"key":"promissory_notes","difference":0}]')`);
    await asCron();
    await db.exec(`select public.fin_run_daily_tieout('cron')`);
    const [r] = await q(`select status, changes from public.fin_daily_tieout where run_date = (now() at time zone 'Africa/Kampala')::date`);
    expect(r.status).toBe('attention');
    expect(r.changes).toEqual([expect.objectContaining({ key: 'rent_plans', moved_by: 288508 })]);
  });

  it('flags a cash flow that does not tie', async () => {
    await db.exec(`update public._stub set cf_ties = false`);
    await asCron();
    await db.exec(`select public.fin_run_daily_tieout('cron')`);
    expect((await q(`select status from public.fin_daily_tieout`))[0].status).toBe('attention');
  });

  it('records a failed run with the reason, and still restores the identity', async () => {
    await db.exec(`update public._stub set bs_fail = true`);
    await asCron();
    await db.exec(`select public.fin_run_daily_tieout('cron')`);
    const [r] = await q(`select status, error from public.fin_daily_tieout`);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Balance Sheet: canceling statement due to statement timeout/);
    expect((await q(`select coalesce(current_setting('request.jwt.claims', true), '') c`))[0].c).toBe('');
  });

  it('a second run the same day replaces that day\'s row', async () => {
    await asCron();
    await db.exec(`select public.fin_run_daily_tieout('cron')`);
    await db.exec(`update public._stub set rent_diff = 5`);
    await db.exec(`select public.fin_run_daily_tieout('manual')`);
    const rows = await q(`select trigger, ties from public.fin_daily_tieout`);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe('manual');
    expect(rows[0].ties[0].difference).toBe(5);
  });

  it('a signed-in finance user runs as themselves; anyone else is refused', async () => {
    await asUser(MANAGER);
    await db.exec(`select public.fin_run_daily_tieout('manual')`);
    expect((await q(`select run_as::text r from public.fin_daily_tieout`))[0].r).toBe(MANAGER);
    await asUser(TENANT);
    await expect(db.exec(`select public.fin_run_daily_tieout('manual')`)).rejects.toThrow(/Not authorised to run the tie-out/);
  });

  it('browser roles can only read; only the service role can run it', async () => {
    await asCron();
    const p = await q(`select
      has_table_privilege('authenticated','public.fin_daily_tieout','SELECT') sel,
      has_table_privilege('authenticated','public.fin_daily_tieout','INSERT') ins,
      has_table_privilege('anon','public.fin_daily_tieout','SELECT') anon_sel,
      has_function_privilege('authenticated','public.fin_run_daily_tieout(text)','EXECUTE') auth_exec,
      has_function_privilege('service_role','public.fin_run_daily_tieout(text)','EXECUTE') svc_exec`);
    expect(p[0]).toEqual({ sel: true, ins: false, anon_sel: false, auth_exec: false, svc_exec: true });
    const pol = await q(`select policyname from pg_policies where tablename = 'fin_daily_tieout' order by 1`);
    expect(pol.map((x: any) => x.policyname)).toEqual(['fin_daily_tieout_read', 'mfa_required_for_staff']);
  });

  it('the rollback removes it', async () => {
    await db.exec(ROLLBACK);
    expect(Number((await q(`select count(*) n from pg_tables where tablename like 'fin_daily_tieout%'`))[0].n)).toBe(0);
  });
});
