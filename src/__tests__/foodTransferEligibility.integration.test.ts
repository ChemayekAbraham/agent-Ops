import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  endPoolBounded, openGate, requireOrSkip, requirePrerequisite, beginAs, expectRaise,
  unwindSessions, assertCleanupSucceeded,
  ensureIdentity, ensureCoordinatorSeat, IDS, RUN_ID, type Gate, type Conn,
} from './foodDbTestGate';

/**
 * R4 - food_transfer_coordinator must reject ineligible recipients.
 *
 * Before the fix the only check was that a profiles row existed, so a
 * coordinator calling the RPC directly could hand the role to a tenant, a
 * landlord, a disabled account or a soft-deleted one. M3's picker applied
 * role/enabled/deleted_at, but a picker feeds the UI; it is not an
 * enforcement point. The fix applies the same three predicates server-side.
 *
 * ENUM PREREQUISITE. 'employee' is absent from the app_role enum that
 * supabase/migrations/ can build: the repo has nine ALTER TYPE ... ADD VALUE
 * statements and none adds it, though production is reported to have it. The
 * preflight below checks for the value and fails with a precise message
 * rather than letting 'employee'::public.app_role raise 22P02 mid-test and
 * look like a defect in the code under test. Adding the value to a disposable
 * database is a test-environment accommodation; it proves nothing about
 * production and does not fix the repository's migration gap.
 *
 * ISOLATION: every test runs in one transaction and rolls back. Expected
 * raises are savepoint-bracketed so the assertions that follow them can run.
 */

let gate: Gate;
let enumOk = false;

beforeAll(async () => {
  gate = await openGate();
  if (!gate.canRun) return;
  const [{ present }] = await gate.sql!<{ present: boolean }[]>`
    select exists (
      select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'app_role' and e.enumlabel = 'employee') as present`;
  enumOk = present;
  if (!enumOk) return;

  await ensureIdentity(gate.sql!, IDS.COORD, 'COORDINATOR');
  await ensureIdentity(gate.sql!, IDS.EMP_OK, 'R4 ELIGIBLE');
  await ensureIdentity(gate.sql!, IDS.EMP_OFF, 'R4 DISABLED');
  await ensureIdentity(gate.sql!, IDS.EMP_GONE, 'R4 DELETED');
  await ensureIdentity(gate.sql!, IDS.NOT_EMP, 'R4 TENANT');
  // COORD must hold the single active seat, or every call raises 42501 and the
  // rejection assertions would match the wrong error.
  await ensureCoordinatorSeat(gate.sql!, IDS.COORD);
// Explicit: vitest's default hookTimeout is 10s and this hook makes many round
// trips. A hook timeout here leaves `gate` unassigned, so every test in the file
// then fails for a reason unrelated to the code under test.
}, 30_000);

afterAll(async () => {
  // R4 creates no committed orders, so there is nothing for cancelRunOrders to
  // do - but the session failures unwindSessions recorded must still surface,
  // which is the H1 defect this hook previously had. 30s outer budget matches
  // the other two suites; only the bounded shutdown runs here.
  const failures: string[] = [];
  if (gate?.sql) {
    try {
      failures.push(...await endPoolBounded(gate.sql, 5));
    } catch (e) {
      failures.push(`pool shutdown: ${(e as Error)?.message ?? String(e)}`);
    }
  }
  assertCleanupSucceeded(failures, RUN_ID);
}, 30_000);

/**
 * Fails closed on the enum too: a missing value must not read as a pass.
 *
 * Routed through the shared requirePrerequisite so this check honours BOTH
 * fail-closed signals. It previously tested only FOOD_DB_TESTS_REQUIRED, so a
 * missing `employee` value would have skipped - and reported green - in the
 * half-configured case (RACE_TEST_ISOLATED_DB=1 with PGHOST, config flag not
 * propagated) that the second signal exists to catch. That mattered more here
 * than anywhere else, because this is the one prerequisite already known to be
 * absent from the repository's migration chain.
 */
function ready(ctx: { skip: () => void }): boolean {
  if (!requireOrSkip(gate, () => ctx.skip())) return false;
  return requirePrerequisite(
    enumOk,
    "app_role has no 'employee' value, so R4 cannot be tested against this database",
    () => ctx.skip(),
  );
}

/** Role state, in the caller's transaction, rolled back with it. The profiles
 *  rows themselves are reusable fixtures created in beforeAll. */
