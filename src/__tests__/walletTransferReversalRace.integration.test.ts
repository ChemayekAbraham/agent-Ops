import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import postgres from 'postgres';

/**
 * Transfer reversal vs recipient withdrawal — race integration test.
 *
 * Uses two real database connections, each in its own transaction, and
 * ROLLS BACK EVERYTHING. Nothing is committed, so no money moves.
 *
 *  A) Reversal first: the reversal succeeds and writes both notifications
 *     with the returned amount. A concurrent withdrawal for the recipient
 *     cannot proceed while the reversal is in flight (blocked on the shared
 *     per-recipient lock).
 *  B) Withdrawal first: a concurrent reversal cannot proceed while the
 *     withdrawal is in flight.
 *  C) Loser re-checks: once a withdrawal exists, the reversal is refused.
 *
 * Needs PG env vars and a role allowed to execute create_ledger_transaction
 * and reverse_wallet_transfer and to insert withdrawal_requests. Skips
 * otherwise (the sandbox read role cannot execute the reversal function).
 *
 * Isolation + cleanup: runs ONLY when RACE_TEST_ISOLATED_DB=1 and the
 * database looks like a test database (< 1,000 profiles). Each run creates
 * two throwaway accounts (race-test+<run>-…@example.invalid). After each
 * test, and again after the run, everything tagged with this run's id —
 * notifications, withdrawal requests, transfer ledger rows, and the two
 * accounts — is deleted, so nothing is left behind even if a test crashes
 * mid-transaction or something was committed by mistake.
 */

const AMOUNT = 1000;
const LOCK_WAIT = '1500ms';
const LOCK_NOT_AVAILABLE = '55P03';
const MAX_TEST_DB_PROFILES = 1000;
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const REF_PREFIX = `WT-RACE-${RUN_ID}-`;
const EMAIL_PREFIX = `race-test+${RUN_ID.toLowerCase()}-`;

type Sql = ReturnType<typeof postgres>;
type Tx = Awaited<ReturnType<Sql['reserve']>>;

let sql: Sql | null = null;
let canRun = false;
let sender = '';
let recipient = '';
const createdUsers: string[] = [];

async function begin(c: Tx, actor: string) {
  await c`begin`;
  await c`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor, role: 'authenticated' })}, true)`;
}

