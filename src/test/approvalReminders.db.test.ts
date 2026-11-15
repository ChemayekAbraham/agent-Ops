// @vitest-environment node
/**
 * Approval reminders every 4 hours (supabase/migrations/20261124090000_approval_reminders_every_4_hours.sql).
 *
 * PGlite with production's staff-loan and facilitation snooze functions of 15 Nov 2026 verbatim (as the migration
 * replaces them), and the new salary-advance reminder. The HR authority checks (hr_pay_is_*) are stand-ins reading
 * a test table; the prompt tables carry only the columns the functions use.
 */
import { readFileSync } from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIGRATION = read('supabase/migrations/20261124090000_approval_reminders_every_4_hours.sql');
const ROLLBACK = read('supabase/rollbacks/20261124090000_approval_reminders_every_4_hours.rollback.sql');
const PROD = read('scripts/fixtures/prompt-snooze-prod-2026-11-15.sql');

const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
create table public.profiles (id uuid primary key, full_name text);
create table public.hr_staff (id uuid primary key default gen_random_uuid(), user_id uuid, staff_ref text, active boolean not null default true);
create table public.hr_pay_advances (id uuid primary key default gen_random_uuid(), staff_id uuid not null references public.hr_staff(id),
  principal numeric not null, currency text not null default 'UGX', purpose text not null, status text not null,
  requested_at timestamptz not null default now());
create table public.test_hr_authority (user_id uuid, fn text);
create function public.hr_pay_has(fn text) returns boolean language sql stable security definer as
  $$ select exists (select 1 from public.test_hr_authority where user_id = auth.uid() and test_hr_authority.fn = hr_pay_has.fn) $$;
create function public.hr_pay_is_preparer() returns boolean language sql stable as $$ select public.hr_pay_has('prepare') $$;
create function public.hr_pay_is_approver() returns boolean language sql stable as $$ select public.hr_pay_has('approve') $$;
create function public.hr_pay_is_releaser() returns boolean language sql stable as $$ select public.hr_pay_has('release') $$;
create table public.staff_loan_prompts (id uuid primary key default gen_random_uuid(), approver_id uuid, kind text, requisition_id uuid,
  state text not null default 'open', snooze_until timestamptz, snooze_count integer not null default 0);
create table public.pso_facilitation_prompts (id uuid primary key default gen_random_uuid(), approver_id uuid, kind text, requisition_id uuid,
  state text not null default 'open', snooze_until timestamptz, snooze_count integer not null default 0);
