// @vitest-environment node
/**
 * Special Advances Phase 2: agreement storage (supabase/migrations/20261027231000_special_advances_storage.sql), on an
 * embedded Postgres (PGlite) with the Phase 1 engine and verbatim production copies of the role / MFA helpers
 * (scripts/fixtures/asset-register-helpers.sql). Agreements are written here as the table owner, the way the Phase 3
 * CFO-only functions will write them; signed-in users have no write path at all.
 */
import { readFileSync } from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { resolve } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ENGINE = read('supabase/migrations/20261027230000_special_advances_calc_engine.sql');
const STORAGE = read('supabase/migrations/20261027231000_special_advances_storage.sql');
const STORAGE_RB = read('supabase/rollbacks/20261027231000_special_advances_storage.rollback.sql');
const HELPERS = read('scripts/fixtures/asset-register-helpers.sql');

const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, role text not null,
  enabled boolean not null default true);
create table public.staff_mfa_config (id boolean primary key, mode text not null);
insert into public.staff_mfa_config values (true, 'shadow');
create table public.general_ledger (id bigserial primary key, amount numeric);
insert into public.general_ledger (amount) values (1), (2);
grant usage on schema public to anon, authenticated, service_role;
`;

let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const errOf = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return e as { code?: string; message: string; detail?: string }; } };

// people
const cfo = uuid(), cfo2 = uuid(), disabledCfo = uuid(), superAdmin = uuid(), ceo = uuid(), coo = uuid(), admin = uuid(), tenant = uuid();

/** Run as a signed-in Supabase user (JWT claims + the authenticated role), always rolled back. */
async function asUser<T>(userId: string | null, fn: (tx: Transaction) => Promise<T>, { role = 'authenticated', aal = 'aal2' } = {}) {
  try {
    let out: T | undefined;
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role, aal })]);
      await tx.exec(`set local role ${role}`);
      out = await fn(tx);
      await tx.rollback();
    });
    return { out: out as T, err: null };
  } catch (e) {
    return { out: undefined, err: e as { code?: string; message: string } };
  }
}

interface Terms { principal: number; rate: number; basis: string; term: number; frequency: string }
const T: Terms = { principal: 500_000, rate: 28, basis: 'monthly', term: 90, frequency: 'monthly' };

/** Records an agreement as the owner, exactly as the engine computes it (optionally tampered). Returns its id. */
async function record(opts: {
  terms?: Partial<Terms>; borrower?: { user?: string; external?: string };
  tamper?: (a: Record<string, unknown>, rows: Array<Record<string, unknown>>) => void; createdBy?: string;
} = {}) {
  const t = { ...T, ...opts.terms };
  const s = (await q<{ s: { access_fee: number; registration_fee: number; total_repayable: number; instalments: number; instalment_amount: number; calc_version: string;
    schedule: Array<{ number: number; due_date: string; amount: number; access_fee: number; registration_fee: number; principal: number }> } }>(
    `select public._special_advance_schedule($1, $2, $3, $4, $5, date '2000-01-01') s`, [t.principal, t.rate, t.basis, t.term, t.frequency]))[0].s;
  const id = uuid();
  const a: Record<string, unknown> = {
    id, reference: `SA-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
    borrower_kind: opts.borrower?.external ? 'external' : 'welile_user',
    borrower_user_id: opts.borrower?.external ? null : (opts.borrower?.user ?? tenant),
    external_borrower_id: opts.borrower?.external ?? null,
    principal: t.principal, rate_percent: t.rate, rate_basis: t.basis, term_days: t.term, frequency: t.frequency,
    access_fee: s.access_fee, registration_fee: s.registration_fee, total_repayable: s.total_repayable,
    instalments: s.instalments, instalment_amount: s.instalment_amount, calc_version: s.calc_version,
    purpose: 'Working capital for verified supplier stock', idempotency_key: uuid(), created_by: opts.createdBy ?? cfo,
  };
  const rows = s.schedule.map((r) => ({
    advance_id: id, number: r.number, due_offset_days: Math.round((Date.parse(r.due_date) - Date.parse('2000-01-01')) / 86_400_000),
    amount: r.amount, access_fee: r.access_fee, registration_fee: r.registration_fee, principal: r.principal,
  }));
  opts.tamper?.(a, rows);
  await db.transaction(async (tx) => {
    const cols = Object.keys(a);
    await tx.query(`insert into public.special_advances (${cols.join(', ')}) values (${cols.map((_, k) => `$${k + 1}`).join(', ')})`, Object.values(a));
    for (const r of rows) {
      await tx.query(`insert into public.special_advance_instalments (advance_id, number, due_offset_days, amount, access_fee, registration_fee, principal)
                      values ($1, $2, $3, $4, $5, $6, $7)`, [r.advance_id, r.number, r.due_offset_days, r.amount, r.access_fee, r.registration_fee, r.principal]);
    }
  });
  return id;
}
const advance = async (id: string) => (await q<Record<string, unknown>>(`select * from public.special_advances where id = $1`, [id]))[0];
const events = async (id: string) => q<{ event_type: string; from_status: string | null; to_status: string; actor_id: string; reason: string | null }>(
  `select event_type, from_status, to_status, actor_id, reason from public.special_advance_events where advance_id = $1 order by created_at, event_type`, [id]);
