// @vitest-environment node
/**
 * Special Advances Phase 3: CFO-only server functions (supabase/migrations/20261027232000_special_advances_functions.sql)
 * on PGlite, with the Phase 1 engine, Phase 2 storage and verbatim production role / MFA helpers. Every call runs as a
 * signed-in user (JWT claims + the authenticated role) through the public functions only.
 *
 * PGlite has one connection, so truly parallel requests cannot run here; the race protections are covered by the
 * idempotency replay, the advisory locks' presence in the code, and the database backstop (unique partial index).
 */
import { readFileSync } from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ENGINE = read('supabase/migrations/20261027230000_special_advances_calc_engine.sql');
const STORAGE = read('supabase/migrations/20261027231000_special_advances_storage.sql');
const FUNCTIONS = read('supabase/migrations/20261027232000_special_advances_functions.sql');
const FUNCTIONS_RB = read('supabase/rollbacks/20261027232000_special_advances_functions.rollback.sql');
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
create table public.profiles (id uuid primary key, full_name text, deleted_at timestamptz);
create table public.staff_mfa_config (id boolean primary key, mode text not null);
insert into public.staff_mfa_config values (true, 'shadow');
create table public.agent_advances (id uuid primary key default gen_random_uuid(), agent_id uuid not null, status text not null,
  outstanding_balance numeric not null default 0);
create table public.business_advances (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, status text not null,
  outstanding_balance numeric not null default 0);