`;

type Err = { message: string; code?: string };
let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
async function as<T = Record<string, unknown>>(user: string | null, sql: string, params: unknown[] = [], role = 'authenticated'): Promise<{ rows?: T[]; err?: Err }> {
  try {
    let rows: T[] = [];
    await db.transaction(async (tx) => {
      if (user) await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role })]);
      await tx.exec(`set local role ${role}`);
      rows = (await tx.query<T>(sql, params)).rows;
    });
    return { rows };
  } catch (e) { return { err: e as Err }; }
}
const run = async (sql: string) => db.exec(`BEGIN;\n${sql}\nCOMMIT;`).then(() => undefined, async (e: Err) => { await db.exec('ROLLBACK').catch(() => {}); return e; });
const md5 = async (fn: string) => (await q<{ m: string }>(`select md5(prosrc) m from pg_proc where oid = '${fn}'::regprocedure`))[0]?.m;

const hr = uuid(), ceo = uuid(), cfo = uuid(), nobody = uuid();
async function staff(name: string) {
  const u = uuid();
  await q(`insert into public.profiles values ($1, $2)`, [u, name]);
  const [{ id }] = await q<{ id: string }>(`insert into public.hr_staff (user_id, staff_ref) values ($1, $2) returning id`, [u, `WEL-${name}`]);
  return { user: u, staff: id };
}
async function advance(staffId: string, status: string, ageHours: number, amount = 200_000) {
  const [{ id }] = await q<{ id: string }>(`insert into public.hr_pay_advances (staff_id, principal, purpose, status, requested_at)
    values ($1, $2, 'To clear some arrears', $3, now() - make_interval(hours => $4)) returning id`, [staffId, amount, status, ageHours]);
  return id;
}
type PromptRow = { advance_id: string; status: string; step: string; staff_name: string; principal: string; snooze_count: number; total_pending: number };
const prompt = async (user: string) => {
  const r = await as<PromptRow>(user, `select * from public.hr_pay_advance_pending_prompt()`);
  if (r.err) throw new Error(r.err.message);
  return r.rows![0] ?? null;
};
const snooze = (user: string, id: string) => as<{ until: string }>(user, `select public.hr_pay_advance_prompt_snooze($1) as until`, [id]);
/** Pretend the snooze ran out (time travel for one person). */
const expire = (user: string) => q(`update public.hr_pay_advance_prompt_snoozes set snooze_until = now() - interval '1 second' where user_id = $1`, [user]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STANDINS);
  await db.exec(PROD);
  await q(`insert into public.test_hr_authority values ($1, 'prepare'), ($2, 'approve'), ($3, 'release')`, [hr, ceo, cfo]);
  for (const [u, n] of [[hr, 'HR OFFICER'], [ceo, 'THE CEO'], [cfo, 'SARAH ANGWEN']]) await q(`insert into public.profiles values ($1, $2)`, [u, n]);
});
afterAll(async () => { await db?.close(); });

describe('migration 20261124090000: preflight and rollback', () => {
  it('fixtures are production\'s functions; the migration applies once; the rollback restores production exactly', async () => {
    expect(await md5('public.staff_loan_prompt_snooze(uuid)')).toBe('e664e3bfb403e1486fc4ee38fafc9c8f');
    expect(await md5('public.pso_facilitation_prompt_snooze(uuid)')).toBe('af7e1e967c546888c5f96fab2bac9b49');
    expect(await run(MIGRATION)).toBeUndefined();
    expect((await run(MIGRATION))?.message).toMatch(/precondition failed/);
    expect(await run(ROLLBACK)).toBeUndefined();
    expect(await md5('public.staff_loan_prompt_snooze(uuid)')).toBe('e664e3bfb403e1486fc4ee38fafc9c8f');
    expect(await md5('public.pso_facilitation_prompt_snooze(uuid)')).toBe('af7e1e967c546888c5f96fab2bac9b49');
    expect((await q(`select to_regclass('public.hr_pay_advance_prompt_snoozes') t`))[0].t).toBeNull();
    expect(await run(MIGRATION)).toBeUndefined();
  });

  it('refuses to run on a changed production function', async () => {
    const fresh = new PGlite();
    await fresh.exec(STANDINS);
    await fresh.exec(PROD.replace("interval '2 hours'", "interval '3 hours'"));
    await expect(fresh.exec(`BEGIN;\n${MIGRATION}\nCOMMIT;`)).rejects.toThrow(/no longer production/);
    await fresh.close();
  });
});

describe('staff loan and facilitation reminders: "Later" lasts 4 hours', () => {
  it.each(['staff_loan_prompt_snooze', 'pso_facilitation_prompt_snooze'])('%s snoozes its own prompt for 4 hours', async (fn) => {
    const table = fn === 'staff_loan_prompt_snooze' ? 'staff_loan_prompts' : 'pso_facilitation_prompts';
    const [{ id }] = await q<{ id: string }>(`insert into public.${table} (approver_id, kind) values ($1, 'cfo') returning id`, [cfo]);
    const r = await as<{ h: string; n: number }>(cfo,
      `select round(extract(epoch from (s.snooze_until - now())) / 3600) h, s.snooze_count n from public.${fn}($1) s`, [id]);
    expect(r.err).toBeUndefined();
    expect(Number(r.rows![0].h)).toBe(4);
    expect(r.rows![0].n).toBe(1);
    expect((await as(hr, `select public.${fn}($1)`, [id])).err?.message).toMatch(/not yours/);
  });
});

describe('salary advance reminder', () => {
  it('each step reminds only the person who holds it, never about their own advance, oldest first', async () => {
    const a = await staff('MEDDY');
    const b = await staff('AWANY');
    const requested = await advance(a.staff, 'requested', 5);
    const olderRequested = await advance(b.staff, 'requested', 9);
    const hrApproved = await advance(a.staff, 'hr_approved', 3);
    const ceoApproved = await advance(b.staff, 'ceo_approved', 2, 350_000);
    await advance(a.staff, 'approved', 1);                                   // paid: nobody is reminded
    await advance(a.staff, 'rejected', 1);

    const h = await prompt(hr);
    expect(h).toMatchObject({ advance_id: olderRequested, status: 'requested', step: 'hr', staff_name: 'AWANY', total_pending: 2 });
    expect((await prompt(ceo))).toMatchObject({ advance_id: hrApproved, step: 'ceo', staff_name: 'MEDDY', total_pending: 1 });
    expect((await prompt(cfo))).toMatchObject({ advance_id: ceoApproved, step: 'cfo', principal: '350000', total_pending: 1 });
    expect(await prompt(nobody)).toBeNull();
    expect(await prompt(a.user)).toBeNull();                                   // staff without authority
    expect((await as(null, `select * from public.hr_pay_advance_pending_prompt()`)).rows).toEqual([]);
    void requested;

    // the CFO's own advance is never shown to the CFO
    await q(`update public.hr_staff set user_id = $1 where id = $2`, [cfo, b.staff]);
    expect(await prompt(cfo)).toBeNull();
    await q(`update public.hr_staff set user_id = $1 where id = $2`, [b.user, b.staff]);
    await q(`delete from public.hr_pay_advances`);
  });

  it('"Later" hides that advance for 4 hours for that person only, then it comes back; the next step is a fresh reminder', async () => {
    const a = await staff('JOAN');
    const one = await advance(a.staff, 'requested', 6);
    const two = await advance(a.staff, 'requested', 4);
    await q(`insert into public.test_hr_authority values ($1, 'prepare')`, [ceo]);   // a second preparer

    const s = await snooze(hr, one);
    expect(s.err).toBeUndefined();
    const hours = (new Date(s.rows![0].until).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(3.99);
    expect(hours).toBeLessThanOrEqual(4.01);
    expect(await prompt(hr)).toMatchObject({ advance_id: two, total_pending: 2 });     // the other one still shows
    expect(await snooze(hr, two)).not.toHaveProperty('err');
    expect(await prompt(hr)).toBeNull();                                               // a refresh cannot bring them back
    expect((await prompt(ceo))?.advance_id).toBe(one);                                  // someone else is unaffected

    await expire(hr);
    expect(await prompt(hr)).toMatchObject({ advance_id: one, snooze_count: 1 });
    expect(await snooze(hr, one)).not.toHaveProperty('err');
    await expire(hr);
    expect((await prompt(hr))?.snooze_count).toBe(2);

    // HR approves it: HR is no longer reminded about it; the CEO's step starts fresh
    await q(`update public.hr_pay_advances set status = 'hr_approved' where id = $1`, [one]);
    await q(`delete from public.test_hr_authority where user_id = $1 and fn = 'prepare'`, [ceo]);
    expect((await prompt(hr))?.advance_id).toBe(two);
    expect(await prompt(ceo)).toMatchObject({ advance_id: one, step: 'ceo', snooze_count: 0 });
    await q(`delete from public.hr_pay_advances`);
  });

  it('"Later" is refused for an advance that is not waiting on the caller', async () => {
    const a = await staff('PETER');
    const id = await advance(a.staff, 'hr_approved', 1);
    expect((await snooze(hr, id)).err?.message).toMatch(/not waiting on you/);
    expect((await snooze(a.user, id)).err?.message).toMatch(/not waiting on you/);
    expect((await snooze(ceo, uuid())).err?.message).toMatch(/not waiting on you/);
    await q(`update public.hr_pay_advances set status = 'approved' where id = $1`, [id]);
    expect((await snooze(ceo, id)).err?.message).toMatch(/not waiting on you/);
    await q(`delete from public.hr_pay_advances`);
  });

  it('closed by default: anon cannot call it, and nobody can write the snooze table directly', async () => {
    expect((await as(null, `select * from public.hr_pay_advance_pending_prompt()`, [], 'anon')).err?.message).toMatch(/permission denied/);
    expect((await as(null, `select public.hr_pay_advance_prompt_snooze(gen_random_uuid())`, [], 'anon')).err?.message).toMatch(/permission denied/);
    expect((await as(hr, `insert into public.hr_pay_advance_prompt_snoozes values ($1, gen_random_uuid(), 'requested', now(), 0, now())`, [hr])).err?.message)
      .toMatch(/permission denied/);
    expect((await as(hr, `update public.hr_pay_advance_prompt_snoozes set snooze_until = now() + interval '1 year'`)).err?.message).toMatch(/permission denied/);
    const acl = await q<{ t: string }>(`select string_agg(policyname, ',' order by policyname) t from pg_policies where tablename = 'hr_pay_advance_prompt_snoozes'`);
    expect(acl[0].t).toBe('hr_pay_advance_prompt_snoozes_own_read,mfa_required_for_staff');
  });
});
