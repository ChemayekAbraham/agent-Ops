// Run: node scripts/test-gmail-tx-insert-lock.mjs
// Needs a local Postgres (two real sessions) and the `pg` package:
//   npm i --no-save pg && node scripts/test-gmail-tx-insert-lock.mjs
//
// PGlite's socket server will not run another session's query while a
// transaction is open, so it cannot see a row lock. This uses two Postgres
// backends. Exit code 1 on any failure.
//
// Proves an INSERT into gmail_transactions commits while another transaction
// holds FOR UPDATE on an older gmail row. The pre-migration trigger calls
// auto_create_deposits_from_gmail(24), which locks that older row; a
// statement_timeout shorter than the trigger's lock_timeout cancels the
// INSERT with 57014, and WHEN OTHERS does not catch query_canceled.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20261028201000_gmail_tx_insert_single_row_skip_locked.sql', import.meta.url),
  'utf8',
);
const rollback = fs.readFileSync(
  new URL('../supabase/rollbacks/20261028201000_gmail_tx_insert_single_row_skip_locked.rollback.sql', import.meta.url),
  'utf8',
);

function extract(sql, tag) {
  const re = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`);
  const m = sql.match(re);
  if (!m) throw new Error(`missing $${tag}$ in migration`);
  return m[1];
}

const implOld = extract(migration, 'impl_old');
const lockOld = extract(migration, 'lock_old');
const advOld = extract(migration, 'adv_old');

const OLDER = '11111111-1111-4111-8111-111111111111';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name); }
};

const admin = new pg.Client({ host: '/var/run/postgresql', database: 'postgres' });
await admin.connect();
await admin.query(`
  SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
   WHERE datname = 'gmail_lock_test' AND pid <> pg_backend_pid()
`);
await admin.query('DROP DATABASE IF EXISTS gmail_lock_test');
await admin.query('CREATE DATABASE gmail_lock_test');
await admin.end();

const mk = () => new pg.Client({ host: '/var/run/postgresql', database: 'gmail_lock_test' });
const setup = mk();
const holder = mk();
const writer = mk();
await setup.connect();
await holder.connect();
await writer.connect();

await setup.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  END $$;

  CREATE TABLE gmail_transactions (
    id uuid PRIMARY KEY,
    amount numeric,
    transaction_id text,
    counterparty text,
    counterparty_name text,
    channel text,
    internal_date timestamptz,
    subject text,
    snippet text,
    raw_body text,
    from_email text,
    direction text,
    parsed boolean,
    linked_deposit_request_id uuid
  );
  CREATE TABLE gmail_tx_lock_probe (gmail_id uuid);

  -- The batch the pre-migration trigger calls. Locks every candidate receipt.
  CREATE FUNCTION public.auto_create_deposits_from_gmail(p_window_hours integer DEFAULT 336)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  BEGIN
    PERFORM 1 FROM public.gmail_transactions g
     WHERE g.linked_deposit_request_id IS NULL
       AND g.parsed IS TRUE
       AND g.direction IN ('in', 'credit')
       AND g.amount IS NOT NULL AND g.amount > 0
       AND g.transaction_id IS NOT NULL
     FOR UPDATE;
    RETURN 0;
  END
  $fn$;

  CREATE FUNCTION public.trg_gmail_tx_auto_create_deposit()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  declare
    v_prev_lock_timeout text;
  begin
    if new.linked_deposit_request_id is null
       and new.parsed = true
       and new.amount is not null and new.amount > 0
       and new.transaction_id is not null
       and new.direction in ('in','credit') then
      if pg_try_advisory_xact_lock(hashtext('auto_create_deposits_from_gmail')) then
        v_prev_lock_timeout := current_setting('lock_timeout');
        perform set_config('lock_timeout', '1000ms', true);
        begin
          perform public.auto_create_deposits_from_gmail(24);
        exception when others then
          raise warning 'auto_create_deposits_from_gmail deferred to cron: %', sqlerrm;
        end;
        perform set_config('lock_timeout', v_prev_lock_timeout, true);
      end if;
    end if;
    return new;
  end;
  $fn$;

  CREATE TRIGGER trg_gmail_tx_auto_create_deposit
  AFTER INSERT ON public.gmail_transactions
  FOR EACH ROW EXECUTE FUNCTION public.trg_gmail_tx_auto_create_deposit();
`);

