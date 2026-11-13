// @vitest-environment node
/**
 * Salary advances: the release step pays the staff wallet (supabase/migrations/20261123120000_hr_pay_advance_pay_to_wallet.sql).
 *
 * PGlite with production's code: the salary-advance guard of 13 Nov 2026 verbatim (and as the migration changes it),
 * create_ledger_transaction, the overdraft trigger, wallet routing, the category allowlist and production's unique
 * wallet-reference index. The HR authority checks (hr_pay_is_*) are stand-ins reading a test table.
 */
import { readFileSync } from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = (f: string) => read(`supabase/migrations/${f}`);
const PAY = MIG('20261123120000_hr_pay_advance_pay_to_wallet.sql');
const PAY_RB = read('supabase/rollbacks/20261123120000_hr_pay_advance_pay_to_wallet.rollback.sql');
const PROD_GUARD = read('scripts/fixtures/hr-pay-advance-guard-prod-2026-11-13.sql');

function extractFn(file: string, signature: string): string {
  const src = MIG(file);
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  if (start < 0) throw new Error(`${signature} not found in ${file}`);
  const tail = src.slice(start);
  const end = tail.search(/\n(\$function\$|\$\$);\n/);
  return tail.slice(0, end) + '\n' + (tail.slice(end + 1).startsWith('$function$') ? '$function$;' : '$$;');
}

const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, role text not null, enabled boolean not null default true);
create table public.profiles (id uuid primary key, full_name text);
create type public.solvency_bypass_reason as enum ('cfo_override');
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), user_id uuid, wallet_id uuid, ledger_scope text, direction text, category text,
  amount numeric, currency text, description text, source_table text, source_id uuid, transaction_group_id uuid,
  idempotency_key text, transaction_date timestamptz, linked_party text, reference_id text, account text, classification text,
  recipient_type text, wallet_bucket text, routing_source text, solvency_bypass_reason public.solvency_bypass_reason,
  ip_address text, user_agent text, sub_category text, created_at timestamptz not null default now());
-- production's unique index uq_general_ledger_reference_dedupe
create unique index uq_general_ledger_reference_dedupe on public.general_ledger (user_id, category, reference_id, direction, ledger_scope)
  where reference_id is not null and user_id is not null;
create table public.wallets (id uuid primary key default gen_random_uuid(), user_id uuid unique, withdrawable_balance numeric default 0);
create table public.wallet_fresh_start_anchors (user_id uuid primary key, anchor_at timestamptz);
create table public.wallet_routing_violations (id bigserial primary key, user_id uuid, category text, direction text, amount numeric,
  recipient_type text, reason text, context jsonb);
create table public.treasury_controls (control_key text primary key, enabled boolean);
insert into public.treasury_controls values ('strict_mode', true), ('advance_withdrawals_paused', false);
create table public.wallet_balances_projection (user_id uuid primary key, withdrawable numeric not null default 0,
  float_balance numeric not null default 0, updated_at timestamptz not null default now());