const approve = (id: string, by: string) => db.query(`update public.special_advances set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [id, by]);
const disburse = (id: string, payout: string, by = cfo) =>
  db.query(`update public.special_advances set status = 'disbursed', payout_date = $2::date, disbursed_by = $3, disbursed_at = now() where id = $1`, [id, payout, by]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + HELPERS + '\nset check_function_bodies = on;');
  for (const u of [cfo, cfo2, disabledCfo, superAdmin, ceo, coo, admin, tenant]) await db.query(`insert into auth.users values ($1)`, [u]);
  await db.query(`insert into public.user_roles (user_id, role, enabled) values
    ($1, 'cfo', true), ($2, 'cfo', true), ($3, 'cfo', false), ($4, 'super_admin', true), ($5, 'ceo', true), ($6, 'coo', true),
    ($7, 'admin', true), ($8, 'tenant', true)`, [cfo, cfo2, disabledCfo, superAdmin, ceo, coo, admin, tenant]);
}, 60_000);
afterAll(async () => { await db?.close(); });

describe('Phase 2 migration', () => {
  it('refuses to run before the engine, changing nothing', async () => {
    const e = await errOf(() => db.exec(`BEGIN;\n${STORAGE}\nCOMMIT;`));
    await db.exec('ROLLBACK').catch(() => {});
    expect(e?.message).toMatch(/engine \(20261027230000\) is not applied/);
    expect((await q<{ t: string | null }>(`select to_regclass('public.special_advances')::text t`))[0].t).toBeNull();
  });

  it('applies after the engine and refuses a second run', async () => {
    await db.exec(ENGINE);
    expect(await errOf(() => db.exec(`BEGIN;\n${STORAGE}\nCOMMIT;`))).toBeNull();
    const e = await errOf(() => db.exec(`BEGIN;\n${STORAGE}\nCOMMIT;`));
    await db.exec('ROLLBACK').catch(() => {});
    expect(e?.message).toMatch(/already exist/);
  });

  it('the issuance feature flag exists and is off by default', async () => {
    expect(await q(`select id, issuance_enabled from public.special_advance_settings`)).toEqual([{ id: true, issuance_enabled: false }]);
  });

  it('touches no existing advance product, ledger, wallet or payment object', () => {
    const code = STORAGE.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bagent_advance|general_ledger|wallet|payment|create_ledger_transaction|business_advance/i);
    expect(code).not.toMatch(/\b(ALTER|DROP)\s+(TABLE|FUNCTION|TRIGGER)\s+(?!.*special_advance)/i);
  });
});

describe('Phase 2 grants, RLS and access (CFO only)', () => {
  const TABLES = ['special_advances', 'special_advance_instalments', 'special_advance_events', 'special_advance_external_borrowers', 'special_advance_settings'];

  it('signed-in users may only SELECT (RLS-gated); anon has nothing', async () => {
    for (const t of TABLES) {
      const p = (await q<Record<string, boolean>>(`select
        has_table_privilege('authenticated', 'public.${t}', 'SELECT') a_sel, has_table_privilege('authenticated', 'public.${t}', 'INSERT') a_ins,
        has_table_privilege('authenticated', 'public.${t}', 'UPDATE') a_upd, has_table_privilege('authenticated', 'public.${t}', 'DELETE') a_del,
        has_table_privilege('anon', 'public.${t}', 'SELECT') n_sel, has_table_privilege('anon', 'public.${t}', 'INSERT') n_ins`))[0];
      expect(p, t).toEqual({ a_sel: true, a_ins: false, a_upd: false, a_del: false, n_sel: false, n_ins: false });
      const rls = (await q<{ r: boolean }>(`select relrowsecurity r from pg_class where oid = 'public.${t}'::regclass`))[0].r;
      expect(rls, t).toBe(true);
      const mfa = await q(`select 1 from pg_policies where tablename = $1 and policyname = 'mfa_required_for_staff' and permissive = 'RESTRICTIVE'`, [t]);
      expect(mfa, t).toHaveLength(1);
    }
  });

  it('internal trigger functions are not callable by signed-in users; the CFO gate is (for RLS)', async () => {
    const fns = await q<{ name: string; auth: boolean; anon: boolean }>(`select p.proname name,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') auth, has_function_privilege('anon', p.oid, 'EXECUTE') anon
      from pg_proc p where p.proname like '%special\\_advance%' order by 1`);
    for (const f of fns) {
      expect(f.anon, f.name).toBe(false);
      expect(f.auth, f.name).toBe(f.name === 'special_advance_cfo_ok');
    }
  });

  it('only an enabled CFO can read agreements; Super Admin, CEO, COO, admin, a disabled CFO and others see nothing', async () => {
    await record();
    for (const [who, id, n] of [['cfo', cfo, true], ['super_admin', superAdmin, false], ['ceo', ceo, false], ['coo', coo, false],
      ['admin', admin, false], ['disabled cfo', disabledCfo, false], ['tenant', tenant, false]] as const) {
      const r = await asUser(id, (tx) => tx.query<{ n: number }>(`select count(*)::int n from public.special_advances`));
      expect(r.err, who).toBeNull();
      expect(r.out!.rows[0].n > 0, who).toBe(n);
    }
    const anon = await asUser(null, (tx) => tx.query(`select 1 from public.special_advances`), { role: 'anon' });
    expect(anon.err?.message).toMatch(/permission denied/);
  });

  it('MFA mode admin: a CFO without a second factor sees nothing', async () => {
    await db.exec(`update public.staff_mfa_config set mode = 'admin'`);
    const r1 = await asUser(cfo, (tx) => tx.query<{ n: number }>(`select count(*)::int n from public.special_advances`), { aal: 'aal1' });
    const r2 = await asUser(cfo, (tx) => tx.query<{ n: number }>(`select count(*)::int n from public.special_advances`), { aal: 'aal2' });
    await db.exec(`update public.staff_mfa_config set mode = 'shadow'`);
    expect(r1.out!.rows[0].n).toBe(0);
    expect(r2.out!.rows[0].n).toBeGreaterThan(0);
  });

  it('a signed-in CFO still cannot write directly (functions only, Phase 3)', async () => {
    const r = await asUser(cfo, (tx) => tx.query(`update public.special_advances set purpose = purpose`));
    expect(r.err?.message).toMatch(/permission denied/);
    const r2 = await asUser(cfo, (tx) => tx.query(`update public.special_advance_settings set issuance_enabled = true`));
    expect(r2.err?.message).toMatch(/permission denied/);
  });
});

describe('Phase 2 agreements: only server-calculated figures can be stored', () => {
  it('stores an agreement for a Welile user, with a creation event', async () => {
    const id = await record();
    const a = await advance(id);
    expect(a).toMatchObject({ status: 'pending_approval', principal: 500000, access_fee: 420000, registration_fee: 20000, total_repayable: 940000, instalments: 3 });
    expect(await events(id)).toEqual([{ event_type: 'created', from_status: null, to_status: 'pending_approval', actor_id: cfo, reason: null }]);
    const rows = await q(`select number, due_offset_days, due_date, amount from public.special_advance_instalments where advance_id = $1 order by number`, [id]);
    expect(rows).toEqual([
      { number: 1, due_offset_days: 30, due_date: null, amount: 313334 },
      { number: 2, due_offset_days: 60, due_date: null, amount: 313334 },
      { number: 3, due_offset_days: 90, due_date: null, amount: 313332 }]);
  });

  it('stores an agreement for an external borrower; exactly one borrower is required', async () => {
    const ext = uuid();
    await db.query(`insert into public.special_advance_external_borrowers (id, borrower_type, full_name, phone, national_id, created_by)
                    values ($1, 'individual', 'John Mukasa', '+256772123456', 'CM900000000000', $2)`, [ext, cfo]);
    const id = await record({ borrower: { external: ext } });
    expect(await advance(id)).toMatchObject({ borrower_kind: 'external', external_borrower_id: ext, borrower_user_id: null });
    const both = await errOf(() => record({ tamper: (a) => { a.external_borrower_id = ext; } }));
    expect(both?.message).toMatch(/special_advances_one_borrower/);
    const none = await errOf(() => record({ tamper: (a) => { a.borrower_user_id = null; } }));
    expect(none?.message).toMatch(/special_advances_one_borrower/);
    const ghost = await errOf(() => record({ borrower: { user: uuid() } }));
    expect(ghost?.code).toBe('23503'); // not a registered account
  });

  it('refuses invalid terms written straight into the table (single definition: the engine)', async () => {
    // valid figures are computed first, then the stored terms are tampered, so it is the table CHECK that refuses them
    for (const bad of [{ rate_percent: 30 }, { rate_percent: 1.5, rate_basis: 'daily' }, { term_days: 91 }, { frequency: 'biweekly' },
      { rate_percent: 0 }, { rate_basis: 'weekly' }]) {
      const e = await errOf(() => record({ tamper: (a) => { Object.assign(a, bad); } }));
      expect(e?.message, JSON.stringify(bad)).toMatch(/special_advances_terms_valid/);
    }
    const low = await errOf(() => record({ tamper: (a) => { Object.assign(a, { principal: 9_999, total_repayable: 9_999 + 420_000 + 20_000 }); } }));
    expect(low?.message).toMatch(/special_advances_terms_valid/);
  });

  it('refuses browser-supplied figures: any amount or schedule row that differs from the engine', async () => {
    const amounts = await errOf(() => record({ tamper: (a) => { a.access_fee = 419_000; a.total_repayable = 939_000; } }));
    expect(amounts?.message).toBe('SPECIAL_ADVANCE_AMOUNTS_MISMATCH');
    const split = await errOf(() => record({ tamper: (_a, rows) => { rows[0].access_fee = 313_333; rows[0].principal = 1; } }));
    expect(split?.message).toBe('SPECIAL_ADVANCE_SCHEDULE_MISMATCH');
    const offset = await errOf(() => record({ tamper: (_a, rows) => { rows[2].due_offset_days = 89; } }));
    expect(offset?.message).toBe('SPECIAL_ADVANCE_SCHEDULE_MISMATCH');
    const missing = await errOf(() => record({ tamper: (_a, rows) => { rows.pop(); } }));
    expect(missing?.message).toBe('SPECIAL_ADVANCE_SCHEDULE_MISMATCH');
    const before = (await q<{ n: number }>(`select count(*)::int n from public.special_advances`))[0].n;
    expect(before).toBeGreaterThan(0);
    // a row added later to a pending agreement is refused at commit as well
    const id = await record();
    const extra = await errOf(() => db.transaction(async (tx) => {
      await tx.query(`insert into public.special_advance_instalments (advance_id, number, due_offset_days, amount, access_fee, registration_fee, principal)
                      values ($1, 4, 90, 1, 0, 0, 1)`, [id]);
    }));
    expect(extra?.message).toBe('SPECIAL_ADVANCE_SCHEDULE_MISMATCH');
  });

  it('a new agreement must start pending with no decision', async () => {
    const e = await errOf(() => record({ tamper: (a) => { Object.assign(a, { status: 'approved', approved_by: cfo, approved_at: new Date().toISOString() }); } }));
    expect(e?.message).toBe('SPECIAL_ADVANCE_MUST_START_PENDING');
  });
});

describe('Phase 2 lifecycle: CFO-only approval, fixed terms, set-once decisions', () => {
  it('agreed terms and amounts can never change, even before approval and even by the owner', async () => {
    const id = await record();
    for (const sql of [`principal = 600000`, `rate_percent = 15`, `term_days = 30`, `access_fee = 0`, `borrower_user_id = '${cfo}'`, `purpose = 'changed purpose text here'`]) {
      const e = await errOf(() => db.query(`update public.special_advances set ${sql} where id = $1`, [id]));
      expect(e?.message, sql).toBe('SPECIAL_ADVANCE_TERMS_IMMUTABLE');
    }
  });

  it('approval needs an enabled CFO: Super Admin, CEO, admin and a disabled CFO are refused', async () => {
    const id = await record();
    for (const who of [superAdmin, ceo, admin, coo, disabledCfo, tenant]) {
      const e = await errOf(() => approve(id, who));
      expect(e?.message).toBe('SPECIAL_ADVANCE_APPROVER_NOT_CFO');
    }
    expect((await advance(id)).status).toBe('pending_approval');
    await approve(id, cfo);
    const a = await advance(id);
    expect(a.status).toBe('approved');
    expect((await events(id)).map((e) => [e.event_type, e.actor_id])).toEqual([['created', cfo], ['approved', cfo]]);
  });

  it('approval moves no money and sets no due dates', async () => {
    const id = await record();
    await approve(id, cfo);
    expect(await q(`select due_date from public.special_advance_instalments where advance_id = $1`, [id])).toEqual([{ due_date: null }, { due_date: null }, { due_date: null }]);
    expect((await q<{ n: number }>(`select count(*)::int n from public.general_ledger`))[0].n).toBe(2);
  });

  it('decisions are set once: an approval cannot be re-attributed or undone', async () => {
    const id = await record();
    await approve(id, cfo);
    expect((await errOf(() => db.query(`update public.special_advances set approved_by = $2 where id = $1`, [id, cfo2])))?.message).toBe('SPECIAL_ADVANCE_DECISION_IMMUTABLE');
    expect((await errOf(() => db.query(`update public.special_advances set status = 'pending_approval' where id = $1`, [id])))?.message).toBe('SPECIAL_ADVANCE_INVALID_TRANSITION');
    expect((await errOf(() => db.query(`update public.special_advances set status = 'rejected', rejected_by = $2, rejected_at = now(), decision_reason = 'too late now' where id = $1`, [id, cfo])))?.message).toBe('SPECIAL_ADVANCE_INVALID_TRANSITION');
  });

  it('rejection and cancellation need an actor and a reason, and are final', async () => {
    const r = await record();
    expect((await errOf(() => db.query(`update public.special_advances set status = 'rejected', rejected_by = $2, rejected_at = now() where id = $1`, [r, cfo])))?.message).toMatch(/special_advances_rejected_fields/);
    await db.query(`update public.special_advances set status = 'rejected', rejected_by = $2, rejected_at = now(), decision_reason = 'Borrower withdrew the request' where id = $1`, [r, cfo]);
    expect((await errOf(() => approve(r, cfo)))?.message).toBe('SPECIAL_ADVANCE_INVALID_TRANSITION');
    expect((await events(r)).at(-1)).toMatchObject({ event_type: 'rejected', from_status: 'pending_approval', actor_id: cfo, reason: 'Borrower withdrew the request' });

    const c = await record();
    await approve(c, cfo);
    await db.query(`update public.special_advances set status = 'cancelled', cancelled_by = $2, cancelled_at = now(), decision_reason = 'Payout not needed any more' where id = $1`, [c, cfo]);
    expect((await errOf(() => disburse(c, '2026-11-02')))?.message).toBe('SPECIAL_ADVANCE_INVALID_TRANSITION');
    expect((await events(c)).map((e) => e.event_type)).toEqual(['created', 'approved', 'cancelled']);
  });

  it('only an approved agreement can be paid out; settlement only after payout', async () => {
    const id = await record();
    expect((await errOf(() => disburse(id, '2026-11-02')))?.message).toBe('SPECIAL_ADVANCE_INVALID_TRANSITION');
    await approve(id, cfo);
    expect((await errOf(() => db.query(`update public.special_advances set status = 'settled', settled_at = now() where id = $1`, [id])))?.message).toBe('SPECIAL_ADVANCE_INVALID_TRANSITION');
    expect((await errOf(() => db.query(`update public.special_advances set status = 'disbursed', disbursed_at = now(), payout_date = '2026-11-02' where id = $1`, [id])))?.message).toMatch(/special_advances_disbursed_fields/);
  });

  it('payout fixes every due date from the payout date, once', async () => {
    const id = await record();
    await approve(id, cfo);
    await disburse(id, '2026-11-02', cfo2);
    expect(await q(`select number, due_date::text d from public.special_advance_instalments where advance_id = $1 order by number`, [id]))
      .toEqual([{ number: 1, d: '2026-12-02' }, { number: 2, d: '2027-01-01' }, { number: 3, d: '2027-01-31' }]);
    expect((await events(id)).at(-1)).toMatchObject({ event_type: 'disbursed', actor_id: cfo2 });
    expect((await errOf(() => db.query(`update public.special_advance_instalments set due_date = due_date + 1 where advance_id = $1`, [id])))?.message).toBe('SPECIAL_ADVANCE_SCHEDULE_FIXED');
    expect((await errOf(() => db.query(`update public.special_advance_instalments set amount = amount where advance_id = $1 and number = 1`, [id])))).toBeNull(); // no-op is fine
    expect((await errOf(() => db.query(`update public.special_advance_instalments set access_fee = access_fee - 1, principal = principal + 1 where advance_id = $1 and number = 1`, [id])))?.message).toBe('SPECIAL_ADVANCE_SCHEDULE_FIXED');
    expect((await errOf(() => db.query(`update public.special_advances set payout_date = '2026-11-03' where id = $1`, [id])))?.message).toBe('SPECIAL_ADVANCE_DECISION_IMMUTABLE');
  });

  it('due dates cannot be set before payout', async () => {
    const id = await record();
    await approve(id, cfo);
    expect((await errOf(() => db.query(`update public.special_advance_instalments set due_date = '2026-12-01' where advance_id = $1`, [id])))?.message).toBe('SPECIAL_ADVANCE_SCHEDULE_FIXED');
  });
});

describe('Phase 2 audit and records cannot be removed', () => {
  it('events, external borrowers, agreements, instalments and the settings row cannot be deleted; events and borrowers cannot be edited', async () => {
    const id = await record();
    for (const sql of [
      `delete from public.special_advance_events`, `update public.special_advance_events set reason = 'x'`,
      `delete from public.special_advance_external_borrowers`, `update public.special_advance_external_borrowers set full_name = 'Someone Else'`,
      `delete from public.special_advances where id = '${id}'`, `delete from public.special_advance_instalments where advance_id = '${id}'`,
      `delete from public.special_advance_settings`,
    ]) {
      expect((await errOf(() => db.exec(sql)))?.code, sql).toBe('42501');
    }
  });
});

describe('Phase 2 rollback', () => {
  it('refuses while records exist, then removes only the Phase 2 objects (the engine stays) and can be re-applied', async () => {
    const e = await errOf(() => db.exec(`BEGIN;\n${STORAGE_RB}\nCOMMIT;`));
    await db.exec('ROLLBACK').catch(() => {});
    expect(e?.message).toMatch(/records exist/);
    expect((await q<{ t: string | null }>(`select to_regclass('public.special_advances')::text t`))[0].t).not.toBeNull();
    expect(await errOf(() => db.exec(`BEGIN;\nSET LOCAL special_advances.rollback_discard_data = 'yes';\n${STORAGE_RB}\nCOMMIT;`))).toBeNull();
    const left = (await q<{ t: number; f: number; e: number }>(`select
      (select count(*) from pg_class where relname like 'special\\_advance%')::int t,
      (select count(*) from pg_proc where proname like '%special\\_advance%' and proname not in ('_special_advance_term_errors', '_special_advance_schedule', '_special_advance_allocate'))::int f,
      (select count(*) from pg_proc where proname in ('_special_advance_term_errors', '_special_advance_schedule', '_special_advance_allocate'))::int e`))[0];
    expect(left).toEqual({ t: 0, f: 0, e: 3 });
    expect(await errOf(() => db.exec(`BEGIN;\n${STORAGE}\nCOMMIT;`))).toBeNull();
    expect((await q<{ n: number }>(`select count(*)::int n from public.general_ledger`))[0].n).toBe(2);
  });
});
