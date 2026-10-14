import postgres from 'postgres';

/**
 * Shared gate and fixtures for the Food M1 database integration tests (R2, R3, R4).
 *
 * Follows walletTransferReversalRace.integration.test.ts: real connections,
 * independent sessions, bounded waits, no sleeps.
 *
 * TWO MODES.
 *   Ordinary developer run - no PGHOST, no opt-in. Every suite skips, exactly
 *   as the existing integration tests do. Nothing changes for `npx vitest`.
 *   Verification run - FOOD_DB_TESTS_REQUIRED=1. A closed gate now THROWS.
 *   vitest reports a skipped suite as a passing run, so without this an absent
 *   database produces green output that proves nothing.
 *
 * APPEND-ONLY TABLES, AND WHY CLEANUP LOOKS INCOMPLETE.
 *   M1 puts BEFORE DELETE triggers on food_orders and food_meals, and BEFORE
 *   DELETE OR UPDATE on food_order_events and food_audit. Deleting from any of
 *   them raises. supabase/tests/food_concurrency/99_cleanup.sql already settled
 *   the policy for this feature: do NOT drop, disable or work around those
 *   triggers to tidy up, because that weakens the control the work exists to
 *   protect. Rows created by a run are CANCELLED AND LABELLED, not deleted.
 *   session_replication_role is deliberately NOT used.
 *
 *   So isolation here is, in order of preference:
 *     1. Roll back. Every test that can run in one transaction does, and leaves
 *        nothing at all. That is most of them.
 *     2. For the two race tests that need committed rows so a second session
 *        can see them: reusable fixtures (below) plus cancel-and-label.
 *
 * REUSABLE FIXTURES.
 *   Identities, the service period, meal and menu item are DETERMINISTIC and
 *   created idempotently. They are never deleted, so the residue in a
 *   disposable database is bounded at a handful of rows no matter how many
 *   times the suite runs - rather than growing per run. Everything sits in the
 *   reserved uuid range the food_concurrency suite already claims.
 */

export const MAX_TEST_DB_PROFILES = 1000;
export const RESERVED_UUID_PREFIX = 'f0000000-0000-4000-8000-';
export const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

/**
 * Ownership marker. A row counts as this harness's ONLY if it carries this
 * string. The reserved uuid prefix alone is NOT proof of ownership - the
 * food_concurrency suite uses the same range with its own CONCURRENCY-TEST
 * identities, and a row there belongs to that suite, not this one.
 */
export const FIXTURE_MARK = 'FOOD-M1-FIXTURE';
export const SEAT_REASON = `${FIXTURE_MARK} coordinator seat`;

/**
 * SERIAL EXECUTION IS REQUIRED, AND IS ENFORCED BY THE RUNNER.
 *
 * The coordinator seat, the eight identities and the menu fixtures are global,
 * not run-scoped - the schema permits exactly one active coordinator, so they
 * cannot be. Run the three suites with:
 *
 *     npm run test:food-db
 *
 * which passes --no-file-parallelism for these three files only. Vitest 3.2
 * runs test FILES in parallel by default, so without it all three beforeAll
 * hooks execute concurrently: three ensureIdentity inserts race (two lose on
 * the auth.users primary key) and three seat inserts race (two lose on the
 * partial unique index food_one_active_coordinator). Unrelated suites keep
 * their parallelism - the flag is scoped to this script, not the project
 * config.
 *
 * WHAT THIS DOES NOT COVER. Runner-level serialisation orders files within a
 * SINGLE vitest process. It does nothing about a second, independent process -
 * another developer, a CI job, or a second terminal - pointed at the same
 * database. That overlap is DETECTED but not prevented: ensureCoordinatorSeat
 * refuses a seat it cannot prove it owns and names the holder, so the second
 * run fails fast rather than interleaving. It is not full concurrency safety
 * and is not claimed to be.
 *
 * MINIMAL FUTURE GUARD, deliberately not added here because it needs a
 * database round trip to design and validate: have openGate take a
 * session-scoped pg_try_advisory_lock on a dedicated connection and refuse -
 * not wait - when it is already held. That converts cross-process overlap from
 * detected to prevented.
 */
export const SERIAL_EXECUTION_COMMAND = 'npm run test:food-db';

/** Deterministic, reusable, never deleted. All syntactically valid uuids. */
export const IDS = {
  COORD:      `${RESERVED_UUID_PREFIX}00000000c00d`,
  EMP_A:      `${RESERVED_UUID_PREFIX}0000000000a1`,
  EMP_B:      `${RESERVED_UUID_PREFIX}0000000000b1`,
  EMP_OK:     `${RESERVED_UUID_PREFIX}0000000000e1`,
  EMP_OFF:    `${RESERVED_UUID_PREFIX}0000000000e2`,
  EMP_GONE:   `${RESERVED_UUID_PREFIX}0000000000e3`,
  NOT_EMP:    `${RESERVED_UUID_PREFIX}0000000000d1`,
  NO_PROFILE: `${RESERVED_UUID_PREFIX}0000000000ff`,
} as const;

/** The business date food_place_order compares against (M2: Africa/Kampala).
 *  Never current_date - on a UTC server the two disagree for three hours a day. */
export const KAMPALA_DATE = `(now() at time zone 'Africa/Kampala')::date`;

export type Sql = ReturnType<typeof postgres>;
export type Conn = Awaited<ReturnType<Sql['reserve']>>;

export interface Gate {
  sql: Sql | null;
  canRun: boolean;
  reason: string;
  pgVersion: string;
}

/** Operator assertion that the endpoint is direct or session-mode. */
export const SESSION_MODE_ENV = 'FOOD_DB_SESSION_MODE';

/**
 * Refuses a connection whose mode cannot support what these tests need,
 * WITHOUT connecting to anything. Returns a reason, or null to proceed.
 *
 * WHY A POOLER BREAKS THIS HARNESS. Every race holds two reserved sessions open
 * across several statements and then inspects them through pg_stat_activity. A
 * TRANSACTION-mode pooler (Supavisor on 6543, pgbouncer in transaction mode)
 * hands a different server backend to each transaction, so a reserved
 * connection stops being one backend: BEGIN and the statements after it can
 * land on different servers, pg_backend_pid() stops identifying the session,
 * the barrier watches the wrong backend, and postgres.js's default named
 * prepared statements break outright.
 *
 * WHAT THIS CHECK IS, AND WHAT IT IS NOT. It reads connection METADATA only -
 * the endpoint the driver will dial - and rejects endpoints that are known
 * transaction poolers. It CANNOT prove the converse. Nothing here establishes
 * session pinning, and no runtime probe would either: in particular a stable
 * pg_backend_pid() across two queries proves NOTHING, because an idle
 * transaction pooler will happily hand back the same server connection twice.
 * So this is fail-closed in both directions - a known-bad endpoint is refused
 * outright, and every other endpoint still requires the operator to state
 * explicitly that it is direct or session-mode.
 *
 * NO CREDENTIAL IS READ OR REPORTED. PGUSER, PGPASSWORD and the database name
 * are never touched. Only the port and a coarse host shape are examined, and
 * only the port can appear in a diagnostic.
 */
