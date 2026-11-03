// @vitest-environment node
/**
 * The read-only production verification for Special Advances phases 1-3 (supabase/tests/special_advances_phase1_3.sql)
 * on PGlite, with production's auth.uid()/auth.jwt() and verbatim role / MFA helpers. It must: report every object
 * missing before the migrations; pass all 8 steps after them; catch issuance switched on and a wrong grant; ignore a
 * stale identity left in the session; and write nothing (it runs inside BEGIN TRANSACTION READ ONLY, as in production).
 */
import { readFileSync } from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ENGINE = read('supabase/migrations/20261028150000_special_advances_calc_engine.sql');
const STORAGE = read('supabase/migrations/20261028151000_special_advances_storage.sql');
const FUNCTIONS = read('supabase/migrations/20261028152000_special_advances_functions.sql');
const VERIFY = read('supabase/tests/special_advances_phase1_3.sql');
const HELPERS = read('scripts/fixtures/asset-register-helpers.sql');

// auth.uid() / auth.jwt() exactly as production defines them (they read request.jwt.claim[.sub] first)
const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, role text not null,
  enabled boolean not null default true);
create table public.profiles (id uuid primary key, full_name text, deleted_at timestamptz);
create table public.staff_mfa_config (id boolean primary key, mode text not null);
insert into public.staff_mfa_config values (true, 'shadow');
create table public.agent_advances (id uuid primary key default gen_random_uuid(), agent_id uuid not null, status text not null,
  outstanding_balance numeric not null default 0);
create table public.business_advances (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, status text not null,
  outstanding_balance numeric not null default 0);
grant usage on schema public to anon, authenticated, service_role;
`;

type Step = { step: number; pass: boolean; [k: string]: unknown };
let db: PGlite;
const cfo = uuid();

/** Runs the verification exactly as in production: inside a read-only transaction; returns its step report. */
async function verify(): Promise<Step[]> {
  await db.exec('BEGIN TRANSACTION READ ONLY');
  try {
    await db.exec(VERIFY);
    throw new Error('the verification must end in RAISE EXCEPTION');
  } catch (e) {
    const m = (e as Error).message.match(/verification \(read only\): (\[.*\])$/s);
    if (!m) throw e;
    return JSON.parse(m[1]);
  } finally {
    await db.exec('ROLLBACK').catch(() => {});
  }
}
const step = (r: Step[], n: number) => r.find((s) => s.step === n)!;
const fingerprint = async () => (await db.query<{ h: string }>(`select md5(
  coalesce((select string_agg(t::text, '|' order by t::text) from public.special_advances t), '') ||
  coalesce((select string_agg(t::text, '|' order by t::text) from public.special_advance_settings t), '') ||
  coalesce((select string_agg(t::text, '|' order by t::text) from public.special_advance_events t), '')) h`)).rows[0].h;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + HELPERS + '\nset check_function_bodies = on;');
  await db.query(`insert into auth.users values ($1)`, [cfo]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, 'The CFO')`, [cfo]);
  await db.query(`insert into public.user_roles (user_id, role, enabled) values ($1, 'cfo', true)`, [cfo]);
}, 60_000);
afterAll(async () => { await db?.close(); });

describe('special_advances_phase1_3.sql (read-only production verification)', () => {
  it('before the migrations: step 1 fails and lists every missing object', async () => {
    const r = await verify();
    expect(r).toHaveLength(1);
    expect(step(r, 1).pass).toBe(false);
    expect(step(r, 1).missing).toEqual(expect.arrayContaining(['special_advance_quote(jsonb)', 'special_advances', 'special_advance_ref_seq',
      '_special_advance_schedule(numeric,numeric,text,numeric,text,date)']));
  });

  it('after phases 1-3: all 8 steps pass, with the known quote (500,000 at 28%/month, 7 days -> access fee 32,667)', async () => {
    await db.exec(ENGINE);
    await db.exec(`BEGIN;\n${STORAGE}\nCOMMIT;`);
    await db.exec(`BEGIN;\n${FUNCTIONS}\nCOMMIT;`);
    const r = await verify();
    expect(r.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.filter((s) => !s.pass)).toEqual([]);
    expect(step(r, 6).access_fee).toBe(32667);
    expect(step(r, 6).instalments).toBe(1);
    expect(step(r, 6).issuance_enabled).toBe(false);
    expect(step(r, 8).special_advances_recorded).toBe(0);
  }, 60_000);

  it('writes nothing', async () => {
    const before = await fingerprint();
    await verify();
    expect(await fingerprint()).toBe(before);
  });

  it('ignores a stale identity left in the session (request.jwt.claim.sub)', async () => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [cfo]);
    try {
      const r = await verify();
      expect(step(r, 5).pass).toBe(true);
    } finally {
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    }
  });

  it('catches issuance switched on (steps 4, 6 and 7 fail)', async () => {
    await db.query(`update public.special_advance_settings set issuance_enabled = true`);
    try {
      const r = await verify();
      expect([4, 6, 7].map((n) => step(r, n).pass)).toEqual([false, false, false]);
      expect([1, 2, 3, 5].every((n) => step(r, n).pass)).toBe(true);
    } finally {
      await db.query(`update public.special_advance_settings set issuance_enabled = false`);
    }
  });

  it('catches a wrong grant (an internal function callable by anon; a table writable by authenticated)', async () => {
    await db.exec(`grant execute on function public._special_advance_issuance_enabled() to anon;
                   grant insert on public.special_advances to authenticated;`);
    try {
      const w = step(await verify(), 2);
      expect(w.pass).toBe(false);
      expect(w.wrong_grants).toEqual(expect.arrayContaining(['_special_advance_issuance_enabled()', 'special_advances']));
    } finally {
      await db.exec(`revoke execute on function public._special_advance_issuance_enabled() from anon;
                     revoke insert on public.special_advances from authenticated;`);
    }
    expect((await verify()).every((s) => s.pass)).toBe(true);
  });

  it('fails step 6 and 7 when no enabled CFO exists', async () => {
    await db.query(`update public.user_roles set enabled = false where user_id = $1`, [cfo]);
    try {
      const r = await verify();
      expect(step(r, 6).pass).toBe(false);
      expect(step(r, 6).error).toMatch(/no enabled CFO/);
      expect(step(r, 7).pass).toBe(false);
    } finally {
      await db.query(`update public.user_roles set enabled = true where user_id = $1`, [cfo]);
    }
  });
});
