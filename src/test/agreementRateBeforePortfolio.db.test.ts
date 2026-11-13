// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
const file = (name: string) => readFileSync(resolve(process.cwd(), name), 'utf8');
const partner = '00000000-0000-0000-0000-000000000001';
const staff = '00000000-0000-0000-0000-000000000002';
let db: PGlite;
const value = async (sql: string) => (await db.query<{ result: any }>(`select ${sql} result`)).rows[0].result;
const prepare = (rate = 20, mode = 'company_managed') => value(`countersign_prepare_support_with_rate('${partner}',100000,'${mode}',null,'${staff}',${rate})`);
const request = (rate = 20) => value(`set_partner_agreement_rate('${partner}',${rate})`);
const approve = async () => {
  await db.exec(`select set_config('test.role','cfo',false)`);
  await value(`cfo_decide_agreement_rate_requests(array(select id from partner_agreement_rate_requests where status='pending'),'approve')`);
};
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$select '${staff}'::uuid$$;
    create function auth.role() returns text language sql as $$select 'service_role'::text$$;
    create function _has_enabled_role(u uuid,roles text[]) returns boolean language sql as $$select coalesce(current_setting('test.role',true),'partner_ops')=any(roles)$$;
    create function staff_mfa_ok() returns boolean language sql as $$select coalesce(current_setting('test.mfa',true),'yes')='yes'$$;
    create function require_staff_aal2() returns void language plpgsql as $$begin if not staff_mfa_ok() then raise exception 'mfa_required'; end if; end$$;
    create function _partner_return_policy_caller_ok(roles text[]) returns boolean language sql as $$select _has_enabled_role(auth.uid(),roles) and staff_mfa_ok()$$;
    create function is_partner_ops(u uuid) returns boolean language sql as $$select u='${staff}'::uuid$$;
    create table profiles(id uuid primary key,full_name text,signup_source text,funder_verified_at timestamptz);
    create table partner_agreements(id uuid primary key default gen_random_uuid(),partner_id uuid unique,partnership_amount numeric,partnership_amount_words text,return_option text,support_mode text,support_mode_set_at timestamptz,support_mode_set_by uuid,self_support_allowance numeric,auto_portfolio_id uuid);
    create table partner_return_policy(id boolean primary key,enabled boolean,legacy_rate numeric,cutoff_at timestamptz,employee_rate numeric,new_contract_rate numeric);
    insert into partner_return_policy values(true,true,15,null,20,15);
    create function partner_rate_now(u uuid) returns numeric language sql as $$select 15::numeric$$;
    create function partner_rate_lock(ids uuid[]) returns void language sql as $$select$$;
    create function partner_live_portfolio_statuses() returns text[] language sql as $$select array['active','locked']$$;
    create function partner_rates_for(ids uuid[],notes boolean) returns table(partner_id uuid,rate numeric,basis text,existing boolean) language sql as $$select unnest(ids),15::numeric,'new'::text,false$$;
    create function is_portfolio_on_hold(u uuid) returns boolean language sql as $$select false$$;
    create table investor_portfolios(created_at timestamptz default now(),id uuid primary key,investor_id uuid,agent_id uuid,portfolio_code text,investment_amount numeric,roi_mode text,roi_percentage numeric,duration_months int,payout_day int,next_roi_date date,maturity_date date,status text,portfolio_pin text,activation_token uuid,auto_reinvest boolean,cfo_verified boolean,cfo_verified_at timestamptz,cfo_verified_by uuid,entitled_rate numeric,rate_basis text,rate_decided_at timestamptz,rate_existing_at_decision boolean,locked_from_portfolio_id uuid);
    create table portfolio_rate_approvals(id uuid default gen_random_uuid(),portfolio_id uuid,requested_rate numeric,rate_in_force numeric,standard_rate numeric,source text,status text default 'pending',requested_by uuid,decided_by uuid,decided_at timestamptz,decision_note text,applied_at timestamptz,applied_xact bigint);
    create unique index one_pending on portfolio_rate_approvals(portfolio_id) where status='pending';
    create table wallet_transactions(sender_id uuid,recipient_id uuid,amount numeric,description text);
    create table audit_logs(user_id uuid,action_type text,table_name text,record_id text,action text,reason text,metadata jsonb);
    create table test_float(amount numeric); insert into test_float values(100000);
    create table test_ledger(entries jsonb);
    create function funder_float_available(u uuid) returns numeric language sql as $$select amount from test_float$$;
    create function create_ledger_transaction(entries jsonb,idempotency_key text) returns uuid language plpgsql as $$begin insert into test_ledger values(entries); update test_float set amount=amount-(entries->0->>'amount')::numeric; return gen_random_uuid(); end$$;
    create function _partner_contract_coverage(u uuid) returns table(existing_total numeric,existing_count int) language sql as $$select coalesce(sum(investment_amount),0),count(*)::int from investor_portfolios where investor_id=u$$;
  `);
  const migration = file('supabase/migrations/20261113054859_b322d1c2-7749-4a30-8cc4-a45e8bd58273.sql');
  // Execute the real API definitions plus the verified live money/trigger functions, not simulated financial logic.
  await db.exec(migration.slice(0, migration.indexOf('-- Modify the verified live definitions')));
  await db.exec(file('src/test/fixtures/agreementCountersign.live.sql'));
  await db.exec(file('src/test/fixtures/agreementRateTrigger.live.sql'));
  await db.exec(migration.slice(migration.indexOf('CREATE FUNCTION public.countersign_prepare_support_with_rate')));
  await db.exec(`create trigger rate_gate before insert or update on investor_portfolios for each row execute function enforce_partner_return_rate_policy()`);
});
beforeEach(async () => {
  await db.exec(`truncate partner_agreement_rate_requests,partner_agreements,investor_portfolios,profiles,portfolio_rate_approvals,wallet_transactions,audit_logs,test_ledger cascade;
    update test_float set amount=100000; update partner_return_policy set enabled=true;
    select set_config('test.role','partner_ops',false),set_config('test.mfa','yes',false);
    insert into profiles values('${partner}','Partner',null,null),('${staff}','Staff',null,null);
    insert into partner_agreements(partner_id,partnership_amount) values('${partner}',100000);`);
});
afterAll(async () => { await db.close(); });
it('saves a pending rate without funding, and blocks countersign', async () => {
  expect(await request()).toMatchObject({ requested_rate: 20, ready: false, rate_in_force: 15 });
  expect(await prepare()).toMatchObject({ ok: false, code: 'AGREEMENT_RATE_NOT_APPROVED' });
  expect(await value('(select count(*) from investor_portfolios)')).toBe(0);
  expect(await value('(select count(*) from test_ledger)')).toBe(0);
});
it('creates the portfolio at the approved contract rate and consumes float once on retry', async () => {
  await request(); await approve();
  expect(await prepare()).toMatchObject({ ok: true, roi_percentage: 20, needed: 100000 });
  expect(await value('(select roi_percentage::float8 from investor_portfolios)')).toBe(20);
  expect(await value('(select entries->0->>\'wallet_bucket\' from test_ledger)')).toBe('float');
  expect(await prepare()).toMatchObject({ ok: true, needed: 0 });
  expect(await value('(select count(*) from test_ledger)')).toBe(1);
});
it('refuses a rejected rate without changing money', async () => {
  await request(); await db.exec(`select set_config('test.role','cfo',false)`);
  await value(`cfo_decide_agreement_rate_requests(array(select id from partner_agreement_rate_requests),'reject','Not approved')`);
  expect(await prepare()).toMatchObject({ code: 'AGREEMENT_RATE_NOT_APPROVED' });
  expect(await value('(select amount::float8 from test_float)')).toBe(100000);
});
it('requires a fresh decision after an approved rate changes', async () => {
  await request(); await approve();
  expect(await request(25)).toMatchObject({ ready: false, requested_rate: 25 });
  expect(await prepare(25)).toMatchObject({ code: 'AGREEMENT_RATE_NOT_APPROVED' });
});
it('refuses stale contract terms before money moves', async () => {
  await request(); await approve();
  expect(await prepare(15)).toMatchObject({ code: 'AGREEMENT_RATE_CHANGED' });
  expect(await value('(select count(*) from test_ledger)')).toBe(0);
});
it('preserves insufficient operational float protection', async () => {
  await request(); await approve(); await db.exec('update test_float set amount=50000');
  expect(await prepare()).toMatchObject({ code: 'FLOAT_SHORT', shortfall: 50000 });
  expect(await value('(select count(*) from investor_portfolios)')).toBe(0);
});
it('self-support creates no portfolio and debits no float', async () => {
  await request(); await approve();
  expect(await prepare(20,'self_support')).toMatchObject({ ok: true, support_mode: 'self_support' });
  expect(await value('(select count(*) from investor_portfolios)')).toBe(0);
  expect(await value('(select amount::float8 from test_float)')).toBe(100000);
});
it('only CFO with MFA can approve and nonstaff cannot read the queue', async () => {
  await request();
  await expect(approveWithoutRole()).rejects.toThrow('Only the CFO');
  await db.exec(`select set_config('test.role','cfo',false),set_config('test.mfa','no',false)`);
  await expect(approveWithoutRole()).rejects.toThrow('mfa_required');
  await db.exec(`select set_config('test.role','tenant',false),set_config('test.mfa','yes',false)`);
  await expect(value(`list_agreement_rate_requests()`)).rejects.toThrow('Not authorised');
});
const approveWithoutRole = () => value(`cfo_decide_agreement_rate_requests(array(select id from partner_agreement_rate_requests),'approve')`);
it('keeps the unchanged standard rate path and existing-portfolio editor separate', async () => {
  expect(await prepare(15)).toMatchObject({ ok: true, roi_percentage: 15 });
  await expect(request()).rejects.toThrow('Use the existing portfolio rate editor');
});