await setup.query(`
  CREATE FUNCTION public.auto_create_deposits_from_gmail_impl(p_window_hours integer DEFAULT 24)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
declare
  v_tx record;
${implOld}
  loop
    insert into gmail_tx_lock_probe(gmail_id) values (v_tx.id);
    perform 1 from gmail_transactions where id = v_tx.id for update;
  end loop;
  return 0;
end;
$fn$;

  CREATE FUNCTION public.auto_record_merchant_float_return(
    p_gmail_transaction_id uuid,
    p_agent_id uuid,
    p_match_method text DEFAULT 'phone'
  ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
DECLARE
  v_tx record;
BEGIN
${lockOld}

${advOld}

  -- production body keeps merchant_float_returns, ledger_reconciled_tids, already_recorded
  RETURN jsonb_build_object('ok', true, 'outcome', 'posted', 'id', v_tx.id);
END
$fn$;
`);

await setup.query(
  `INSERT INTO gmail_transactions (id, amount, transaction_id, direction, parsed, internal_date)
   VALUES ($1, 5000, 'OLDER-TID', 'in', true, now())`,
  [OLDER],
);

async function insertReceipt(id, tid) {
  const started = Date.now();
  try {
    await writer.query(
      `INSERT INTO gmail_transactions (id, amount, transaction_id, direction, parsed, internal_date)
       VALUES ($1, 8000, $2, 'in', true, now())`,
      [id, tid],
    );
    return { ok: true, ms: Date.now() - started, code: null };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, code: e.code, message: e.message };
  }
}

async function holdOlder() {
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM gmail_transactions WHERE id = $1 FOR UPDATE', [OLDER]);
}
async function releaseOlder() {
  await holder.query('ROLLBACK');
}

await writer.query(`SET statement_timeout = '800ms'`);
await writer.query(`SET lock_timeout = '0'`);

await holdOlder();
const before = await insertReceipt('33333333-3333-4333-8333-333333333333', 'BEFORE-TID');
await releaseOlder();
ok(before.ok === false && before.code === '57014', `pre-migration insert cancelled with 57014 (got ${before.code} in ${before.ms}ms)`);
const beforeRow = await setup.query(`SELECT 1 FROM gmail_transactions WHERE transaction_id = 'BEFORE-TID'`);
ok(beforeRow.rowCount === 0, 'pre-migration insert rolled back the receipt');

await setup.query(migration);
const trg = await setup.query(`SELECT pg_get_functiondef('public.trg_gmail_tx_auto_create_deposit()'::regprocedure) AS src`);
ok(!trg.rows[0].src.includes('auto_create_deposits_from_gmail('), 'trigger no longer calls the 24h batch');
ok(trg.rows[0].src.includes('auto_create_deposit_from_gmail_row'), 'trigger processes one row');

await setup.query('TRUNCATE gmail_tx_lock_probe');
await setup.query(`SELECT public.auto_create_deposits_from_gmail_impl(24)`);
const cronProbe = await setup.query('SELECT gmail_id FROM gmail_tx_lock_probe');
ok(cronProbe.rows.some((r) => r.gmail_id === OLDER), 'cron path with the GUC unset still reaches the older row');

await setup.query('TRUNCATE gmail_tx_lock_probe');
await holdOlder();
const after = await insertReceipt('22222222-2222-4222-8222-222222222222', 'NEW-TID');
const probe = await setup.query('SELECT gmail_id FROM gmail_tx_lock_probe');
const stored = await setup.query(`SELECT id FROM gmail_transactions WHERE transaction_id = 'NEW-TID'`);
ok(after.ok === true && after.ms < 700, `insert commits while the older row is locked (${after.ms}ms, ${after.code})`);
ok(stored.rowCount === 1, 'new receipt row is stored');
ok(probe.rows.length === 1 && probe.rows[0].gmail_id === '22222222-2222-4222-8222-222222222222',
  `single-row path locked only the new id (locked ${probe.rows.map((r) => r.gmail_id).join(',') || 'none'})`);