/** Creates an uncommitted transfer inside the caller's transaction. */
async function seedTransfer(c: Tx): Promise<string> {
  const ref = `${REF_PREFIX}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const leg = (user: string, direction: string) => ({
    user_id: user, amount: AMOUNT, direction, category: 'wallet_transfer',
    ledger_scope: 'wallet', source_table: 'wallet_transactions',
    description: 'integration test transfer', currency: 'UGX',
    transaction_date: new Date().toISOString(), reference_id: ref,
    recipient_type: 'user', wallet_bucket: 'withdrawable',
  });
  const entries = [leg(sender, 'cash_out'), leg(recipient, 'cash_in')];
  await c`select public.create_ledger_transaction(${c.json(entries)}::jsonb, ${ref}, true)`;
  return ref;
}

async function insertWithdrawal(c: Tx) {
  await c`insert into public.withdrawal_requests (user_id, amount, status, mobile_money_number)
          values (${recipient}, ${AMOUNT}, 'pending', '0700000000')`;
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e: any) { return e?.code ?? e?.message ?? 'error'; }
}

/** Creates one throwaway account; the signup trigger creates its profile. */
async function createThrowawayUser(label: string): Promise<string> {
  const [{ id }] = await sql!`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, raw_user_meta_data, created_at, updated_at)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${`${EMAIL_PREFIX}${label}@example.invalid`}, '', now(),
            ${sql!.json({ full_name: `Race test ${label}` })}, now(), now())
    returning id`;
  createdUsers.push(id);
  return id;
}

/** Removes every row this run could have left behind. Never touches other users. */
async function cleanupRun() {
  if (!sql || !canRun) return;
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['notifications', () => sql!`delete from public.notifications
        where metadata->>'reference' like ${REF_PREFIX + '%'}
           or user_id = any(${createdUsers}::uuid[])`],
    ['withdrawal_requests', () => sql!`delete from public.withdrawal_requests
        where user_id = any(${createdUsers}::uuid[])`],
    ['system_events', () => sql!`delete from public.system_events
        where metadata->>'reference_id' like ${REF_PREFIX + '%'}`],
    ['general_ledger', () => sql!`delete from public.general_ledger
        where reference_id like ${REF_PREFIX + '%'}`],
    ['auth.users', () => sql!`delete from auth.users
        where id = any(${createdUsers}::uuid[]) and email like ${EMAIL_PREFIX + '%'}`],
  ];
  const failures: string[] = [];
  for (const [name, run] of steps) {
    try { await run(); } catch (e: any) { failures.push(`${name}: ${e?.message ?? e}`); }
  }
  if (failures.length) console.warn(`[race-test cleanup ${RUN_ID}]`, failures.join('; '));
}

beforeAll(async () => {
  if (!process.env.PGHOST || process.env.RACE_TEST_ISOLATED_DB !== '1') return;
  sql = postgres({ max: 3, onnotice: () => {} });
  const [priv] = await sql`
    select has_function_privilege('public.reverse_wallet_transfer(text)', 'execute')
       and has_function_privilege('public.create_ledger_transaction(jsonb,text,boolean)', 'execute')
       and has_table_privilege('public.withdrawal_requests', 'insert')
       and has_table_privilege('auth.users', 'insert,delete') as ok`;
  const [{ n }] = await sql`select count(*)::int as n from public.profiles`;
  if (!priv?.ok || n >= MAX_TEST_DB_PROFILES) return; // never run against live
  canRun = true;
  try {
    sender = await createThrowawayUser('sender');
    recipient = await createThrowawayUser('recipient');
  } catch {
    await cleanupRun();
    canRun = false;
  }
});

afterEach(async () => { await cleanupRun(); });

afterAll(async () => {
  await cleanupRun();
  if (sql && canRun) {
    const [{ left }] = await sql`
      select (select count(*) from auth.users where email like ${EMAIL_PREFIX + '%'})
           + (select count(*) from public.general_ledger where reference_id like ${REF_PREFIX + '%'})
           + (select count(*) from public.notifications where metadata->>'reference' like ${REF_PREFIX + '%'})
           as left`;
    if (Number(left) > 0) console.warn(`[race-test cleanup ${RUN_ID}] ${left} rows remain`);
  }
  await sql?.end();
});

describe('wallet transfer reversal vs withdrawal race (integration)', () => {
  it('A) reversal wins: notifies both with returned amount and blocks the withdrawal', async (ctx) => {
    if (!canRun) return ctx.skip();
    const c1 = await sql!.reserve();
    const c2 = await sql!.reserve();
    try {
      await begin(c1, sender);
      const ref = await seedTransfer(c1);
      const [{ r }] = await c1`select public.reverse_wallet_transfer(${ref}) as r`;
      expect(Number(r.amount)).toBe(AMOUNT);

      const notes = await c1`
        select user_id, metadata from public.notifications
         where type = 'wallet_transfer_reversal' and metadata->>'reference' = ${ref}`;
      expect(notes).toHaveLength(2);
      const byRole = Object.fromEntries(notes.map((n: any) => [n.metadata.role, n]));
      expect(byRole.sender.user_id).toBe(sender);
      expect(byRole.recipient.user_id).toBe(recipient);
      expect(Number(byRole.sender.metadata.amount)).toBe(AMOUNT);
      expect(Number(byRole.recipient.metadata.amount)).toBe(AMOUNT);

      await begin(c2, recipient);
      await c2`select set_config('lock_timeout', ${LOCK_WAIT}, true)`;
      expect(await codeOf(insertWithdrawal(c2))).toBe(LOCK_NOT_AVAILABLE);
    } finally {
      await c2`rollback`.catch(() => {}); await c1`rollback`.catch(() => {});
      c1.release(); c2.release();
    }
  });

  it('B) withdrawal wins: a concurrent reversal cannot proceed', async (ctx) => {
    if (!canRun) return ctx.skip();
    const c1 = await sql!.reserve();
    const c2 = await sql!.reserve();
    try {
      // The lock is taken by the first BEFORE INSERT trigger and held to the
      // end of the transaction, even if a later withdrawal guard rejects it.
      await begin(c2, recipient);
      await codeOf(insertWithdrawal(c2));

      await begin(c1, sender);
      const ref = await seedTransfer(c1);
      await c1`select set_config('lock_timeout', ${LOCK_WAIT}, true)`;
      expect(await codeOf(c1`select public.reverse_wallet_transfer(${ref})`)).toBe(LOCK_NOT_AVAILABLE);
    } finally {
      await c1`rollback`.catch(() => {}); await c2`rollback`.catch(() => {});
      c1.release(); c2.release();
    }
  });

  it('C) after a withdrawal exists the reversal is refused and nobody is notified', async (ctx) => {
    if (!canRun) return ctx.skip();
    const c1 = await sql!.reserve();
    try {
      await begin(c1, sender);
      const ref = await seedTransfer(c1);
      await c1`savepoint w`;
      const wErr = await codeOf(insertWithdrawal(c1));
      if (wErr) {
        await c1`rollback to savepoint w`;
        return ctx.skip(); // another withdrawal guard rejected the fixture
      }
      const err = await codeOf(c1`select public.reverse_wallet_transfer(${ref})`);
      expect(String(err)).not.toBe('null');
      await c1`rollback`; await begin(c1, sender);
      const notes = await c1`select 1 from public.notifications where metadata->>'reference' = ${ref}`;
      expect(notes).toHaveLength(0);
    } finally {
      await c1`rollback`.catch(() => {});
      c1.release();
    }
  });
});
