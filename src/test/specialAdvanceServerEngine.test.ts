// @vitest-environment node
/**
 * Special Advances calculation engine (Phase 1): the SQL functions in
 * supabase/migrations/20261027230000_special_advances_calc_engine.sql, run in an embedded Postgres (PGlite).
 *
 * The server engine is the authority; the browser preview (src/lib/specialAdvancePreview.ts) must agree with it
 * exactly. Both are checked against the same hand-calculated cases (fixtures/specialAdvanceGolden.json), and against
 * each other on thousands of random agreements.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import golden from './fixtures/specialAdvanceGolden.json';
import {
  SPECIAL_ADVANCE_FREQUENCIES, previewSpecialAdvance, validateSpecialAdvanceInput, type SpecialAdvanceInput,
} from '@/lib/specialAdvancePreview';

const MIGRATION = readFileSync(resolve(__dirname, '../../supabase/migrations/20261027230000_special_advances_calc_engine.sql'), 'utf8')
  .replace(/\r/g, '');

type In = { principal: number | null; ratePercent: number | null; rateBasis: string | null; termDays: number | null; frequency: string | null; start: string | null };
interface Row { number: number; due_date: string; amount: number; access_fee: number; registration_fee: number; principal: number; balance_after: number }
interface Sched {
  principal: number; rate_percent: number; rate_basis: string; term_days: number; frequency: string; start_date: string;
  access_fee: number; registration_fee: number; total_repayable: number; instalments: number; instalment_amount: number;
  final_instalment_amount: number; first_due_date: string; final_due_date: string; calc_version: string; schedule: Row[];
}

// SQL error field names -> the preview's error codes
const FIELD: Record<string, string> = { principal: 'principal', rate: 'rate', rate_basis: 'rateBasis', term: 'term', frequency: 'frequency', start_date: 'startDate' };
const previewErr = (e: string) => (e === 'issueDate' ? 'startDate' : e);

let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const args = (i: In) => [i.principal, i.ratePercent, i.rateBasis, i.termDays, i.frequency, i.start];
const schedule = async (i: In): Promise<Sched> =>
  (await q<{ s: Sched }>(`select public._special_advance_schedule($1, $2, $3, $4, $5, $6::date) s`, args(i)))[0].s;
const termErrors = async (i: In): Promise<string[]> =>
  (await q<{ e: string[] }>(`select public._special_advance_term_errors($1, $2, $3, $4, $5, $6::date) e`, args(i)))[0].e.map((x) => FIELD[x] ?? x);
const errOf = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return e as { code?: string; message: string; detail?: string }; } };

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;`);
  await db.exec(MIGRATION);
}, 60_000);
afterAll(async () => { await db?.close(); });

describe('Special Advances engine — migration', () => {
  it('refuses a second run (preflight) and changes nothing', async () => {
    const e = await errOf(() => db.exec(MIGRATION));
    expect(e?.message).toMatch(/precondition failed/);
  });

  it('is pure: immutable functions that read no tables, and are closed to the browser', async () => {
    const fns = await q<{ name: string; vol: string; src: string; auth: boolean; anon: boolean }>(`
      select p.proname name, p.provolatile vol, p.prosrc src,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') auth, has_function_privilege('anon', p.oid, 'EXECUTE') anon
        from pg_proc p where p.proname like '\\_special\\_advance\\_%' order by 1`);
    expect(fns.map((f) => f.name)).toEqual(['_special_advance_allocate', '_special_advance_schedule', '_special_advance_term_errors']);
    for (const f of fns) {
      expect(f.vol).toBe('i'); // IMMUTABLE: same input, same output, no side effects
      expect(f.auth).toBe(false);
      expect(f.anon).toBe(false);
      expect(f.src).not.toMatch(/\b(from|into|update|delete|insert)\s+public\./i); // reads/writes no table
      expect(f.src).not.toMatch(/general_ledger|wallet|create_ledger_transaction|now\(\)|current_date|clock_timestamp/i);
    }
  });
});

describe('Special Advances engine — hand-calculated cases', () => {
  it.each(golden.valid.map((g) => [g.name, g] as const))('%s', async (_n, g) => {
    const s = await schedule(g.in as In);
    expect([s.access_fee, s.registration_fee, s.total_repayable]).toEqual([g.out.accessFee, g.out.registrationFee, g.out.total]);
    expect([s.instalments, s.instalment_amount, s.final_instalment_amount]).toEqual([g.out.instalments, g.out.instalmentAmount, g.out.final]);
    if ('rows' in g.out && g.out.rows) {
      expect(s.schedule.map((r) => [r.due_date, r.amount, r.access_fee, r.registration_fee, r.principal])).toEqual(g.out.rows);
    }
    // invariants on every schedule
    expect(s.schedule).toHaveLength(s.instalments);
    expect(s.schedule.map((r) => r.number)).toEqual(Array.from({ length: s.instalments }, (_, k) => k + 1));
    const sum = (k: keyof Row) => s.schedule.reduce((a, r) => a + (r[k] as number), 0);
    expect(sum('amount')).toBe(s.total_repayable);
    expect(sum('access_fee')).toBe(s.access_fee);
    expect(sum('registration_fee')).toBe(s.registration_fee);
    expect(sum('principal')).toBe(s.principal);
    expect(s.schedule.at(-1)?.balance_after).toBe(0);
    s.schedule.forEach((r) => {
      expect(Number.isInteger(r.amount) && r.amount > 0).toBe(true);
      expect(r.access_fee + r.registration_fee + r.principal).toBe(r.amount);
    });
    expect(s.first_due_date).toBe(s.schedule[0].due_date);
    expect(s.final_due_date).toBe(s.schedule.at(-1)?.due_date);
    expect(s.calc_version).toBe('sa-calc-1');
  });

  it('the final due date is the payout date plus the term, for every frequency', async () => {
    for (const f of SPECIAL_ADVANCE_FREQUENCIES) {
      for (const d of [1, 7, 10, 14, 29, 30, 31, 60, 89, 90]) {
        const s = await schedule({ principal: 250_000, ratePercent: 15, rateBasis: 'monthly', termDays: d, frequency: f.value, start: '2026-12-31' });
        const end = new Date(Date.UTC(2026, 11, 31 + d)).toISOString().slice(0, 10);
        expect(s.final_due_date).toBe(end);
      }
    }
  });

  it('is deterministic: the same agreement always gives the same schedule', async () => {
    const i = golden.valid[0].in as In;
    expect(JSON.stringify(await schedule(i))).toBe(JSON.stringify(await schedule(i)));
  });
});

describe('Special Advances engine — invalid terms are refused, never assumed', () => {
  it.each(golden.invalid.map((g) => [g.name, g] as const))('%s', async (_n, g) => {
    const i = { ...golden.invalidBase, ...g.in } as In;
    expect((await termErrors(i)).sort()).toEqual([...g.errors].sort());
    const e = await errOf(() => schedule(i));
    expect(e?.code).toBe('22023');
    expect(e?.message).toBe('SPECIAL_ADVANCE_INVALID_TERMS');
    expect((JSON.parse(e?.detail ?? '[]') as string[]).map((x) => FIELD[x]).sort()).toEqual([...g.errors].sort());
  });

  it('accepts every approved preset and the limits themselves', async () => {
    for (const [rate, basis] of [[1, 'daily'], [15, 'monthly'], [28, 'monthly'], [0.01, 'daily'], [0.01, 'monthly']] as const) {
      for (const term of [1, 7, 14, 30, 90]) {
        expect(await termErrors({ principal: 10_000, ratePercent: rate, rateBasis: basis, termDays: term, frequency: 'daily', start: '2026-11-02' })).toEqual([]);
      }
    }
  });
});

describe('Special Advances engine — repayment allocation (late fee -> access fee -> registration fee -> principal)', () => {
  const alloc = async (due: Record<string, number>, amount: number) =>
    (await q<{ a: Record<string, number> }>(`select public._special_advance_allocate($1::jsonb, $2) a`, [JSON.stringify(due), amount]))[0].a;
  const DUE = { late_fee: 100, access_fee: 200, registration_fee: 300, principal: 400 };

  it('pays the oldest-ranking component first', async () => {
    expect(await alloc(DUE, 50)).toEqual({ late_fee: 50, access_fee: 0, registration_fee: 0, principal: 0, excess: 0 });
    expect(await alloc(DUE, 250)).toEqual({ late_fee: 100, access_fee: 150, registration_fee: 0, principal: 0, excess: 0 });
    expect(await alloc(DUE, 700)).toEqual({ late_fee: 100, access_fee: 200, registration_fee: 300, principal: 100, excess: 0 });
    expect(await alloc(DUE, 1000)).toEqual({ late_fee: 100, access_fee: 200, registration_fee: 300, principal: 400, excess: 0 });
  });

  it('reports any overpayment as excess, without applying it anywhere', async () => {
    expect(await alloc(DUE, 1250)).toEqual({ late_fee: 100, access_fee: 200, registration_fee: 300, principal: 400, excess: 250 });
    expect(await alloc({ late_fee: 0, access_fee: 0, registration_fee: 0, principal: 0 }, 5)).toEqual({ late_fee: 0, access_fee: 0, registration_fee: 0, principal: 0, excess: 5 });
  });

  it('refuses non-positive or fractional payments and negative or missing components', async () => {
    for (const [due, amt] of [[DUE, 0], [DUE, -1], [DUE, 10.5], [{ ...DUE, principal: -1 }, 10], [{ late_fee: 0, access_fee: 0, registration_fee: 0 }, 10]] as const) {
      const e = await errOf(() => alloc(due as Record<string, number>, amt));
      expect(e?.code).toBe('22023');
    }
  });
});

describe('Special Advances — browser preview equals the server engine', () => {
  // Small deterministic PRNG, so a failure is reproducible.
  let seed = 20261027;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const ymd = () => new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 1461) * 86_400_000).toISOString().slice(0, 10); // 2026–2029, incl. 2028-02-29

  const toPreview = (i: In): SpecialAdvanceInput => ({
    principal: i.principal as number, ratePercent: i.ratePercent as number, rateBasis: i.rateBasis as never,
    termDays: i.termDays as number, frequency: i.frequency as never, issueYmd: i.start as string,
  });

  it('hand-calculated cases: the preview gives the same figures', () => {
    for (const g of golden.valid) {
      const p = previewSpecialAdvance(toPreview(g.in as In))!;
      expect([p.accessFee, p.registrationFee, p.totalRepayable, p.instalments, p.instalmentAmount, p.finalInstalmentAmount])
        .toEqual([g.out.accessFee, g.out.registrationFee, g.out.total, g.out.instalments, g.out.instalmentAmount, g.out.final]);
    }
  });

  it('3,000 random valid agreements: identical schedules, row for row', async () => {
    for (let k = 0; k < 3000; k++) {
      const basis = pick(['daily', 'monthly'] as const);
      const max = basis === 'daily' ? 100 : 2800; // hundredths of a percent
      const i: In = {
        principal: pick([10_000, 10_100, 199_999, 200_000, 200_001]) + (rnd() < 0.7 ? Math.floor(rnd() * 5_000_000) : 0),
        ratePercent: (1 + Math.floor(rnd() * max)) / 100,
        rateBasis: basis,
        termDays: pick([7, 14, 30]) * (rnd() < 0.5 ? 1 : 0) || 1 + Math.floor(rnd() * 90),
        frequency: pick(['daily', 'weekly', 'monthly']),
        start: ymd(),
      };
      const s = await schedule(i);
      const p = previewSpecialAdvance(toPreview(i));
      expect(p, JSON.stringify(i)).not.toBeNull();
      expect([p!.accessFee, p!.registrationFee, p!.totalRepayable, p!.instalments, p!.instalmentAmount], JSON.stringify(i))
        .toEqual([s.access_fee, s.registration_fee, s.total_repayable, s.instalments, s.instalment_amount]);
      expect(p!.schedule.map((r) => [r.number, r.dueYmd, r.amount, r.accessFee, r.registrationFee, r.principal, r.balanceAfter]), JSON.stringify(i))
        .toEqual(s.schedule.map((r) => [r.number, r.due_date, r.amount, r.access_fee, r.registration_fee, r.principal, r.balance_after]));
    }
  }, 120_000);

  it('random invalid agreements: the preview and the server reject the same fields', async () => {
    const bad = {
      principal: [9_999, 10_000.5, 0, -5, null],
      ratePercent: [0, -1, 1.01, 28.01, 12.345, 100, null],
      rateBasis: ['weekly', '', null],
      termDays: [0, 91, 360, 10.5, -7, null],
      frequency: ['biweekly', 'yearly', null],
      start: [null],
    } as const;
    for (let k = 0; k < 400; k++) {
      const i: In = { ...(golden.invalidBase as In) };
      for (const f of Object.keys(bad) as Array<keyof typeof bad>) if (rnd() < 0.35) (i as Record<string, unknown>)[f] = pick(bad[f]);
      // the daily ceiling depends on the basis, so recompute what a daily 1.01 / monthly 28.01 means for this mix
      const server = (await termErrors(i)).sort();
      const preview = validateSpecialAdvanceInput(toPreview(i)).map(previewErr).sort();
      expect(preview, JSON.stringify(i)).toEqual(server);
    }
  }, 60_000);
});