function connectionModeRefusal(): string | null {
  const host = (process.env.PGHOST ?? '').trim().toLowerCase();
  const port = (process.env.PGPORT ?? '').trim();

  if (port === '6543') {
    return `PGPORT is 6543, the Supavisor TRANSACTION-pooler port. Transaction pooling does not pin ` +
      `a backend to a session, so the reserved connections and the pg_stat_activity barrier these ` +
      `tests depend on cannot work. Use the direct or session-mode endpoint (normally 5432).`;
  }
  if (/\bpgbouncer\b/.test(host) || /pgbouncer=true/i.test(process.env.PGOPTIONS ?? '')) {
    return `the configured endpoint names pgbouncer. In transaction mode the race barrier is ` +
      `meaningless; point the harness at a direct or session-mode endpoint instead.`;
  }
  if (process.env[SESSION_MODE_ENV] !== 'confirmed') {
    return `${SESSION_MODE_ENV} is not 'confirmed'. These tests require a DIRECT or SESSION-mode ` +
      `connection, and nothing the harness can observe proves which mode an endpoint is in, so it ` +
      `must be asserted deliberately. Set ${SESSION_MODE_ENV}=confirmed only after confirming the ` +
      `endpoint${port ? ` (port ${port})` : ''} is not a transaction pooler.`;
  }
  return null;
}

/** The live Welile project (supabase/config.toml). Never a test target. */
export const PRODUCTION_PROJECT_REF = 'wirntoujqoyjobfhyelc';

/**
 * LIVE-SYSTEM PROTECTION. This harness INSERTS into auth.users and profiles and
 * commits orders, so it must never be able to reach a live database.
 *
 *  - Any setting mentioning the production project ref is refused outright,
 *    whatever else is set. There is no override.
 *  - Loopback hosts (a local disposable cluster) are allowed.
 *  - Any other host is refused unless FOOD_DB_ALLOW_HOST names that exact host,
 *    so a remote disposable test project needs a deliberate, per-host opt-in.
 *  - PGHOSTADDR / PGSERVICE / DATABASE_URL could redirect the driver behind
 *    PGHOST's back, so their presence is refused.
 *
 * Checked before any pool exists, so a refused endpoint is never even looked
 * up. Reads environment metadata only; no credential is read or reported.
 */
export function hostRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const host = (env.PGHOST ?? '').trim().toLowerCase();
  const settings = [env.PGHOST, env.PGHOSTADDR, env.PGSERVICE, env.PGDATABASE, env.DATABASE_URL, env.PGUSER]
    .map((v) => (v ?? '').toLowerCase()).join(' ');
  if (settings.includes(PRODUCTION_PROJECT_REF)) {
    return 'the connection settings name the PRODUCTION project; this harness never connects there';
  }
  if (env.PGHOSTADDR || env.PGSERVICE || env.DATABASE_URL) {
    return 'PGHOSTADDR, PGSERVICE or DATABASE_URL is set and could redirect the connection; unset it';
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);
  if (!loopback && (env.FOOD_DB_ALLOW_HOST ?? '').trim().toLowerCase() !== host) {
    return `PGHOST "${host}" is not a local cluster. Point the harness at a disposable local ` +
      `database, or set FOOD_DB_ALLOW_HOST to this exact host for a disposable remote test project`;
  }
  return null;
}