create function public.tr_projection_standin() returns trigger language plpgsql as $$
DECLARE v numeric;
BEGIN
  IF NEW.ledger_scope = 'wallet' AND NEW.user_id IS NOT NULL THEN
    SELECT COALESCE(sum(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0) INTO v FROM public.general_ledger
     WHERE user_id = NEW.user_id AND ledger_scope = 'wallet' AND COALESCE(wallet_bucket, 'withdrawable') = 'withdrawable';
    INSERT INTO public.wallet_balances_projection AS w (user_id, withdrawable) VALUES (NEW.user_id, v)
      ON CONFLICT (user_id) DO UPDATE SET withdrawable = EXCLUDED.withdrawable, updated_at = now();
    INSERT INTO public.wallets AS w (user_id, withdrawable_balance) VALUES (NEW.user_id, v)
      ON CONFLICT (user_id) DO UPDATE SET withdrawable_balance = EXCLUDED.withdrawable_balance;
  END IF;
  RETURN NEW;
END $$;
create trigger trg_wallet_projection_ledger after insert on public.general_ledger for each row execute function public.tr_projection_standin();
create function public.funder_pending_hold(p_user_id uuid) returns numeric language sql stable as $$ select 0::numeric $$;
create function public.get_user_available_balance(p_user_id uuid) returns numeric language plpgsql stable as
  $$ begin return public.get_user_available_balance__impl(p_user_id); end $$;
create function public.get_user_advance_reversal_available(p_user_id uuid) returns numeric language sql stable as $$ select 0::numeric $$;
create table public.agent_bike_leases (sale_id uuid, agent_id uuid, status text);
create table public.merchandise_recovery_plans (id uuid primary key, item_name text, phone_collection_enabled boolean, is_bike_lease boolean);
create table public.ledger_account_map (id uuid primary key default gen_random_uuid(), ledger_scope text not null, category text not null,
  wallet_bucket text, account_code text not null, debit_when text not null);
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
  ('platform','staff_loan_disbursement',null,'A27','cash_out');
-- HR: staff, advances (production's columns and checks), and the authority checks as stand-ins
create table public.hr_staff (id uuid primary key default gen_random_uuid(), user_id uuid, staff_ref text, active boolean not null default true);
create table public.hr_pay_advances (
  id uuid primary key default gen_random_uuid(), staff_id uuid not null references public.hr_staff(id), principal numeric not null check (principal > 0),
  currency text not null default 'UGX', purpose text not null, recovery_mode text not null default 'fixed', recovery_value numeric not null,
  first_recovery_on date not null, status text not null default 'requested'
    check (status = any (array['requested','hr_approved','ceo_approved','approved','rejected','settled','cancelled'])),
  requested_by uuid default auth.uid(), requested_at timestamptz not null default now(), approved_by uuid, approved_position_id uuid,
  approved_at timestamptz, decision_note text, created_at timestamptz not null default now(), hr_approved_by uuid, hr_approved_position_id uuid,
  hr_approved_at timestamptz, disbursed_by uuid, disbursed_position_id uuid, disbursed_at timestamptz, recovery_months smallint,
  constraint hr_pay_adv_sep_ck check (approved_by is null or approved_by is distinct from requested_by));
create table public.test_hr_authority (user_id uuid, fn text);
create function public.hr_pay_has(fn text) returns boolean language sql stable as
  $$ select exists (select 1 from public.test_hr_authority where user_id = auth.uid() and test_hr_authority.fn = hr_pay_has.fn) $$;
create function public.hr_pay_is_preparer() returns boolean language sql stable as $$ select public.hr_pay_has('prepare') $$;
create function public.hr_pay_is_approver() returns boolean language sql stable as $$ select public.hr_pay_has('approve') $$;
create function public.hr_pay_is_releaser() returns boolean language sql stable as $$ select public.hr_pay_has('release') $$;
create function public.hr_pay_is_rule_admin() returns boolean language sql stable as $$ select false $$;
create function public.hr_pay_position_for(_fn text) returns uuid language sql stable as $$ select null::uuid $$;
`;

const REAL = [
  extractFn('20260817070831_d61c0e97-c1bd-476c-8266-748f95b9204b.sql', 'public.wallet_route_for_category(p_category'),
  extractFn('20260817070831_d61c0e97-c1bd-476c-8266-748f95b9204b.sql', 'public.assert_routing_compatible('),
  extractFn('20260515113611_a78dae5e-607a-4e4a-ad99-0760db81e681.sql', 'public.wallet_route_for_category(p_user_id'),
  read('scripts/fixtures/ledger-allowlist-prod-2026-10-27.sql'),
  read('scripts/fixtures/ledger-allowlist-prod-2026-11-12.sql'),
  extractFn('20260509085227_0a4f550d-0c03-48b0-b8c8-2c181e365198.sql', 'public.validate_ledger_category(p_category'),
  extractFn('20260509085227_0a4f550d-0c03-48b0-b8c8-2c181e365198.sql', 'public.validate_ledger_category()'),
  read('scripts/fixtures/special-advance-wallet-pay-prod-2026-11-12.sql'),
  PROD_GUARD,
];
const TRIGGERS = `
create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();
create trigger trg_enforce_no_negative_wallet_ledger before insert on public.general_ledger for each row execute function public.enforce_no_negative_wallet_ledger();
create trigger hr_pay_advance_guard_trg before insert or update on public.hr_pay_advances for each row execute function public.hr_pay_advance_guard();
grant select, insert, update on public.hr_pay_advances to authenticated;
`;

type Err = { message: string; code?: string; detail?: string };
let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
async function call<T = Record<string, unknown>>(user: string | null, sql: string, params: unknown[] = [], role = 'authenticated'): Promise<{ out?: T; err?: Err }> {
  try {
    let out: T | undefined;
    await db.transaction(async (tx) => {
      if (user) await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role })]);
      await tx.exec(`set local role ${role}`);
      out = (await tx.query<{ r: T }>(sql, params)).rows[0]?.r;
    });
    return { out };
  } catch (e) { return { err: e as Err }; }
}
const run = async (sql: string) => db.exec(`BEGIN;\n${sql}\nCOMMIT;`).then(() => undefined, async (e: Err) => { await db.exec('ROLLBACK').catch(() => {}); return e; });

const hr = uuid(), ceo = uuid(), cfo = uuid();
async function person(name: string) {
  const u = uuid();
  await q(`insert into public.profiles values ($1, $2)`, [u, name]);
  const [{ id }] = await q<{ id: string }>(`insert into public.hr_staff (user_id, staff_ref) values ($1, $2) returning id`, [u, name]);
  return { user: u, staff: id };
}
/** A 200,000 advance taken through HR and CEO approval, waiting for the CFO's release step. */
async function awaitingCfo(staff: string, requester: string, amount = 200_000) {
  const ins = await call<{ id: string }>(requester, `insert into public.hr_pay_advances (staff_id, principal, purpose, recovery_value, first_recovery_on, recovery_months)
    values ($1, $2, 'To clear some arrears', $2, current_date + 20, 1) returning to_jsonb(hr_pay_advances.*) r`, [staff, amount]);
  if (ins.err) throw new Error(ins.err.message);
  const id = (ins.out as unknown as { id: string }).id;
  for (const [who, to] of [[hr, 'hr_approved'], [ceo, 'ceo_approved']] as const) {
    const r = await call(who, `update public.hr_pay_advances set status = $2 where id = $1 returning 1 r`, [id, to]);
    if (r.err) throw new Error(r.err.message);
  }
  return id;
}
const pay = (user: string | null, id: string) => call<{ amount: number; reference: string; ledger_group_id: string; replayed: boolean; status: string; paid_to: string }>(
  user, `select public.hr_pay_advance_pay_to_wallet($1) r`, [id]);
const wallet = async (user: string) => Number((await q<{ w: string }>(`select coalesce((select withdrawable from public.wallet_balances_projection where user_id = $1), 0)::text w`, [user]))[0].w);
const advance = async (id: string) => (await q<{ status: string; disbursed_by: string | null; disbursed_at: string | null }>(
  `select status, disbursed_by, disbursed_at::text from public.hr_pay_advances where id = $1`, [id]))[0];
const legs = (id: string) => q(`select ledger_scope, direction, category, amount::int, wallet_bucket, reference_id from public.general_ledger
  where source_table = 'hr_pay_advances' and source_id = $1 order by ledger_scope`, [id]);
const a27 = async () => Number((await q<{ v: string }>(`select coalesce(sum(case when gl.direction = m.debit_when then gl.amount else -gl.amount end), 0)::text v
  from public.general_ledger gl join public.ledger_account_map m on m.ledger_scope = gl.ledger_scope and m.category = gl.category and m.account_code = 'A27'`))[0].v);
const md5Guard = async () => (await q<{ m: string }>(`select md5(prosrc) m from pg_proc where oid = 'public.hr_pay_advance_guard()'::regprocedure`))[0].m;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + REAL.join('\n') + '\nset check_function_bodies = on;');
  await db.exec(TRIGGERS);
  for (const [u, fn] of [[hr, 'prepare'], [ceo, 'approve'], [cfo, 'release']] as const) {
    await q(`insert into public.profiles values ($1, $2)`, [u, fn]);
    await q(`insert into public.test_hr_authority values ($1, $2)`, [u, fn]);
  }
}, 600_000);
afterAll(async () => { await db?.close(); });

describe('before: production as on 13 Nov 2026', () => {
  it('"Record Disbursement" marks the advance disbursed and moves no money (what happened to Meddy and Awany)', async () => {
    expect(await md5Guard()).toBe('9df13bf7ddf908dba1768c13c4507a98');
    const p = await person('Before Person');
    const id = await awaitingCfo(p.staff, p.user);
    const r = await call(cfo, `update public.hr_pay_advances set status = 'approved' where id = $1 returning 1 r`, [id]);
    expect(r.err).toBeUndefined();
    expect(await advance(id)).toMatchObject({ status: 'approved', disbursed_by: cfo });
    expect(await legs(id)).toEqual([]);
    expect(await wallet(p.user)).toBe(0);
  });
});

describe('20261123120000 migration', () => {
  it('applies over production\'s guard only, once', async () => {
    expect(await run(PAY)).toBeUndefined();
    expect((await run(PAY))?.message).toMatch(/precondition failed/);
  });

  it('Pay to wallet: the staff wallet is credited, DR A27 / CR L1, and the advance is marked disbursed by the CFO', async () => {
    const p = await person('MEDDY TEST');
    const id = await awaitingCfo(p.staff, p.user);
    const a0 = await a27();
    const r = await pay(cfo, id);
    expect(r.err).toBeUndefined();
    expect(r.out).toMatchObject({ amount: 200_000, status: 'approved', paid_to: 'MEDDY TEST', replayed: false });
    expect(r.out!.reference).toMatch(/^SALADV-[0-9A-F]{10}$/);
    expect(await wallet(p.user)).toBe(200_000);
    expect(await a27() - a0).toBe(200_000);
    expect(await legs(id)).toEqual([
      { ledger_scope: 'platform', direction: 'cash_out', category: 'staff_loan_disbursement', amount: 200_000, wallet_bucket: null, reference_id: r.out!.reference },
      { ledger_scope: 'wallet', direction: 'cash_in', category: 'staff_loan_disbursement', amount: 200_000, wallet_bucket: 'withdrawable', reference_id: r.out!.reference }]);
    const adv = await advance(id);
    expect(adv).toMatchObject({ status: 'approved', disbursed_by: cfo });
    expect(adv.disbursed_at).not.toBeNull();
  });

  it('pays once: a second click or a retry returns the same payout', async () => {
    const p = await person('Twice Person');
    const id = await awaitingCfo(p.staff, p.user);
    const first = await pay(cfo, id);
    const again = await pay(cfo, id);
    expect(again.out).toMatchObject({ replayed: true, ledger_group_id: first.out!.ledger_group_id });
    expect(await wallet(p.user)).toBe(200_000);
    expect(await legs(id)).toHaveLength(2);
  });

  it('a status change on its own can no longer mark an advance disbursed', async () => {
    const p = await person('Status Person');
    const id = await awaitingCfo(p.staff, p.user);
    const r = await call(cfo, `update public.hr_pay_advances set status = 'approved' where id = $1 returning 1 r`, [id]);
    expect(r.err?.message).toMatch(/disbursed by paying it to the staff wallet/);
    expect(await advance(id)).toMatchObject({ status: 'ceo_approved', disbursed_by: null });
  });

  it('refuses: no release authority, own advance, not yet CEO-approved, inactive staff, unknown advance; nothing moves', async () => {
    const p = await person('Refused Person');
    const id = await awaitingCfo(p.staff, p.user);
    expect((await pay(hr, id)).err?.message).toMatch(/release authority/);
    expect((await pay(null, id)).err?.message).toBe('AUTH_REQUIRED');
    // the CFO's own advance
    const own = await q<{ id: string }>(`insert into public.hr_staff (user_id, staff_ref) values ($1, 'cfo') returning id`, [cfo]);
    const ownId = await awaitingCfo(own[0].id, cfo);
    expect((await pay(cfo, ownId)).err?.message).toBe('SELF_PAYOUT');
    // only HR-approved so far
    const p2 = await person('Early Person');
    const ins = await call<{ id: string }>(p2.user, `insert into public.hr_pay_advances (staff_id, principal, purpose, recovery_value, first_recovery_on)
      values ($1, 100000, 'Rent arrears', 100000, current_date + 20) returning to_jsonb(hr_pay_advances.*) r`, [p2.staff]);
    const earlyId = (ins.out as unknown as { id: string }).id;
    expect((await pay(cfo, earlyId)).err?.message).toBe('ADVANCE_NOT_READY_FOR_PAYOUT');
    // staff record no longer active
    const p3 = await person('Left Person');
    const leftId = await awaitingCfo(p3.staff, p3.user);
    await q(`update public.hr_staff set active = false where id = $1`, [p3.staff]);
    expect((await pay(cfo, leftId)).err?.message).toBe('STAFF_WALLET_NOT_FOUND');
    expect((await pay(cfo, uuid())).err?.message).toBe('ADVANCE_NOT_FOUND');
    for (const u of [p.user, p2.user, p3.user, cfo]) expect(await wallet(u)).toBe(0);
    expect(await call(null, `select public.hr_pay_advance_pay_to_wallet($1) r`, [id], 'anon').then((x) => x.err?.message)).toMatch(/permission denied/);
  });

  it('a failure after the ledger posting rolls everything back: no wallet credit, advance still awaiting the CFO', async () => {
    const p = await person('Fail Person');
    const id = await awaitingCfo(p.staff, p.user);
    await db.exec(`create function public.test_fail() returns trigger language plpgsql as $$ begin if new.status = 'approved' then raise exception 'TEST_FAILURE'; end if; return new; end $$;
      create trigger test_fail before update on public.hr_pay_advances for each row execute function public.test_fail();`);
    const r = await pay(cfo, id);
    await db.exec(`drop trigger test_fail on public.hr_pay_advances; drop function public.test_fail();`);
    expect(r.err?.message).toBe('TEST_FAILURE');
    expect(await wallet(p.user)).toBe(0);
    expect(await legs(id)).toEqual([]);
    expect((await advance(id)).status).toBe('ceo_approved');
  });

  it('the rest of the workflow is unchanged: approve, reject, cancel and settle still work as before', async () => {
    const p = await person('Flow Person');
    const id = await awaitingCfo(p.staff, p.user);
    expect((await call(cfo, `update public.hr_pay_advances set status = 'rejected', decision_note = 'Not this month, sorry' where id = $1 returning 1 r`, [id])).err).toBeUndefined();
    const id2 = await awaitingCfo(p.staff, p.user);
    expect((await call(hr, `update public.hr_pay_advances set status = 'cancelled', decision_note = 'Raised in error by HR' where id = $1 returning 1 r`, [id2])).err).toBeUndefined();
    const id3 = await awaitingCfo(p.staff, p.user);
    await pay(cfo, id3);
    expect((await call(hr, `update public.hr_pay_advances set status = 'settled' where id = $1 returning 1 r`, [id3])).err).toBeUndefined();
  });

  it('rollback restores production\'s guard exactly; payouts made stay on the ledger', async () => {
    const before = await q(`select count(*)::int n from public.general_ledger where source_table = 'hr_pay_advances'`);
    expect(await run(PAY_RB)).toBeUndefined();
    expect(await md5Guard()).toBe('9df13bf7ddf908dba1768c13c4507a98');
    expect(await q(`select to_regprocedure('public.hr_pay_advance_pay_to_wallet(uuid)') is null x`)).toEqual([{ x: true }]);
    expect(await q(`select count(*)::int n from public.general_ledger where source_table = 'hr_pay_advances'`)).toEqual(before);
    expect(await run(PAY)).toBeUndefined();
  });
});