async function seedRoles(c: Conn) {
  await c`update public.profiles set deleted_at = null
           where id in (${IDS.EMP_OK}, ${IDS.EMP_OFF}, ${IDS.NOT_EMP})`;
  await c`update public.profiles set deleted_at = now() where id = ${IDS.EMP_GONE}`;
  await c`insert into public.user_roles (user_id, role, enabled)
          values (${IDS.EMP_OK},   'employee'::public.app_role, true),
                 (${IDS.EMP_OFF},  'employee'::public.app_role, false),
                 (${IDS.EMP_GONE}, 'employee'::public.app_role, true),
                 (${IDS.NOT_EMP},  'tenant'::public.app_role,   true)
          on conflict (user_id, role) do update set enabled = excluded.enabled`;
  // The tenant must not also hold an enabled employee role from an earlier run.
  await c`delete from public.user_roles
           where user_id = ${IDS.NOT_EMP} and role = 'employee'::public.app_role`;
}

async function activeHolder(c: Conn): Promise<string | null> {
  const rows = await c<{ coordinator_id: string }[]>`
    select coordinator_id from public.food_coordinator_assignments
     where revoked_at is null and access_level = 'active'`;
  return rows.length === 1 ? rows[0].coordinator_id : null;
}

async function activeCount(c: Conn): Promise<number> {
  const [{ n }] = await c<{ n: number }[]>`
    select count(*)::int as n from public.food_coordinator_assignments
     where revoked_at is null and access_level = 'active'`;
  return n;
}

const REASON = 'R4 integration test handover reason';

describe('R4 - coordinator transfer eligibility', () => {
  const rejects = (label: string, target: () => string) => {
    it(`rejects ${label} and leaves the assignment unchanged`, async (ctx) => {
      if (!ready(ctx)) return;
      const c = await gate.sql!.reserve();
      try {
        await beginAs(c, IDS.COORD);
        await seedRoles(c);
        expect(await activeHolder(c)).toBe(IDS.COORD);

        const msg = await expectRaise(c, () =>
          c`select public.food_transfer_coordinator(${target()}, 'full_transfer', ${REASON})`);
        expect(msg).toMatch(/not an eligible employee account/i);

        // Persisted state, not the message. Reachable because expectRaise
        // rolled back to its savepoint rather than leaving the tx aborted.
        expect(await activeHolder(c)).toBe(IDS.COORD);
        expect(await activeCount(c)).toBe(1);
      } finally { await unwindSessions([{ conn: c }]); }
    });
  };

  rejects('a missing profile', () => IDS.NO_PROFILE);
  rejects('a profile without the employee role', () => IDS.NOT_EMP);
  rejects('an employee whose role assignment is disabled', () => IDS.EMP_OFF);
  rejects('a soft-deleted employee profile', () => IDS.EMP_GONE);

  it('accepts an eligible employee and preserves exactly one active assignment', async (ctx) => {
    if (!ready(ctx)) return;
    const c = await gate.sql!.reserve();
    try {
      await beginAs(c, IDS.COORD);
      await seedRoles(c);
      expect(await activeHolder(c)).toBe(IDS.COORD);

      await c`select public.food_transfer_coordinator(${IDS.EMP_OK}, 'full_transfer', ${REASON})`;

      expect(await activeHolder(c)).toBe(IDS.EMP_OK);
      expect(await activeCount(c)).toBe(1);     // the one-active invariant holds

      const [{ n }] = await c<{ n: number }[]>`
        select count(*)::int as n from public.food_coordinator_assignments
         where coordinator_id = ${IDS.COORD} and revoked_at is not null`;
      expect(n).toBeGreaterThanOrEqual(1);      // outgoing holder retired, not deleted
    } finally { await unwindSessions([{ conn: c }]); }
  });

  it('transfer_with_backup leaves the outgoing holder as backup, still one active', async (ctx) => {
    if (!ready(ctx)) return;
    const c = await gate.sql!.reserve();
    try {
      await beginAs(c, IDS.COORD);
      await seedRoles(c);

      await c`select public.food_transfer_coordinator(${IDS.EMP_OK}, 'transfer_with_backup', ${REASON})`;

      expect(await activeHolder(c)).toBe(IDS.EMP_OK);
      expect(await activeCount(c)).toBe(1);
      const [{ n }] = await c<{ n: number }[]>`
        select count(*)::int as n from public.food_coordinator_assignments
         where coordinator_id = ${IDS.COORD} and revoked_at is null and access_level = 'backup'`;
      expect(n).toBe(1);
    } finally { await unwindSessions([{ conn: c }]); }
  });
});