export async function openGate(): Promise<Gate> {
  const fail = (reason: string): Gate => ({ sql: null, canRun: false, reason, pgVersion: '' });

  if (!process.env.PGHOST) return fail('PGHOST is not set');
  if (process.env.RACE_TEST_ISOLATED_DB !== '1') return fail('RACE_TEST_ISOLATED_DB is not 1');
  // Before the pool is created: a refused endpoint is never resolved or dialled.
  const hostProblem = hostRefusal();
  if (hostProblem) return fail(hostProblem);

  // Checked BEFORE the pool is created: this needs no connection, and a
  // transaction-pooler endpoint should never be dialled by this harness at all.
  const modeRefusal = connectionModeRefusal();
  if (modeRefusal) return fail(modeRefusal);

  let sql: Sql;
  try {
    sql = postgres({ max: 4, onnotice: () => {} });
  } catch (e) {
    return fail(`could not create a connection pool: ${(e as Error).message}`);
  }

  try {
    const [{ v }] = await sql<{ v: string }[]>`select version() as v`;

    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.profiles`;
    if (n >= MAX_TEST_DB_PROFILES) {
      await sql.end();
      return fail(`public.profiles has ${n} rows (>= ${MAX_TEST_DB_PROFILES}); refusing to run`);
    }

    const [{ tables }] = await sql<{ tables: number }[]>`
      select count(*)::int as tables from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relkind = 'r'
         and c.relname in ('food_categories','food_meals','food_service_periods',
                           'food_service_closures','food_menu_items','food_orders',
                           'food_order_items','food_order_events','food_exceptions',
                           'food_audit','food_coordinator_assignments')`;
    if (tables !== 11) {
      await sql.end();
      return fail(`expected 11 M1 food tables, found ${tables}`);
    }

    // HEAD's food_place_order has no advisory lock; a race test against that
    // version would pass for entirely the wrong reason.
    const [{ locked }] = await sql<{ locked: boolean }[]>`
      select position('pg_advisory_xact_lock' in
               pg_get_functiondef('public.food_place_order(jsonb,text,text,text)'::regprocedure)) > 0
             as locked`;
    if (!locked) {
      await sql.end();
      return fail('food_place_order has no pg_advisory_xact_lock: the working-tree M2 is not installed');
    }

    // PRIVILEGES, PROBED INDIVIDUALLY so the diagnostic names what is missing.
    //
    // food_cancel_my_order IS THE TEARDOWN MECHANISM and must be probed in its
    // own right. M2 REVOKEs EXECUTE on all 18 food functions from PUBLIC, anon
    // AND authenticated, then grants back only a subset - so permission to call
    // food_place_order does NOT imply permission to call the cancellation RPC.
    // Without this check a run can reserve stock successfully and then fail
    // every cancel at teardown, stranding reservations on the fixture menu
    // items permanently and growing them on each run.
    //
    // ROLE. The two-argument form of has_function_privilege resolves against
    // current_user and reports its EFFECTIVE privileges - the same convention
    // the pre-existing probes use, and the right one here, because it is this
    // connection that will issue the calls. The probe and the calls are
    // guaranteed to be the same role: both come from the one pool, and this
    // harness never issues SET ROLE or SET SESSION AUTHORIZATION. Setting
    // request.jwt.claims impersonates an employee for auth.uid() only; it does
    // not change current_user, and the RPC being SECURITY DEFINER does not
    // either, because EXECUTE is checked against the CALLER.
    //
    // THREE WAYS A PASS CAN ARISE, only one of which is the intended one:
    //   1. current_user was granted EXECUTE directly;
    //   2. current_user INHERITS it through membership in `authenticated`,
    //      which is the role M2 actually grants to - effective privileges
    //      include those reached via role membership, not just direct grants;
    //   3. current_user is a SUPERUSER, which bypasses privilege checks
    //      entirely and passes whatever the grants say.
    //
    // So a pass means "this connection can make these calls". It does NOT
    // prove M2's grants are correct - case 3 would pass against a database
    // with no grants at all.
    //
    // WHICH ROLE THIS IS REMAINS UNKNOWN. It comes from PGUSER at run time and
    // nothing in this repository pins it. Until the operator independently
    // establishes the connecting role, neither a pass nor its interpretation
    // above can be attributed to a specific role.
    const [priv] = await sql<{
      place: boolean; fulfil: boolean; transfer: boolean; cancel: boolean; users: boolean;
    }[]>`
      select has_function_privilege('public.food_place_order(jsonb,text,text,text)', 'execute')         as place,
             has_function_privilege('public.food_set_fulfilment(uuid,text,text)', 'execute')       as fulfil,
             has_function_privilege('public.food_transfer_coordinator(uuid,text,text)', 'execute') as transfer,
             has_function_privilege('public.food_cancel_my_order(uuid,text)', 'execute')           as cancel,
             has_table_privilege('auth.users', 'insert')                                           as users`;
    const missing = ([
      [priv?.place, 'EXECUTE on food_place_order(jsonb,text,text,text)'],
      [priv?.fulfil, 'EXECUTE on food_set_fulfilment(uuid,text,text)'],
      [priv?.transfer, 'EXECUTE on food_transfer_coordinator(uuid,text,text)'],
      [priv?.cancel, 'EXECUTE on food_cancel_my_order(uuid,text) - REQUIRED FOR TEARDOWN'],
      [priv?.users, 'INSERT on auth.users'],
    ] as const).filter(([ok]) => !ok).map(([, name]) => name);
    if (missing.length) {
      await sql.end();
      // Names privileges only. No role name, host, database or credential.
      return fail(`the connected role is missing: ${missing.join('; ')}`);
    }

    return { sql, canRun: true, reason: '', pgVersion: v };
  } catch (e) {
    try { await sql.end(); } catch { /* ignore */ }
    return fail(`precondition check failed: ${(e as Error).message}`);
  }
}

/**
 * Fail-closed. Throws - never silently skips - whenever anyone is actually
 * trying to run these tests.
 *
 * TWO INDEPENDENT SIGNALS, deliberately. A skipped vitest suite reports as a
 * PASS, so the whole value of this file rests on the closed gate producing a
 * non-zero exit. One mechanism for that is not enough, because if it fails to
 * reach this process the failure mode is a false green - the exact outcome
 * being guarded against.
 *
 *  1. FOOD_DB_TESTS_REQUIRED=1, set by vitest.config.food-db.ts, which the
 *     `test:food-db` script loads with --config. This covers the canonical
 *     command being run with nothing else configured at all.
 *
 *  2. RACE_TEST_ISOLATED_DB=1 together with PGHOST. Setting both is an
 *     unambiguous statement of intent to run against a database; from that
 *     point a closed gate is always an error, whatever closed it - an
 *     unconfirmed session mode, a wrong table count, a missing privilege.
 *     This holds even if signal 1 never arrives, and it is the one that
 *     catches a half-configured verification run.
 *
 * Neither signal causes a connection. An ordinary `npx vitest` on a developer
 * machine sets neither, so the suites skip exactly as before.
 */
export function requireOrSkip(gate: Gate, skip: () => void): boolean {
  if (gate.canRun) return true;
  return requirePrerequisite(false, `the Food database preconditions were not met: ${gate.reason}`, skip);
}

/**
 * THE ONE PLACE that decides whether someone is actually trying to run these
 * tests. Both signals live here so a second, subtly different copy cannot
 * drift - which is exactly what happened before: R4's enum check tested only
 * signal 1, so a missing `employee` value would have SKIPPED, and reported
 * green, in precisely the half-configured situation signal 2 exists to catch.
 *
 * Returns the reason intent was inferred, or null when neither signal is set.
 * Reads environment variables only; never connects.
 */
export function dbRunIntent(): string | null {
  if (process.env.FOOD_DB_TESTS_REQUIRED === '1') return 'FOOD_DB_TESTS_REQUIRED=1';
  if (process.env.RACE_TEST_ISOLATED_DB === '1' && !!process.env.PGHOST) {
    return 'RACE_TEST_ISOLATED_DB=1 and PGHOST are both set, so a database run was clearly intended';
  }
  return null;
}

/**
 * Fail-closed for ANY prerequisite, not just the gate itself.
 *
 * `ok` true proceeds. Otherwise: if either signal establishes intent, this
 * THROWS - a missing prerequisite must never read as a pass. With no signal,
 * it skips, preserving the ordinary `npx vitest` developer experience.
 *
 * @param reason stated as "<intent>, but <reason>." - phrase it to read that way.
 */
export function requirePrerequisite(ok: boolean, reason: string, skip: () => void): boolean {
  if (ok) return true;
  const intent = dbRunIntent();
  if (intent) {
    throw new Error(`${intent}, but ${reason}. Refusing to report a skipped suite as a pass.`);
  }
  skip();
  return false;
}

/**
 * Creates one reusable identity. profiles.id is a FK to auth.users(id) and
 * profiles.email is NOT NULL, so a profile cannot be inserted directly; the
 * handle_new_user trigger builds it from auth.users. Same route the existing
 * race test uses, but with a FIXED id so the row is reused rather than
 * accumulated, and never deleted (committed food_orders reference it).
 */
export async function ensureIdentity(sql: Sql, id: string, label: string): Promise<void> {
  const fullName = `${FIXTURE_MARK} ${label}`;
  const email = `food-m1-fixture-${id.slice(-4)}@example.invalid`;

  // OWNERSHIP IS VERIFIED BEFORE ANYTHING IS MODIFIED. An existing row is only
  // reused if it is unmistakably ours; anything else aborts setup rather than
  // being overwritten. ON CONFLICT DO NOTHING would hide a mismatched row, so
  // the check is explicit and comes first.
  const existingUser = await sql<{ email: string }[]>`
    select email from auth.users where id = ${id}`;
  if (existingUser.length && existingUser[0].email !== email) {
    throw new Error(
      `auth.users ${id} already exists with email ${existingUser[0].email}, expected ${email}. ` +
      `This id is not owned by ${FIXTURE_MARK}; refusing to modify it.`,
    );
  }

  const existingProfile = await sql<{ full_name: string }[]>`
    select full_name from public.profiles where id = ${id}`;
  if (existingProfile.length && !existingProfile[0].full_name?.startsWith(FIXTURE_MARK)) {
    throw new Error(
      `public.profiles ${id} exists with full_name "${existingProfile[0].full_name}", which does ` +
      `not carry the ${FIXTURE_MARK} marker; refusing to overwrite it or clear deleted_at.`,
    );
  }

  if (!existingUser.length) {
    await sql`
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${email}, '', now(), ${sql.json({ full_name: fullName, phone: '' })}, now(), now())`;
  }

  // The signup trigger normally creates the profile. Only reached for rows
  // already proven to be ours, so clearing deleted_at here cannot touch an
  // unrelated account.
  await sql`
    insert into public.profiles (id, full_name, phone, email)
    values (${id}, ${fullName}, '', ${email})
    on conflict (id) do update set full_name = excluded.full_name, deleted_at = null`;
}

/** Makes IDS.COORD the single active coordinator. food_coordinator_assignments
 *  carries no append-only trigger, so this is reversible and safe to repeat.
 *  Needed because another fixture (food_concurrency/00_setup.sql) may already
 *  hold the seat, which would make every coordinator RPC raise 42501 and look
 *  like a defect in the code under test. */
export async function ensureCoordinatorSeat(sql: Sql, coordinatorId: string): Promise<void> {
  const held = await sql<{ coordinator_id: string; reason: string | null }[]>`
    select coordinator_id, reason from public.food_coordinator_assignments
     where revoked_at is null and access_level = 'active'`;

  if (held.length > 1) {
    throw new Error(`${held.length} active coordinator assignments exist; the schema permits one. Refusing to proceed.`);
  }

  if (held.length === 1) {
    const incumbent = held[0];
    if (incumbent.coordinator_id === coordinatorId) return;          // already ours

    // NEVER seize a seat we cannot prove we own. The reserved uuid prefix is
    // not sufficient on its own - the food_concurrency suite's coordinator
    // sits in the same range and belongs to that suite. Ownership requires
    // BOTH the reserved range AND this harness's own reason marker. Anything
    // else - a real coordinator, another suite's fixture, or a concurrent run
    // of this suite - stops setup with the holder named.
    const ownedByUs =
      incumbent.coordinator_id.startsWith(RESERVED_UUID_PREFIX) &&
      (incumbent.reason ?? '').startsWith(FIXTURE_MARK);

    if (!ownedByUs) {
      throw new Error(
        `The active Food Coordinator is ${incumbent.coordinator_id} (reason: ${incumbent.reason ?? 'null'}), ` +
        `which is not a ${FIXTURE_MARK} assignment. This database is not a clean fixture target, or another ` +
        `test run holds the seat. Refusing to revoke it. The Food M1 suites must run serially against a ` +
        `dedicated disposable database.`,
      );
    }

    await sql`
      update public.food_coordinator_assignments
         set revoked_at = now(), reason = ${`${FIXTURE_MARK} superseded`}
       where revoked_at is null and access_level = 'active'
         and coordinator_id = ${incumbent.coordinator_id}`;
  }

  await sql`
    insert into public.food_coordinator_assignments (coordinator_id, access_level, assigned_by, reason)
    select ${coordinatorId}, 'active', ${coordinatorId}, ${SEAT_REASON}
     where not exists (select 1 from public.food_coordinator_assignments
                        where revoked_at is null and access_level = 'active')`;

  // Confirm the outcome rather than assuming it.
  const after = await sql<{ coordinator_id: string }[]>`
    select coordinator_id from public.food_coordinator_assignments
     where revoked_at is null and access_level = 'active'`;
  if (after.length !== 1 || after[0].coordinator_id !== coordinatorId) {
    throw new Error(
      `Failed to establish the fixture coordinator seat: expected exactly ${coordinatorId}, ` +
      `found ${after.length} active assignment(s)${after[0] ? ` held by ${after[0].coordinator_id}` : ''}.`,
    );
  }
}

/** Acts as a given user, the way PostgREST would. */
export async function beginAs(c: Conn, actor: string): Promise<void> {
  await c`begin`;
  await c`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor, role: 'authenticated' })}, true)`;
}

/** Bounded contention: a blocked session reports 55P03 instead of hanging. */
export async function setLockTimeout(c: Conn, ms = 1500): Promise<void> {
  await c`select set_config('lock_timeout', ${`${ms}ms`}, true)`;
}

/**
 * Runs something expected to raise, and leaves the transaction USABLE.
 *
 * Without this, PostgreSQL aborts the transaction on the error and every later
 * statement fails with 25P02 - so a test that asserts an error and then checks
 * persisted state would fail on the check rather than the assertion. The
 * savepoint is released on success and rolled back to on failure.
 *
 * Returns the error message. Throws if the call unexpectedly SUCCEEDED, so an
 * absent rejection can never read as a pass.
 */
export async function expectRaise(c: Conn, run: () => Promise<unknown>): Promise<string> {
  return (await expectRaiseDetail(c, run)).message;
}

/** What a raised statement reported: the message and its SQLSTATE. */
export interface RaisedError {
  message: string;
  /** postgres.js copies the server's `C` field onto the error as `code`. */
  code?: string;
}

/**
 * As expectRaise, but also returns the SQLSTATE, so a caller can assert the
 * error CLASS and not just its wording. Added as a sibling rather than by
 * changing expectRaise's return type, because expectRaise is used from the R2
 * and R4 suites and those are out of scope for this change.
 */
export async function expectRaiseDetail(c: Conn, run: () => Promise<unknown>): Promise<RaisedError> {
  const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
  await c.unsafe(`savepoint ${sp}`);
  try {
    await run();
  } catch (e) {
    await c.unsafe(`rollback to savepoint ${sp}`);
    const err = e as Error & { code?: string };
    return { message: err.message, code: err.code };
  }
  await c.unsafe(`release savepoint ${sp}`);
  throw new Error('expected the statement to raise, but it succeeded');
}

/**
 * Teardown for the tests that must commit - all three R3 race tests, and the
 * committed-order fixtures in R2.
 *
 * DELETES NOTHING. An earlier version of this docstring claimed it deleted
 * from food_order_items; it does not, and no DELETE appears anywhere in this
 * function. See the note at the end of the loop: the cancel RPC READS those
 * line items to compute the stock release, so removing them would silently
 * release nothing, and the parent order is append-only and stays regardless.
 *
 * Instead every matched order is CANCELLED AND LABELLED through the production
 * RPC - food_orders, food_order_items, food_order_events, food_meals and
 * food_audit are all append-only by design and are left in place, exactly as
 * 99_cleanup.sql does. Scoped by this run's order_reference or idempotency_key
 * prefix; production references are FO-YYMMDD-XXXXXX and cannot collide.
 * Reusable fixtures are intentionally left for the next run.
 */
/**
 * A single budget shared by every teardown operation.
 *
 * The previous design gave each step its own independent timeout, so the worst
 * case was their SUM - 5s per order plus 5s shutdown - against vitest's 10s
 * hookTimeout. Cleanup could therefore exhaust the hook before the failure
 * report ran, in exactly the situation the bounds were added for. Every step
 * now draws from one deadline and asks what is left.
 */
export interface Deadline {
  readonly atMs: number;
  remaining(): number;
  expired(): boolean;
}

export function startDeadline(budgetMs: number): Deadline {
  const atMs = Date.now() + budgetMs;
  return {
    atMs,
    remaining: () => Math.max(0, atMs - Date.now()),
    expired: () => Date.now() >= atMs,
  };
}

/**
 * Races a promise against the remaining budget.
 *
 * ABANDONMENT IS NOT ACCEPTABLE on its own: a timed-out operation that is still
 * live can keep using the pool or mutate rows after teardown has reported. So
 * every caller supplies `settle`, which runs when the deadline wins and must
 * reclaim whatever it can - releasing a connection that arrives late, and AT
 * MINIMUM attaching handlers to the losing promise.
 *
 * `settle` MUST observe its `late` argument. On the normal path Promise.race
 * already attaches handlers to `work`, but on the early path below - where the
 * budget was gone before the call - the race is never entered and `settle` is
 * the only handler the promise will ever get. Every caller here does so.
 *
 * NO CALLER CANCELS THE QUERY. See runStep: postgres.js's Query.cancel()
 * discards the promise it builds and can itself reject unhandled. The
 * consequence is that a timed-out statement may still be executing in its
 * backend; this function bounds the CLIENT's wait and claims nothing more.
 *
 * Returns the value, or null if the deadline won.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  deadline: Deadline,
  label: string,
  settle: (late: Promise<T>) => void,
  failures: string[],
): Promise<T | null> {
  const left = deadline.remaining();
  if (left <= 0) {
    settle(work);
    // NOT "not attempted" - the statement was already dispatched. Callers build
    // the query before calling this, and postgres.js sends it the moment it is
    // awaited or .then()ed (query.js:148-150 then() -> handle()). What is
    // missing is budget to WAIT for it, not the statement itself. The server
    // may well execute it; the client simply stops waiting and never learns
    // the result.
    failures.push(
      `${label}: the teardown budget was already exhausted, so this statement was issued but ` +
      `abandoned without waiting for it. It may have executed server-side.`);
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<symbol>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), left); });
  try {
    const result = await Promise.race([work, expiry]);
    if (result === TIMED_OUT) {
      settle(work);
      failures.push(`${label}: exceeded the remaining teardown budget (${left}ms) and was settled`);
      return null;
    }
    return result as T;
  } catch (e) {
    failures.push(`${label}: ${(e as Error)?.message ?? String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const TIMED_OUT = Symbol('teardown-deadline');

export interface CleanupScope {
  /** Matches order_reference. Only for orders this harness inserted directly
   *  with a run-tagged reference. NEVER pass a bare 'FO-' - that is the
   *  production reference shape and would match unrelated orders. */
  refPrefix?: string;
  /** Matches idempotency_key. Required for orders created through
   *  food_place_order, which generates a production-shaped FO-YYMMDD-XXXXXX
   *  reference that carries no run tag. */
  keyPrefix?: string;
}

/** A postgres.js query. Thenable; executes when first awaited or .then()ed. */
type DbQuery = Promise<unknown>;

const STEP_OK = Symbol('teardown-step-ok');

/**
 * 'ok'        completed inside the budget.
 * 'failed'    the server answered with an error. The statement is FINISHED and
 *             the connection is responsive, so it is safe to carry on with it.
 * 'abandoned' the deadline won. The statement may STILL BE RUNNING server-side
 *             and nothing here can establish otherwise - see runStep.
 */
type StepOutcome = 'ok' | 'failed' | 'abandoned';

/**
 * Below this, lock_timeout is not worth setting and 0 is actively dangerous:
 * PostgreSQL reads lock_timeout=0 as "wait forever", so a budget rounded down
 * to zero would DISABLE the bound it was meant to impose.
 */
const MIN_LOCK_TIMEOUT_MS = 50;

/**
 * Runs ONE teardown statement under the shared deadline.
 *
 * WHY EVERY STATEMENT NEEDS THIS, not just the slow-looking ones. lock_timeout
 * bounds lock ACQUISITION inside the server; it does nothing about a round trip
 * that never comes back - an unresponsive backend, a black-holed socket, a
 * connection the pool handed over in an unusable state. Any single `await c`...``
 * in the teardown path can therefore hang forever, and because cleanup runs
 * first in afterAll it would take the hook, and assertCleanupSucceeded with it,
 * down before a single recorded failure was ever reported.
 *
 * NO CANCELLATION IS ATTEMPTED, AND NONE IS CLAIMED. An earlier version called
 * `query.cancel()` here. That was removed: postgres.js builds a CancelRequest
 * promise and then discards it with the comma operator (query.js:52-54), and
 * the request is delivered over a BRAND-NEW socket whose error handler rejects
 * that discarded promise (connection.js:145-153). An endpoint that refuses a
 * CancelRequest - which transaction poolers routinely do - therefore produced
 * an unhandled rejection that no surrounding try/catch could catch, failing the
 * whole Vitest run and attributing it to whatever file happened to be running.
 *
 * RESIDUAL LIMITATION, stated plainly: this bounds how long the CLIENT waits.
 * It does not stop the server. A statement whose deadline expired may still be
 * executing in its backend, and this harness has no way to prove it is not.
 * Everything downstream treats such a statement as possibly live.
 *
 * Returns 'ok', 'failed' or 'abandoned'; withDeadline has already recorded the
 * reason for the latter two.
 */
async function runStep(
  make: () => DbQuery,
  deadline: Deadline,
  label: string,
  failures: string[],
): Promise<StepOutcome> {
  let abandoned = false;
  const q = make();
  const outcome = await withDeadline<symbol>(
    q.then(() => STEP_OK),
    deadline,
    label,
    (late) => {
      // settle runs ONLY when the deadline won, so this flag is what separates
      // a statement that may still be in flight from one the server finished
      // with an error.
      abandoned = true;
      // The late outcome is OBSERVED, so it can never surface as an unhandled
      // rejection in the worker. It is also pushed - but honestly: by then
      // cancelRunOrders may already have returned this array by value, in which
      // case nothing reads it again. The entry withDeadline pushed
      // synchronously when the deadline won is what reddens the suite.
      void late.then(
        () => failures.push(`${label}: completed only AFTER its deadline had passed`),
        (e) => failures.push(`${label}: rejected after its deadline: ${(e as Error)?.message ?? String(e)}`),
      );
    },
    failures,
  );
  if (outcome === STEP_OK) return 'ok';
  return abandoned ? 'abandoned' : 'failed';
}

export async function cancelRunOrders(sql: Sql, scope: CleanupScope, deadline: Deadline): Promise<string[]> {
  const failures: string[] = [];
  const refLike = scope.refPrefix ? `${scope.refPrefix}%` : null;
  const keyLike = scope.keyPrefix ? `${scope.keyPrefix}%` : null;

  if (!refLike && !keyLike) throw new Error('cancelRunOrders requires a run-scoped prefix');
  for (const p of [scope.refPrefix, scope.keyPrefix]) {
    // A short or empty prefix would widen the scope to unrelated orders.
    if (p !== undefined && p.length < 8) {
      throw new Error(`cleanup scope "${p}" is too broad; a run-tagged prefix is required`);
    }
  }

  // DISCOVERY runs on the POOL, outside any transaction, so the
  // transaction-local lock_timeout set below does NOT bound it. It takes no
  // row locks, but it is still unbounded against pool starvation, so the
  // shared deadline bounds it. That bound is CLIENT-SIDE ONLY: if it expires,
  // this statement may still be running in its backend and the settle callback
  // only observes its eventual outcome. No cancellation is attempted - see
  // runStep for why query.cancel() was removed.
  const discovery = sql<{ id: string; employee_id: string; order_reference: string; fulfilment_status: string }[]>`
    select id, employee_id, order_reference, fulfilment_status
      from public.food_orders
     where fulfilment_status <> 'cancelled'
       and ((${refLike}::text is not null and order_reference like ${refLike})
         or (${keyLike}::text is not null and idempotency_key like ${keyLike}))`;
  const open = await withDeadline(
    discovery, deadline, 'cleanup discovery',
    (late) => {
      // No cancel is issued - see runStep for why that call was removed and
      // what it does NOT guarantee. Attaching handlers is still essential: on
      // the already-expired path Promise.race is never reached, so this is the
      // ONLY thing standing between a late rejection and an unhandled one.
      void late.then(
        () => failures.push('cleanup discovery: completed only AFTER its deadline had passed'),
        (e) => failures.push(`cleanup discovery: rejected after its deadline: ${(e as Error)?.message ?? String(e)}`),
      );
    },
    failures,
  );
  if (!open) return failures;          // budget gone, or the query rejected

  /** Set when a connection was released without a confirmed rollback. See the
   *  finally block below: the loop stops rather than reuse the pool. */
  let suspect = '';

  for (const o of open) {
    if (suspect) {
      failures.push(
        `cleanup stopped after ${suspect} could not be rolled back cleanly. ` +
        `${open.length - open.indexOf(o)} order(s) were left uncancelled, starting at ` +
        `${o.order_reference}; their reservations remain outstanding.`);
      break;
    }
    if (deadline.expired()) {
      failures.push(
        `teardown budget exhausted with ${open.length - open.indexOf(o)} order(s) uncancelled, ` +
        `starting at ${o.order_reference}. Their reservations remain outstanding.`);
      break;
    }
    if (o.fulfilment_status !== 'confirmed') {
      // food_cancel_my_order only accepts 'confirmed'. Anything else is a
      // state this harness does not create; surface it instead of forcing it.
      failures.push(
        `${o.order_reference} is '${o.fulfilment_status}', which the employee cancel RPC refuses. ` +
        `Left as-is: forcing it would require bypassing the stock-release logic.`);
      continue;
    }
    // reserve() queues with NO bound when every connection is held
    // (postgres.js index.js:205-211) - the pool-starvation path that could
    // hang the hook before shutdown was ever reached. If the deadline wins,
    // the late arrival is released rather than leaked, so an abandoned
    // reservation cannot hold a connection or run after teardown reports.
    const c = await withDeadline(
      sql.reserve(), deadline, `${o.order_reference} reserve`,
      (late) => { void late.then((conn) => conn.release()).catch(() => {}); },
      failures,
    );
    if (!c) continue;
    // Tracks whether a transaction may still be open on this connection, so
    // the finally below knows whether a rollback is owed. Set the moment BEGIN
    // is issued and cleared only by a confirmed COMMIT - a COMMIT that timed
    // out client-side leaves this true, because we cannot know it landed.
    let mayBeOpen = false;
    // Set by ANY step whose deadline expired, not just the rollback. Such a
    // statement may still be executing in the backend, and this connection is
    // about to go back into a pool of four.
    let abandonedHere = false;
    const step = async (make: () => DbQuery, what: string): Promise<boolean> => {
      const outcome = await runStep(make, deadline, `${o.order_reference}: ${what}`, failures);
      if (outcome === 'abandoned') abandonedHere = true;
      return outcome === 'ok';
    };
    try {
      // Cancel through the PRODUCTION path, as the owning employee. The RPC
      // decrements servings_reserved and sets stock_released in one
      // transaction under SELECT ... FOR UPDATE, guarded by the pre-read
      // stock_released - so the release happens exactly once and the flag can
      // never be set without it. Committed deliberately; the row is
      // append-only and remains, cancelled and labelled.
      //
      // EVERY STEP BELOW IS BOUNDED BY THE SHARED DEADLINE. Previously all six
      // round trips were bare awaits: lock_timeout bounded the RPC's lock wait
      // inside the server, but nothing bounded the round trips themselves, so
      // one unresponsive backend hung the hook and discarded the whole report.
      // Each step now draws from the same budget and aborts this order on
      // failure rather than continuing against a connection in an unknown state.

      // DEFENSIVE ROLLBACK FIRST. A connection returned to the pool mid
      // transaction would make the BEGIN below a no-op warning, and the COMMIT
      // at the end would then commit whatever an abandoned test left open.
      // ROLLBACK when idle is only a warning (discarded by onnotice), so this
      // is safe to issue unconditionally - but if it FAILS or times out the
      // connection is not in a known state and this order is skipped.
      if (!await step(() => c`rollback`, 'defensive rollback')) {
        failures.push(`${o.order_reference}: skipped; the connection could not be returned to a known state`);
        continue;
      }

      // BOUNDS THE CLEANUP RPC'S LOCK WAIT, inside the server. is_local = true
      // scopes it to THIS transaction: it reverts on commit or rollback and
      // never touches the session or any other connection's configuration.
      //
      // Drawn from the SHARED budget, capped at 1500ms to match
      // setLockTimeout's default, and NEVER raised by a floor - a floor above
      // the remaining budget is exactly how N stuck orders used to sum past
      // the hook deadline. Computed BEFORE begin, so an exhausted budget costs
      // nothing and leaves no transaction open.
      const lockMs = Math.min(1500, deadline.remaining());
      if (lockMs < MIN_LOCK_TIMEOUT_MS) {
        failures.push(
          `teardown budget exhausted (${deadline.remaining()}ms left) before ${o.order_reference} ` +
          `could be cancelled. Its reservation remains outstanding.`);
        break;
      }

      if (!await step(() => c`begin`, 'begin')) continue;
      mayBeOpen = true;

      if (!await step(() => c`select set_config('lock_timeout', ${`${lockMs}ms`}, true)`, 'set lock_timeout')) continue;
      if (!await step(() => c`select set_config('request.jwt.claims',
                ${JSON.stringify({ sub: o.employee_id, role: 'authenticated' })}, true)`, 'set jwt claims')) continue;
      if (!await step(() => c`select public.food_cancel_my_order(${o.id}, ${`${FIXTURE_MARK} teardown`})`, 'cancel rpc')) continue;
      if (!await step(() => c`commit`, 'commit')) continue;
      mayBeOpen = false;
    } finally {
      // RECOVERY ROLLBACK, also bounded. Reached by the `continue`s above and
      // by any throw. A COMMIT that timed out may in fact have landed, in
      // which case this is a harmless no-op warning.
      if (mayBeOpen) await step(() => c`rollback`, 'recovery rollback');

      // STOP THE LOOP RATHER THAN REUSE A CONNECTION WITH AN ABANDONED
      // STATEMENT ON IT. Checked after the recovery rollback, because that
      // rollback can itself be abandoned.
      //
      // To be accurate about the mechanism: a stray statement cannot land
      // INSIDE the next order's transaction. One reserved connection is one
      // socket, the driver writes in order and matches results FIFO, so an
      // abandoned statement necessarily completes before the next BEGIN. The
      // real problems are simpler and still disqualifying - we do not know
      // whether the transaction was actually rolled back, we do not know what
      // the backend is still doing, and the next order's work would queue
      // behind it and inherit its delay. One order left dirty and reported
      // beats an unbounded number cleaned unreliably.
      if (abandonedHere) {
        suspect = o.order_reference;
        failures.push(
          `${o.order_reference}: a statement was abandoned at its deadline and may still be running ` +
          `server-side; the client cannot establish otherwise. This connection is not reused.`);
      }
      // RELEASED UNCONDITIONALLY, AND EXACTLY ONCE, even when the rollback
      // above failed. Withholding release is the worse option, not the safer
      // one: connection.end() never resolves while `reserved` is truthy
      // (connection.js:413-419), so a single un-released connection hangs
      // sql.end() and destroys the entire failure report - the outcome this
      // whole bounding exercise exists to prevent.
      c.release();
    }
  }

  // food_order_items is NOT deleted. The RPC reads it to compute the release,
  // so removing it would silently release nothing; and the parent order is
  // append-only and stays anyway, so deleting its lines would only destroy the
  // record of what was ordered.
  return failures;
}

/** Teardown must never pass silently. Call from afterAll. */
export function assertCleanupSucceeded(failures: string[], runId: string): void {
  const all = failures.concat(sessionFailures);
  if (all.length) {
    throw new Error(`[Food M1 cleanup ${runId}] teardown did not complete:\n  - ${all.join('\n  - ')}`);
  }
}

/**
 * Rollback/release failures collected across a suite.
 *
 * These cannot be thrown from a `finally` block without masking the real test
 * error, and they must not be swallowed either. So they are accumulated here
 * and asserted by assertCleanupSucceeded in afterAll: a test that passed but
 * failed to unwind cleanly still reddens the suite.
 */
export const sessionFailures: string[] = [];

/**
 * Unwinds reserved sessions on EVERY exit path - success, assertion failure,
 * or a throw from setup or from a concurrent promise.
 *
 * `release()` performs no implicit ROLLBACK, so a connection returned to the
 * pool with an open or aborted transaction poisons the next test with 25P02.
 * The repo convention (walletTransferReversalRace.integration.test.ts:173)
 * rolls back BOTH racing connections; this does the same, and additionally:
 *
 *  - settles any still-pending promise first, so a statement in flight cannot
 *    be cancelled underneath its own connection;
 *  - attempts every rollback INDEPENDENTLY, so one failure does not prevent
 *    the rest;
 *  - always releases, even if the rollback threw;
 *  - records failures rather than discarding them.
 *
 * NOT BOUNDED, unlike everything in cancelRunOrders. The `rollback` in
 * rollbackAndRelease and the Promise.allSettled over pending work below have
 * NO deadline. A black-holed socket therefore hangs this helper until vitest's
 * per-test timeout fires, and the test then reds with a bare timeout instead
 * of the explanation it would otherwise have given.
 *
 * Tolerated deliberately, for two reasons: this runs in a test's `finally`,
 * AFTER every assertion, so it cannot turn a failure into a pass; and the
 * waiters carry a transaction-local lock_timeout, which bounds the realistic
 * case. afterAll is still reached, and endPoolBounded is hard-bounded by the
 * driver, so assertCleanupSucceeded still reports. Bounding it properly needs
 * care - a pending statement that is timed out must NOT then have its own
 * connection rolled back underneath it - and is left for a separate change.
 *
 * @param pending promises that may still be running against these sessions
 */
export interface Session {
  conn: Conn;
  /** A statement still running on THIS connection, if any. Associating it with
   *  its own connection is what makes the unwind order below possible. */
  pending?: Promise<unknown> | null;
}

async function rollbackAndRelease(s: Session, label: string): Promise<void> {
  try {
    await s.conn`rollback`;
  } catch (e) {
    // Every rejection is recorded. PostgreSQL reports ROLLBACK outside a
    // transaction as a WARNING, which the driver routes to onnotice, so the
    // post-commit case never reaches here and needs no special case.
    sessionFailures.push(`${label} rollback: ${(e as Error)?.message ?? String(e)}`);
  } finally {
    try {
      s.conn.release();
    } catch (e) {
      sessionFailures.push(`${label} release: ${(e as Error)?.message ?? String(e)}`);
    }
  }
}

export async function unwindSessions(sessions: Session[]): Promise<void> {
  // ORDER MATTERS, and getting it wrong deadlocks the teardown.
  //
  // A pending statement is often BLOCKED on a lock held by another connection
  // in this same array. Awaiting all pending work first - the obvious order -
  // queues the holder's rollback behind a wait that only the holder can end.
  // The driver will not terminate a reserved connection either, so sql.end()
  // then hangs, the afterAll hook times out, and the cleanup assertion that
  // follows it never runs.
  //
  // So: unwind the IDLE sessions first. They are not executing anything, their
  // rollback cannot block, and it drops the locks the waiters are queued on.
  const idle = sessions.filter((s) => !s.pending);
  const busy = sessions.filter((s) => s.pending);

  for (const s of idle) await rollbackAndRelease(s, 'idle');

  // Now the waiters can make progress. allSettled, not all: a rejected race
  // promise is an expected outcome and must not stop the unwind. A connection
  // is never released while its own statement is still running.
  if (busy.length) {
    await Promise.allSettled(busy.map((s) => s.pending as Promise<unknown>));
  }
  for (const s of busy) await rollbackAndRelease(s, 'busy');
}

/**
 * Shuts the pool down under an explicit bound, and reports when that bound was
 * reached rather than treating it as success.
 *
 * WHY A BOUND IS NEEDED. postgres.js 3.4.9 `end()` with no argument is a bare
 * `Promise.all(connections.map(c => c.end()))` (index.js:365-378), and
 * `connection.end()` returns a promise that only resolves via `terminate()`
 * whenever `connection.reserved` is truthy (connection.js:413-419). So a single
 * connection left reserved - by a test whose `finally` was orphaned when vitest
 * timed the test out, say - hangs `sql.end()` forever. The afterAll hook then
 * hits its own timeout and `assertCleanupSucceeded` never runs, silently
 * discarding every recorded failure.
 *
 * WHAT THE BOUND ACTUALLY DOES, read from the driver rather than assumed.
 * `end({ timeout })` takes SECONDS (`timeout * 1000`, index.js:372) and races
 * the shutdown against a timer that calls `destroy`, which calls
 * `c.terminate()` on every connection (index.js:384-389). `terminate()` rejects
 * an in-flight query with CONNECTION_DESTROYED and closes the socket
 * (connection.js:421-433).
 *
 * WHAT IT DOES NOT DO. It does NOT issue a PostgreSQL CancelRequest. The
 * server-side statement is not cancelled by the driver; the backend aborts it
 * when it notices the closed connection, which is prompt in practice but is
 * PostgreSQL's behaviour, not a guarantee this code can make. So a forced
 * shutdown is reported as a cleanup FAILURE, never as success.
 *
 * The elapsed-time check is a heuristic - it is the only signal the driver
 * exposes, since the race resolves identically either way.
 */
export async function endPoolBounded(sql: Sql, seconds = 5): Promise<string[]> {
  const failures: string[] = [];
  const started = Date.now();
  try {
    await sql.end({ timeout: seconds });
  } catch (e) {
    failures.push(`pool shutdown: ${(e as Error)?.message ?? String(e)}`);
    return failures;
  }
  const elapsed = Date.now() - started;
  if (elapsed >= seconds * 1000) {
    failures.push(
      `pool shutdown hit its ${seconds}s bound after ${elapsed}ms: at least one connection was still ` +
      `reserved and was force-terminated. Teardown did not complete cleanly, and any statement still ` +
      `running server-side was not cancelled by the driver.`,
    );
  }
  return failures;
}

/**
 * A lock timeout is a teardown safety net, never evidence about the code under
 * test. If a race assertion is satisfied by 55P03 the test proves nothing, so
 * callers assert this explicitly rather than relying on a regex not matching.
 */
export function assertNotLockTimeout(outcome: unknown, where: string): void {
  const text = typeof outcome === 'string' ? outcome : JSON.stringify(outcome ?? '');
  if (/lock timeout|55P03/i.test(text)) {
    throw new Error(
      `${where}: the competing session hit a lock timeout (${text}). That is a teardown guard, ` +
      `not evidence that the code under test ran. This result proves nothing.`,
    );
  }
}

/** The backend pid behind a reserved connection, for the barrier below. */
export async function backendPid(c: Conn): Promise<number> {
  const [{ pid }] = await c<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
  return pid;
}

export interface BlockedOn {
  waitEvent: string;
  blockedBy: number[];
}

/**
 * Blocks until `pid` is observably WAITING ON A LOCK, and reports what it is
 * waiting for. This is the deterministic overlap the race tests need.
 *
 * WHY A BARRIER IS THE WHOLE POINT, not a convenience. Without one, a test
 * that fires the second request and then immediately commits the first has no
 * ordering guarantee at all: the COMMIT is a tiny statement on an already-open
 * connection, while the second request has to parse and plan a large function,
 * so the commit usually wins. The loser's unlocked replay read then FINDS the
 * committed row and returns from the pre-existing replay path - producing a
 * response identical to the one the new unique_violation handler produces.
 * Such a test passes whether or not the handler exists.
 *
 * Observing the loser blocked on a lock is what rules that out. A request that
 * took the unlocked replay path never blocks; it returns at once. So a caller
 * that waits here, sees the block, and only then commits the winner has
 * established that the loser got past the replay read without finding a row,
 * and therefore that whatever it returns afterwards came from the guarded
 * INSERT's handler.
 *
 * THIS IS NOT A SLEEP. The synchronisation is the predicate on
 * pg_stat_activity; setTimeout is only the interval between polls. The budget
 * is a failure bound, not a wait: if the predicate never holds, the test is
 * FAILED with an explanation rather than allowed to proceed and prove nothing.
 * Keep the budget below the waiter's lock_timeout, or this can time out while
 * the session it is watching is still legitimately queued.
 *
 * THE BUDGET IS CHECKED BETWEEN POLLS, NOT DURING ONE. `budgetMs` bounds how
 * many polls are attempted; it does NOT bound a single poll. If one poll query
 * never returns - pool starvation, an unresponsive backend - this loop does
 * not time out, and only vitest's per-test timeout stops it, discarding the
 * explanatory message below. Low likelihood (pool max is 4, peak demand 3),
 * and not redesigned here.
 */
export async function waitUntilLockBlocked(
  sql: Sql, pid: number, budgetMs = 1200, pollMs = 20,
): Promise<BlockedOn> {
  const until = Date.now() + budgetMs;
  for (;;) {
    const [row] = await sql<{
      state: string | null; wait_event_type: string | null; wait_event: string | null; blocked_by: number[] | null;
    }[]>`
      select state, wait_event_type, wait_event, pg_blocking_pids(pid) as blocked_by
        from pg_stat_activity where pid = ${pid}`;

    if (!row) {
      throw new Error(`backend ${pid} is no longer connected; it cannot be waiting on anything.`);
    }
    if (row.wait_event_type === 'Lock') {
      return { waitEvent: row.wait_event ?? '', blockedBy: row.blocked_by ?? [] };
    }
    if (Date.now() >= until) {
      throw new Error(
        `backend ${pid} never blocked on a lock within ${budgetMs}ms ` +
        `(state=${row.state}, wait=${row.wait_event_type ?? 'none'}/${row.wait_event ?? 'none'}). ` +
        `The losing request did not reach the guarded INSERT, so this run establishes nothing ` +
        `about the unique_violation handler and must not be read as a pass.`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
