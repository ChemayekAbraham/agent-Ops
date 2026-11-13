// @vitest-environment node
/**
 * Bank balance anchors — supabase/migrations/20261110120000_fin_bank_anchors.sql run verbatim on PGlite after the
 * reporting engine migration (which provides _fin_can_view). Reporting only: no ledger or wallet object is involved.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ENGINE = read('supabase/migrations/20261110090000_fin_reporting_engine.sql');
const MIG = read('supabase/migrations/20261110120000_fin_bank_anchors.sql');
const RB = read('supabase/rollbacks/20261110120000_fin_bank_anchors.rollback.sql');

const CFO = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
const AGENT = '00000000-0000-0000-0000-00000000a001';

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create type public.app_role as enum ('cfo','ceo','coo','manager','financial_ops','super_admin','cto','agent');
create table public.user_roles (user_id uuid, role public.app_role);
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as
  $$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role) $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
insert into public.user_roles values ('${CFO}','cfo'), ('${AGENT}','agent');
`;

let db: PGlite;
const asUser = async (uid: string, sql: string) => {
  await db.exec(`select set_config('test.uid', '${uid}', false)`);
  return db.query<{ r: Record<string, unknown> | null }>(sql);
};

describe('fin_bank_anchors', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(ENGINE);
    await db.exec(MIG);
  });

  it('records the CFO-confirmed zero balance on 7 Oct 2026 and returns it', async () => {
    const r = (await asUser(CFO, `select public.fin_bank_anchor() as r`)).rows[0].r as Record<string, unknown>;
    expect(r.account_key).toBe('equity');
    expect(Number(r.balance)).toBe(0);
    expect(r.source).toBe('cfo_confirmation');
    expect(new Date(String(r.anchor_at)).toISOString()).toBe('2026-10-06T21:00:00.000Z'); // 7 Oct 00:00 Kampala
  });

  it('returns the latest anchor when a statement balance is added later', async () => {
    await db.exec(`insert into public.fin_bank_anchors (account_key, account_label, anchor_at, balance, source)
                   values ('equity','Equity','2026-11-30 23:59:59+03', 1234, 'bank_statement')`);
    const r = (await asUser(CFO, `select public.fin_bank_anchor('equity') as r`)).rows[0].r as Record<string, unknown>;
    expect(Number(r.balance)).toBe(1234);
    expect(r.source).toBe('bank_statement');
    await db.exec(`delete from public.fin_bank_anchors where source = 'bank_statement'`);
  });

  it('is idempotent: re-running does not add a second anchor', async () => {
    await db.exec(MIG);
    const n = await db.query<{ n: number }>(`select count(*)::int n from public.fin_bank_anchors`);
    expect(n.rows[0].n).toBe(1);
  });

  it('returns null for an account without an anchor, and refuses non-finance users', async () => {
    const r = (await asUser(CFO, `select public.fin_bank_anchor('other') as r`)).rows[0].r;
    expect(r).toBeNull();
    await expect(asUser(AGENT, `select public.fin_bank_anchor()`)).rejects.toThrow(/Not authorised/);
  });

  it('is read-only and the rollback removes it', async () => {
    const f = await db.query<{ v: string }>(`select provolatile v from pg_proc where proname = 'fin_bank_anchor'`);
    expect(f.rows[0].v).toBe('s');
    await db.exec(RB);
    const t = await db.query<{ n: number }>(`select count(*)::int n from pg_class where relname = 'fin_bank_anchors'`);
    expect(t.rows[0].n).toBe(0);
  });
});