create table public.general_ledger (id bigserial primary key, amount numeric);
insert into public.general_ledger (amount) values (1), (2);
grant usage on schema public to anon, authenticated, service_role;
`;

let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
type Err = { code?: string; message: string; detail?: string };

const cfo = uuid(), cfo2 = uuid(), disabledCfo = uuid(), superAdmin = uuid(), ceo = uuid(), coo = uuid(), admin = uuid();
const tenant = uuid(), agent = uuid(), deleted = uuid(), roleless = uuid(), bizTenant = uuid(), staffer = uuid();
const names: Record<string, string> = { [tenant]: 'Tenant Borrower', [agent]: 'Agent Borrower' };

/** Calls a function as a signed-in user; commits (so deferred checks run) unless rollback is asked. */
async function call<T = Record<string, unknown>>(user: string | null, sql: string, params: unknown[] = [],
  { role = 'authenticated', aal = 'aal2', rollback = false } = {}): Promise<{ out?: T; err?: Err }> {
  try {
    let out: T | undefined;
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role, aal })]);
      await tx.exec(`set local role ${role}`);
      out = (await tx.query<{ r: T }>(sql, params)).rows[0]?.r;
      if (rollback) await tx.rollback();
    });
    return { out };
  } catch (e) {
    return { err: e as Err };
  }
}
type Adv = { id: string; reference: string; status: string; updated_at: string; principal: number; access_fee: number; registration_fee: number;
  total_repayable: number; instalments: number; approved_by: string | null; replayed?: boolean; schedule: Array<Record<string, unknown>>;
  events: Array<{ event_type: string; actor_id: string; reason: string | null }>; borrower_name: string | null };

const TERMS = { principal: 500_000, rate_percent: 28, rate_basis: 'monthly', term_days: 90, frequency: 'monthly' };
const request = (over: Record<string, unknown> = {}) => ({
  borrower: { kind: 'welile_user', user_id: tenant }, terms: TERMS, purpose: 'Working capital for verified supplier stock',
  expected_total_repayable: 940_000, idempotency_key: uuid(), ...over,
});
const quote = (user: string, req: Record<string, unknown>) => call<Record<string, unknown>>(user, `select public.special_advance_quote($1::jsonb) r`, [JSON.stringify(req)]);
const create = (user: string, req: Record<string, unknown>) => call<Adv>(user, `select public.special_advance_create($1::jsonb) r`, [JSON.stringify(req)]);
const decide = (user: string, fn: 'approve' | 'reject' | 'cancel', a: { id: string; updated_at: string }, reason: string | null = null) =>
  call<Adv>(user, `select public.special_advance_${fn}($1, $2::timestamptz, $3) r`, [a.id, a.updated_at, reason]);
const get = async (id: string) => (await call<Adv>(cfo, `select public.special_advance_get($1) r`, [id])).out!;
const count = async (t: string) => (await q<{ n: number }>(`select count(*)::int n from public.${t}`))[0].n;
const setFlag = (on: boolean) => db.query(`update public.special_advance_settings set issuance_enabled = $1`, [on]);
const detail = (e?: Err) => JSON.parse(e?.detail ?? '[]');

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + HELPERS + '\nset check_function_bodies = on;');
  const people = [cfo, cfo2, disabledCfo, superAdmin, ceo, coo, admin, tenant, agent, deleted, roleless, bizTenant, staffer];
  for (const u of people) {
    await db.query(`insert into auth.users values ($1)`, [u]);
    await db.query(`insert into public.profiles (id, full_name, deleted_at) values ($1, $2, $3)`, [u, names[u] ?? 'Person', u === deleted ? new Date().toISOString() : null]);
  }
  await db.query(`insert into public.user_roles (user_id, role, enabled) values
    ($1, 'cfo', true), ($2, 'cfo', true), ($3, 'cfo', false), ($4, 'super_admin', true), ($5, 'ceo', true), ($6, 'coo', true),
    ($7, 'admin', true), ($8, 'tenant', true), ($9, 'agent', true), ($10, 'tenant', true), ($11, 'tenant', false), ($12, 'tenant', true),
    ($13, 'employee', true)`, [cfo, cfo2, disabledCfo, superAdmin, ceo, coo, admin, tenant, agent, deleted, roleless, bizTenant, staffer]);
  await db.exec(ENGINE);
  await db.exec(`BEGIN;\n${STORAGE}\nCOMMIT;`);
}, 60_000);
afterAll(async () => { await db?.close(); });

describe('Phase 3 migration', () => {
  it('applies after storage and refuses a second run', async () => {
    await db.exec(`BEGIN;\n${FUNCTIONS}\nCOMMIT;`);
    const e = await db.exec(`BEGIN;\n${FUNCTIONS}\nCOMMIT;`).catch((x: Err) => x);
    await db.exec('ROLLBACK').catch(() => {});
    expect((e as Err).message).toMatch(/already exist/);
  });

  it('public functions: signed-in may call (they check the CFO role inside), anon may not; internals are owner-only', async () => {
    const fns = await q<{ name: string; auth: boolean; anon: boolean; definer: boolean }>(`select p.proname name, p.prosecdef definer,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') auth, has_function_privilege('anon', p.oid, 'EXECUTE') anon
      from pg_proc p where p.proname like '%special\\_advance%' order by 1`);
    const publicFns = ['special_advance_approve', 'special_advance_cancel', 'special_advance_cfo_ok', 'special_advance_create',
      'special_advance_get', 'special_advance_list', 'special_advance_quote', 'special_advance_reject'];
    for (const f of fns) {
      expect(f.anon, f.name).toBe(false);
      expect(f.auth, f.name).toBe(publicFns.includes(f.name));
    }
    expect(fns.filter((f) => publicFns.includes(f.name)).every((f) => f.definer)).toBe(true);
  });

  it('references no ledger, wallet or payment object and changes no existing advance table', () => {
    const code = FUNCTIONS.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/general_ledger|wallet|create_ledger_transaction|payment/i);
    expect(code).not.toMatch(/(insert\s+into|update|delete\s+from)\s+public\.(agent_advances|business_advances)/i);
  });
});

describe('Phase 3 access: the CFO is the sole authority', () => {
  it.each([['super_admin', superAdmin], ['ceo', ceo], ['coo', coo], ['admin', admin], ['disabled cfo', disabledCfo], ['tenant', tenant], ['employee', staffer]])(
    '%s is refused by every function', async (_who, user) => {
      for (const sql of [`select public.special_advance_quote('{}'::jsonb) r`, `select public.special_advance_create('{}'::jsonb) r`,
        `select public.special_advance_list() r`, `select public.special_advance_get('${uuid()}') r`,
        `select public.special_advance_approve('${uuid()}', now(), null) r`, `select public.special_advance_reject('${uuid()}', now(), 'reason text') r`,
        `select public.special_advance_cancel('${uuid()}', now(), 'reason text') r`]) {
        const r = await call(user, sql);
        expect(r.err?.code, sql).toBe('42501');
        expect(r.err?.message, sql).toBe('NOT_AUTHORIZED');
      }
    });

  it('signed-out callers cannot execute the functions', async () => {
    const r = await call(null, `select public.special_advance_quote('{}'::jsonb) r`, [], { role: 'anon' });
    expect(r.err?.message).toMatch(/permission denied/);
  });

  it('MFA mode admin: a CFO without a second factor is refused', async () => {
    await db.exec(`update public.staff_mfa_config set mode = 'admin'`);
    const r1 = await call(cfo, `select public.special_advance_list() r`, [], { aal: 'aal1' });
    const r2 = await call(cfo, `select public.special_advance_list() r`, [], { aal: 'aal2' });
    await db.exec(`update public.staff_mfa_config set mode = 'shadow'`);
    expect(r1.err?.message).toBe('NOT_AUTHORIZED');
    expect(r2.err).toBeUndefined();
  });
});

describe('Phase 3 quote (read-only, available while issuance is off)', () => {
  it('returns the server schedule dated from Kampala today, eligibility and the flag, and writes nothing', async () => {
    const before = await count('special_advances');
    const r = await quote(cfo, { borrower: { kind: 'welile_user', user_id: tenant }, terms: TERMS });
    expect(r.err).toBeUndefined();
    const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10); // Africa/Kampala = UTC+3
    expect(r.out).toMatchObject({ issuance_enabled: false, dated_from: today, dated_from_is_planned: false, term_errors: [], eligibility: [], eligible: true });
    expect((r.out!.schedule as { total_repayable: number }).total_repayable).toBe(940_000);
    expect(await count('special_advances')).toBe(before);
  });

  it('dates the schedule from the planned payout date', async () => {
    const r = await quote(cfo, { terms: TERMS, planned_payout_date: '2026-11-02' });
    expect((r.out!.schedule as { schedule: Array<{ due_date: string }> }).schedule.map((s) => s.due_date)).toEqual(['2026-12-02', '2027-01-01', '2027-01-31']);
    expect(r.out!.eligible).toBe(false); // no borrower given
  });

  it('reports invalid terms and borrower fields instead of guessing', async () => {
    const r = await quote(cfo, { borrower: { kind: 'external', borrower_type: 'individual', full_name: 'J', phone: '12' },
      terms: { ...TERMS, rate_percent: 30 } });
    expect(r.out!.term_errors).toEqual(['rate']);
    expect(r.out!.borrower_errors).toEqual(['full_name', 'phone', 'national_id']);
    expect(r.out!.schedule).toBeNull();
  });
});

describe('Phase 3 create', () => {
  it('is refused while issuance is switched off, storing nothing', async () => {
    const r = await create(cfo, request());
    expect(r.err?.message).toBe('SPECIAL_ADVANCES_DISABLED');
    expect(await count('special_advances')).toBe(0);
  });

  it('requires the CFO to confirm the server total (refuses a stale or missing total)', async () => {
    await setFlag(true);
    for (const t of [undefined, 939_999, '940000.5']) {
      const r = await create(cfo, request({ expected_total_repayable: t }));
      expect(r.err?.message).toBe('QUOTE_CHANGED');
      expect(JSON.parse(r.err!.detail!)).toEqual({ total_repayable: 940_000 });
    }
    expect(await count('special_advances')).toBe(0);
  });

  it('records a pending agreement with server-calculated figures, ignoring any figures sent by the browser', async () => {
    const r = await create(cfo, request({ terms: { ...TERMS, access_fee: 1, total_repayable: 2 }, access_fee: 1 }));
    expect(r.err).toBeUndefined();
    expect(r.out).toMatchObject({ status: 'pending_approval', reference: 'SA-000001', principal: 500_000, access_fee: 420_000,
      registration_fee: 20_000, total_repayable: 940_000, instalments: 3, replayed: false, borrower_name: 'Tenant Borrower' });
    expect(r.out!.schedule.map((s) => [s.number, s.due_offset_days, s.due_date, s.amount])).toEqual([[1, 30, null, 313_334], [2, 60, null, 313_334], [3, 90, null, 313_332]]);
    expect(r.out!.events.map((e) => [e.event_type, e.actor_id])).toEqual([['created', cfo]]);
    expect(await count('general_ledger')).toBe(2);
    await decide(cfo, 'reject', r.out!, 'Test record, not needed');
  });

  it('validates every field and reports them together', async () => {
    const r = await create(cfo, request({ purpose: 'short', planned_payout_date: '2020-01-01', borrower: { kind: 'x' }, terms: { ...TERMS, term_days: 120 } }));
    expect(r.err?.message).toBe('SPECIAL_ADVANCE_INVALID_REQUEST');
    expect(detail(r.err).sort()).toEqual(['borrower', 'planned_payout_date', 'purpose', 'term'].sort());
    expect((await create(cfo, request({ idempotency_key: 'short' }))).err?.message).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('is idempotent: the same key and request returns the same advance; a different request with that key is refused', async () => {
    const req = request({ borrower: { kind: 'welile_user', user_id: agent } });
    const first = await create(cfo, req);
    const again = await create(cfo, req);
    expect(again.out).toMatchObject({ id: first.out!.id, reference: first.out!.reference, replayed: true });
    expect(await q(`select count(*)::int n from public.special_advances where borrower_user_id = $1`, [agent])).toEqual([{ n: 1 }]);
    expect((await create(cfo, { ...req, terms: { ...TERMS, principal: 600_000 } })).err?.message).toBe('IDEMPOTENCY_CONFLICT');
    expect((await create(cfo2, req)).err?.message).toBe('IDEMPOTENCY_CONFLICT'); // another CFO cannot reuse it either
    await decide(cfo, 'reject', first.out!, 'Idempotency test record');
  });

  it('the same key cannot be reused after a rejection to slip a second agreement in', async () => {
    const req = request({ borrower: { kind: 'welile_user', user_id: agent } });
    const a = (await create(cfo, req)).out!;
    await decide(cfo, 'reject', a, 'Rejected for the test');
    const replay = await create(cfo, req);
    expect(replay.out).toMatchObject({ id: a.id, status: 'rejected', replayed: true });
  });
});

describe('Phase 3 eligibility (Welile borrowers)', () => {
  const blocked = async (user: string) => {
    const r = await create(cfo, request({ borrower: { kind: 'welile_user', user_id: user } }));
    return r.err?.message === 'BORROWER_NOT_ELIGIBLE' ? detail(r.err) : r.err ? [r.err.message] : (await decide(cfo, 'cancel', r.out!, 'Eligibility test record'), []);
  };

  it('blocks a deleted account, an account with no enabled role and an unknown account', async () => {
    expect(await blocked(deleted)).toEqual(['ACCOUNT_DELETED']);
    expect(await blocked(roleless)).toEqual(['NO_ENABLED_ROLE']);
    const ghost = uuid();
    expect(await blocked(ghost)).toEqual(['UNKNOWN_ACCOUNT']);
  });

  it('blocks an overdue agent advance or a defaulted business advance with a balance, and nothing else', async () => {
    const a1 = (await q<{ id: string }>(`insert into public.agent_advances (agent_id, status, outstanding_balance) values ($1, 'active', 50000) returning id`, [agent]))[0].id;
    expect(await blocked(agent)).toEqual([]); // an active, not overdue, advance does not block
    await q(`update public.agent_advances set status = 'overdue' where id = $1`, [a1]);
    expect(await blocked(agent)).toEqual(['OVERDUE_AGENT_ADVANCE']);
    await q(`update public.agent_advances set outstanding_balance = 0 where id = $1`, [a1]);
    expect(await blocked(agent)).toEqual([]); // overdue but fully repaid
    await q(`insert into public.business_advances (tenant_id, status, outstanding_balance) values ($1, 'defaulted', 1000)`, [bizTenant]);
    expect(await blocked(bizTenant)).toEqual(['DEFAULTED_BUSINESS_ADVANCE']);
  });

  it('one open Special Advance per borrower: a second is refused until the first is rejected or cancelled', async () => {
    const first = (await create(cfo, request())).out!;
    expect(await blocked(tenant)).toEqual(['OPEN_SPECIAL_ADVANCE']);
    await decide(cfo, 'cancel', first, 'Superseded by a new agreement');
    expect(await blocked(tenant)).toEqual([]);
  });

  it('database backstop: even a direct write cannot give one account two open Special Advances', async () => {
    const a = (await create(cfo, request())).out!;
    const e = await db.query(`insert into public.special_advances (reference, borrower_kind, borrower_user_id, principal, rate_percent, rate_basis,
      term_days, frequency, access_fee, registration_fee, total_repayable, instalments, instalment_amount, calc_version, purpose, idempotency_key, created_by)
      select 'SA-999999', borrower_kind, borrower_user_id, principal, rate_percent, rate_basis, term_days, frequency, access_fee, registration_fee,
             total_repayable, instalments, instalment_amount, calc_version, purpose, 'backstop-key-1234567', created_by
        from public.special_advances where id = $1`, [a.id]).catch((x: Err) => x);
    expect((e as Err).code).toBe('23505');
    await decide(cfo, 'cancel', a, 'Backstop test record');
  });

  it('a CFO cannot record or approve a Special Advance to themselves (safety default)', async () => {
    expect((await create(cfo, request({ borrower: { kind: 'welile_user', user_id: cfo } }))).err?.message).toBe('SELF_ADVANCE');
    const a = (await create(cfo2, request({ borrower: { kind: 'welile_user', user_id: cfo } }))).out!;
    expect((await decide(cfo, 'approve', a)).err?.message).toBe('SELF_ADVANCE');
    // (the CFO also has this advance open at the moment, so the quote reports both)
    expect((await quote(cfo, { borrower: { kind: 'welile_user', user_id: cfo }, terms: TERMS })).out!.eligibility).toEqual(['OPEN_SPECIAL_ADVANCE', 'SELF_ADVANCE']);
    await decide(cfo2, 'cancel', a, 'Self advance test record');
  });
});

describe('Phase 3 external borrowers', () => {
  const ext = (over: Record<string, unknown>) => ({ kind: 'external', borrower_type: 'individual', full_name: 'John Mukasa', phone: '0772 123 456', national_id: 'cm900000000000', ...over });

  it('an individual needs a NIN and an entity a registration number', async () => {
    expect(detail((await create(cfo, request({ borrower: ext({ national_id: null }) }))).err)).toEqual(['national_id']);
    expect(detail((await create(cfo, request({ borrower: ext({ borrower_type: 'entity', full_name: 'Acme Ltd', national_id: null }) }))).err)).toEqual(['registration_number']);
    expect((await db.query(`insert into public.special_advance_external_borrowers (borrower_type, full_name, phone, created_by)
      values ('individual', 'No Id', '256772000000', $1)`, [cfo]).catch((x: Err) => x) as Err).message).toMatch(/special_advance_external_borrowers_identity/);
  });

  it('records an external individual (NIN normalised) and blocks a second open advance for the same phone or NIN', async () => {
    const a = (await create(cfo, request({ borrower: ext({}) }))).out!;
    expect(a).toMatchObject({ status: 'pending_approval', borrower_name: 'John Mukasa' });
    expect((await q(`select national_id from public.special_advance_external_borrowers where full_name = 'John Mukasa'`))[0]).toEqual({ national_id: 'CM900000000000' });
    expect(detail((await create(cfo, request({ borrower: ext({ phone: '+256772123456', national_id: 'CM111111111111' }) }))).err)).toEqual(['OPEN_SPECIAL_ADVANCE']);
    expect(detail((await create(cfo, request({ borrower: ext({ phone: '0700000001' }) }))).err)).toEqual(['OPEN_SPECIAL_ADVANCE']);
    await decide(cfo, 'cancel', a, 'External borrower test record');
    expect((await create(cfo, request({ borrower: ext({}) }))).err).toBeUndefined();
  });

  it('records an external entity with its registration number', async () => {
    const a = await create(cfo, request({ borrower: ext({ borrower_type: 'entity', full_name: 'Acme Supplies Ltd', national_id: null, registration_number: '80020001234567', phone: '0701000000' }) }));
    expect(a.out).toMatchObject({ status: 'pending_approval', borrower_name: 'Acme Supplies Ltd' });
  });
});

describe('Phase 3 approve, reject, cancel', () => {
  let n = 0;
  const fresh = async () => {
    const user = uuid();
    await db.query(`insert into auth.users values ($1)`, [user]);
    await db.query(`insert into public.profiles (id, full_name) values ($1, $2)`, [user, `Borrower ${++n}`]);
    await db.query(`insert into public.user_roles (user_id, role) values ($1, 'tenant')`, [user]);
    return { user, a: (await create(cfo, request({ borrower: { kind: 'welile_user', user_id: user } }))).out! };
  };

  it('the CFO may approve an advance they recorded; approval moves no money and sets no due dates', async () => {
    const { a } = await fresh();
    const r = await decide(cfo, 'approve', a, 'Agreed terms confirmed with borrower');
    expect(r.out).toMatchObject({ status: 'approved', approved_by: cfo });
    expect(r.out!.events.map((e) => e.event_type)).toEqual(['created', 'approved']);
    expect(r.out!.schedule.every((s) => s.due_date === null)).toBe(true);
    expect(await count('general_ledger')).toBe(2);
  });

  it('another enabled CFO may approve too', async () => {
    const { a } = await fresh();
    expect((await decide(cfo2, 'approve', a)).out).toMatchObject({ status: 'approved', approved_by: cfo2 });
  });

  it('approval needs issuance switched on, the current version, a pending advance and a still-eligible borrower', async () => {
    const { user, a } = await fresh();
    await setFlag(false);
    expect((await decide(cfo, 'approve', a)).err?.message).toBe('SPECIAL_ADVANCES_DISABLED');
    await setFlag(true);
    expect((await decide(cfo, 'approve', { ...a, updated_at: '2000-01-01T00:00:00Z' })).err?.message).toBe('STALE_VERSION');
    await q(`insert into public.agent_advances (agent_id, status, outstanding_balance) values ($1, 'overdue', 10)`, [user]);
    const blocked = await decide(cfo, 'approve', a);
    expect(blocked.err?.message).toBe('BORROWER_NOT_ELIGIBLE');
    expect(detail(blocked.err)).toEqual(['OVERDUE_AGENT_ADVANCE']);
    expect((await get(a.id)).status).toBe('pending_approval');
  });

  it('rejection needs a reason and only applies to pending advances', async () => {
    const { a } = await fresh();
    expect((await decide(cfo, 'reject', a, null)).err?.message).toBe('REASON_REQUIRED');
    expect((await decide(cfo, 'reject', a, 'no')).err?.message).toBe('REASON_REQUIRED');
    const r = await decide(cfo, 'reject', a, 'Borrower could not provide documents');
    expect(r.out).toMatchObject({ status: 'rejected', decision_reason: 'Borrower could not provide documents' });
    expect((await decide(cfo, 'approve', r.out!)).err?.message).toBe('SPECIAL_ADVANCE_NOT_PENDING');
    expect((await decide(cfo, 'reject', r.out!, 'again and again')).err?.message).toBe('SPECIAL_ADVANCE_NOT_PENDING');
  });

  it('cancellation works for pending and approved advances (before payout), needs a reason, and is final', async () => {
    const p = (await fresh()).a;
    expect((await decide(cfo, 'cancel', p, 'Borrower withdrew')).out).toMatchObject({ status: 'cancelled' });
    const ap = (await decide(cfo, 'approve', (await fresh()).a)).out!;
    const c = await decide(cfo, 'cancel', ap, 'Payout no longer needed');
    expect(c.out).toMatchObject({ status: 'cancelled' });
    expect(c.out!.events.map((e) => e.event_type)).toEqual(['created', 'approved', 'cancelled']);
    expect((await decide(cfo, 'cancel', c.out!, 'cancel again')).err?.message).toBe('SPECIAL_ADVANCE_NOT_CANCELLABLE');
  });

  it('get and list return agreements to the CFO', async () => {
    const l = (await call<{ total_count: number; issuance_enabled: boolean; items: Array<{ status: string }> }>(cfo, `select public.special_advance_list('approved') r`)).out!;
    expect(l.issuance_enabled).toBe(true);
    expect(l.total_count).toBeGreaterThan(0);
    expect(l.items.every((i) => i.status === 'approved')).toBe(true);
    expect((await call(cfo, `select public.special_advance_get($1) r`, [uuid()])).err?.message).toBe('SPECIAL_ADVANCE_NOT_FOUND');
  });
});

describe('Phase 3 leaves existing products alone and rolls back cleanly', () => {
  it('existing agent and business advance rows are only read, never changed', async () => {
    const snap = async () => JSON.stringify(await q(`select * from public.agent_advances order by id`)) + JSON.stringify(await q(`select * from public.business_advances order by id`));
    const before = await snap();
    await quote(cfo, { borrower: { kind: 'welile_user', user_id: agent }, terms: TERMS });
    await create(cfo, request({ borrower: { kind: 'welile_user', user_id: agent } }));
    expect(await snap()).toBe(before);
    expect(await count('general_ledger')).toBe(2);
  });

  it('rollback removes the functions and keeps every agreement; the migration re-applies', async () => {
    const agreements = await count('special_advances');
    const evts = await count('special_advance_events');
    await db.exec(`BEGIN;\n${FUNCTIONS_RB}\nCOMMIT;`);
    expect(await q(`select count(*)::int n from pg_proc where proname like 'special\\_advance\\_%' and proname <> 'special_advance_cfo_ok'`)).toEqual([{ n: 0 }]);
    expect([await count('special_advances'), await count('special_advance_events')]).toEqual([agreements, evts]);
    await db.exec(`BEGIN;\n${FUNCTIONS}\nCOMMIT;`);
    expect((await call(cfo, `select public.special_advance_list() r`)).err).toBeUndefined();
  });
});