let busy = { outcome: null };
try {
  await writer.query('BEGIN');
  await writer.query(`SELECT set_config('welile.gmail_float_return_lock', 'skip_locked', true)`);
  const busyRes = await writer.query(
    `SELECT public.auto_record_merchant_float_return($1::uuid, $2::uuid, 'phone') AS result`,
    [OLDER, AGENT],
  );
  busy = busyRes.rows[0].result;
  await writer.query('COMMIT');
} catch (e) {
  busy = { outcome: e.code, message: e.message };
  await writer.query('ROLLBACK');
}
ok(busy.outcome === 'busy_deferred', `trigger-path row lock returns busy_deferred (got ${busy.outcome})`);

let blockedCode = null;
try {
  await writer.query('BEGIN');
  await writer.query(`SELECT set_config('statement_timeout', '800ms', true)`);
  await writer.query(`SELECT set_config('welile.gmail_float_return_lock', '', true)`);
  await writer.query(
    `SELECT public.auto_record_merchant_float_return($1::uuid, $2::uuid, 'phone')`,
    [OLDER, AGENT],
  );
} catch (e) {
  blockedCode = e.code;
  await writer.query('ROLLBACK');
}
ok(blockedCode === '57014', `cron path still waits and statement_timeout is 57014 (got ${blockedCode})`);
await releaseOlder();

await setup.query('TRUNCATE gmail_tx_lock_probe');
await setup.query('BEGIN');
await setup.query(`SELECT set_config('welile.gmail_deposit_only_id', $1, true)`, [OLDER]);
await setup.query('SELECT public.auto_create_deposits_from_gmail_impl(24)');
await setup.query('COMMIT');
const filtered = await setup.query('SELECT gmail_id FROM gmail_tx_lock_probe');
ok(filtered.rows.length === 1 && filtered.rows[0].gmail_id === OLDER,
  `same session with the GUC set locks only that id (got ${filtered.rows.map((r) => r.gmail_id).join(',')})`);
await setup.query('TRUNCATE gmail_tx_lock_probe');
await setup.query('SELECT public.auto_create_deposits_from_gmail_impl(24)');
const widened = await setup.query('SELECT gmail_id FROM gmail_tx_lock_probe');
ok(widened.rows.length >= 2, `same session with the GUC cleared scans the window again (got ${widened.rowCount})`);

await setup.query(rollback);
const trgBack = await setup.query(`SELECT pg_get_functiondef('public.trg_gmail_tx_auto_create_deposit()'::regprocedure) AS src`);
ok(trgBack.rows[0].src.includes('auto_create_deposits_from_gmail(24)'), 'rollback restores the 24h batch trigger');
const helperGone = await setup.query(`SELECT to_regprocedure('public.auto_create_deposit_from_gmail_row(uuid)') AS fn`);
ok(helperGone.rows[0].fn === null, 'rollback drops the single-row helper');

await holdOlder();
const rolled = await insertReceipt('44444444-4444-4444-8444-444444444444', 'ROLLBACK-TID');
await releaseOlder();
ok(rolled.ok === false && rolled.code === '57014', `after rollback the locked older row cancels the insert (${rolled.code})`);

await setup.query(migration);
await holdOlder();
const again = await insertReceipt('55555555-5555-4555-8555-555555555555', 'REAPPLY-TID');
await releaseOlder();
ok(again.ok === true && again.ms < 700, `re-applied migration insert commits under the lock (${again.ms}ms, ${again.code})`);

await holder.end();
await writer.end();
await setup.end();

const cleaner = new pg.Client({ host: '/var/run/postgresql', database: 'postgres' });
await cleaner.connect();
await cleaner.query(`
  SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
   WHERE datname = 'gmail_lock_test' AND pid <> pg_backend_pid()
`);
await cleaner.query('DROP DATABASE IF EXISTS gmail_lock_test');
await cleaner.end();

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
