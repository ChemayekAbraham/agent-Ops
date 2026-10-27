// Portfolio Return hold — migration 20261024160000 against a THROWAWAY local Postgres (embedded-postgres).
// Never connects to any shared or production database: it starts its own server on 127.0.0.1 and deletes it after.
//
//   node run_hold_tests.mjs <repo root>          (needs the packages `embedded-postgres` and `pg`)
//
// Start state = production on 2026-10-24 for the one function the migration replaces: merge_paidout_topups is loaded
// verbatim from the rollback file, and the migration is applied WITH its precondition block, so the test also proves
// the pinned fingerprint matches that definition.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('usage: node run_hold_tests.mjs <repo root>');
const rd = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = rd('supabase/migrations/20261024160000_portfolio_return_hold.sql');
const ROLLBACK = rd('supabase/rollbacks/20261024160000_portfolio_return_hold.rollback.sql');
const STUB = rd('supabase/tests/portfolio_return_hold/00_stub_schema.sql');
const MERGE_PROD = ROLLBACK.slice(ROLLBACK.indexOf('CREATE OR REPLACE FUNCTION public.merge_paidout_topups()'),
  ROLLBACK.indexOf(';', ROLLBACK.lastIndexOf('$function$')) + 1);
if (!MERGE_PROD.startsWith('CREATE OR REPLACE FUNCTION public.merge_paidout_topups()') || !MERGE_PROD.trimEnd().endsWith('$function$\n;')) {
  throw new Error('could not read the production merge_paidout_topups body from the rollback file');
}
const PRECONDITION = MIGRATION.match(/DO \$pre\$[\s\S]*?\$pre\$;/)[0];

const ID = (n) => `0d0d0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CFO = ID(1), COO = ID(2), PARTNER = ID(3), OTHER = ID(4), STRANGER = ID(5);
const HELD = ID(201), FREE = ID(202);
const REASON = 'Investigation of duplicate Returns and unsupported principal edits';

const port = 58700 + Math.floor(Math.random() * 200);
const epg = new EmbeddedPostgres({ databaseDir: `./pghold-${Date.now()}`, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {} });
await epg.initialise(); await epg.start();
const admin = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'pw', database: 'postgres' });
await admin.connect(); const db = `hold_test_${Date.now()}`;
await admin.query(`create database ${db} encoding 'UTF8' template template0`); await admin.end();
const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'pw', database: db });
await c.connect();

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
  finally { await c.query('rollback').catch(() => {}); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
// Run fn inside a transaction as a signed-in browser user (role authenticated) or as a backend (role postgres).
async function as(uid, fn, { role = 'authenticated' } = {}) {
  await c.query('begin');
  try {
    if (uid) await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    if (role) await c.query(`set local role ${role}`);
    const r = await fn();
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback'); throw e; }
}
async function codeOf(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
const legs = async (pf) => Number((await q1(`select count(*) n from general_ledger where source_id = $1`, [pf])).n);
const principal = async (pf) => Number((await q1(`select investment_amount a from investor_portfolios where id = $1`, [pf])).a);
const post = (entries) => c.query(`select public.create_ledger_transaction($1::jsonb)`, [JSON.stringify(entries)]);
const compound = (pf, amt) => [
  { user_id: PARTNER, amount: amt, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: pf },
  { user_id: PARTNER, amount: amt, direction: 'cash_in', category: 'roi_reinvestment', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: pf }];
const cashReturn = (pf, amt) => [
  { user_id: PARTNER, amount: amt, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet', wallet_bucket: 'withdrawable', source_table: 'investor_portfolios', source_id: pf },
  { user_id: PARTNER, amount: amt, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: pf }];
const topupFunding = (pf, amt) => [
  { user_id: PARTNER, amount: amt, direction: 'cash_out', category: 'partner_funding', ledger_scope: 'wallet', wallet_bucket: 'withdrawable', source_table: 'investor_portfolios', source_id: pf },
  { user_id: PARTNER, amount: amt, direction: 'cash_in', category: 'pending_portfolio_topup', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: pf }];
const refund = (pf, amt) => [
  { user_id: PARTNER, amount: amt, direction: 'cash_in', category: 'partner_funding', ledger_scope: 'wallet', wallet_bucket: 'withdrawable', source_table: 'investor_portfolios', source_id: pf },
  { user_id: PARTNER, amount: amt, direction: 'cash_out', category: 'pending_portfolio_topup', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: pf }];

try {
  await c.query(STUB);
  await c.query(MERGE_PROD);
  await c.query(`insert into user_roles values ($1,'cfo',true), ($2,'coo',true), ($2,'manager',true)`, [CFO, COO]);
  for (const [id, code] of [[HELD, 'WIPHOLD1'], [FREE, 'WIPFREE1']]) {
    await c.query(`insert into investor_portfolios (id, investor_id, agent_id, portfolio_code, investment_amount, next_roi_date, payout_day)
                   values ($1, $2, $2, $3, 1000000, current_date + 10, 5)`, [id, PARTNER, code]);
  }

  await test('migration applies on the production definition (fingerprint precondition passes)', async () => {
    await c.query(MIGRATION);
    const r = await q1(`select to_regclass('public.portfolio_return_holds') t`);
    assert(r.t, 'holds table missing');
  });

  await test('the migration holds nothing by itself', async () => {
    const r = await q1(`select count(*) n from portfolio_return_holds`); assert(Number(r.n) === 0, 'holds present');
  });

  await test('only the CFO approver can place a hold; COO and partner are refused', async () => {
    assert(await codeOf(as(COO, () => c.query(`select place_portfolio_return_hold($1, $2)`, [HELD, REASON]))) === '42501', 'COO not refused');
    assert(await codeOf(as(PARTNER, () => c.query(`select place_portfolio_return_hold($1, $2)`, [HELD, REASON]))) === '42501', 'partner not refused');
    assert(await codeOf(as(null, () => c.query(`select place_portfolio_return_hold($1, $2)`, [HELD, REASON]), { role: 'anon' })) === '42501', 'anon not refused');
  });

  await test('a hold needs a reason of 20+ characters', async () => {
    assert(await codeOf(as(CFO, () => c.query(`select place_portfolio_return_hold($1, 'short')`, [HELD]))) === '22023', 'short reason accepted');
  });

  await test('the browser cannot write the holds table directly', async () => {
    const e = await codeOf(as(CFO, () => c.query(`insert into portfolio_return_holds (portfolio_id, reason, held_by) values ($1, $2, $3)`, [HELD, REASON, CFO])));
    assert(e === '42501', `direct insert not refused: ${e}`);
  });

  await test('CFO places a hold; it is audited; a second hold is refused', async () => {
    await as(CFO, () => c.query(`select place_portfolio_return_hold($1, $2)`, [HELD, REASON]));
    const a = await q1(`select count(*) n from audit_logs where action_type = 'portfolio_return_hold_placed' and record_id = $1`, [HELD]);
    assert(Number(a.n) === 1, 'no audit row');
    assert(await codeOf(as(CFO, () => c.query(`select place_portfolio_return_hold($1, $2)`, [HELD, REASON]))) === '23505', 'duplicate hold accepted');
  });

  await test('staff can read holds; a partner sees none', async () => {
    const s = await as(COO, () => q1(`select count(*) n from portfolio_return_holds`));
    const p = await as(PARTNER, () => q1(`select count(*) n from portfolio_return_holds`));
    assert(Number(s.n) === 1 && Number(p.n) === 0, `staff ${s.n} partner ${p.n}`);
  });

  // ---- blocked while held ---------------------------------------------------------------------------------------
  for (const [label, sql, args] of [
    ['principal edit (browser, manager/COO)', `update investor_portfolios set investment_amount = 3450000 where id = $1`, [HELD]],
    ['next Return date edit', `update investor_portfolios set next_roi_date = next_roi_date + 30 where id = $1`, [HELD]],
    ['mode change (compounding)', `update investor_portfolios set roi_mode = 'monthly_compounding' where id = $1`, [HELD]],
    ['status change (close / redeem)', `update investor_portfolios set status = 'redeemed' where id = $1`, [HELD]],
    ['delete', `delete from investor_portfolios where id = $1`, [HELD]],
  ]) {
    await test(`blocked while held: ${label}, as COO and as a backend`, async () => {
      const before = await principal(HELD);
      assert(await codeOf(as(COO, () => c.query(sql, args))) === '42501', 'COO not refused');
      assert(await codeOf(as(null, () => c.query(sql, args), { role: null })) === '42501', 'backend not refused');
      assert(await principal(HELD) === before, 'row changed');
    });
  }

  await test('allowed while held: account name / label edit', async () => {
    await as(COO, () => c.query(`update investor_portfolios set account_name = 'ACCOUNT 2' where id = $1`, [HELD]));
    const r = await q1(`select account_name from investor_portfolios where id = $1`, [HELD]);
    assert(r.account_name === 'ACCOUNT 2', 'name not changed');
  });

  for (const [label, entries] of [
    ['compound', compound(HELD, 150000)],
    ['cash Return (approval of a queued request)', cashReturn(HELD, 150000)],
    ['top-up funding from the partner wallet', topupFunding(HELD, 700000)],
    ['capital activation (merge leg)', [
      { user_id: PARTNER, amount: 700000, direction: 'cash_out', category: 'pending_portfolio_topup', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: HELD },
      { user_id: PARTNER, amount: 700000, direction: 'cash_in', category: 'partner_funding', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: HELD }]],
  ]) {
    await test(`blocked while held: ledger ${label} — nothing posted, no wallet movement`, async () => {
      const n = await legs(HELD); const w = await q1(`select coalesce(sum(withdrawable),0) w from wallets`);
      assert(await codeOf(as(null, () => post(entries), { role: null })) === '42501', 'not refused');
      assert(await legs(HELD) === n, 'legs posted');
      assert(Number((await q1(`select coalesce(sum(withdrawable),0) w from wallets`)).w) === Number(w.w), 'wallet moved');
    });
  }

  await test('allowed while held: refund of a parked top-up back to the partner wallet', async () => {
    const n = await legs(HELD);
    await as(null, () => post(refund(HELD, 700000)), { role: null });
    assert(await legs(HELD) === n + 2, 'refund not posted');
  });

  for (const [label, cat, op] of [['Return payout request', 'roi_payout', 'roi_wallet_credit'], ['top-up request', 'wallet_to_investment', 'portfolio_topup']]) {
    await test(`blocked while held: new ${label}`, async () => {
      const e = await codeOf(as(COO, () => c.query(`insert into pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, operation_type)
        values ($1, 150000, 'cash_in', $2, 'investor_portfolios', $3, $4)`, [PARTNER, cat, HELD, op])));
      assert(e === '42501', `not refused: ${e}`);
    });
  }

  await test('the free portfolio is unaffected: edit, compound, request all work', async () => {
    await as(COO, () => c.query(`update investor_portfolios set next_roi_date = next_roi_date + 1 where id = $1`, [FREE]));
    await as(null, () => post(compound(FREE, 150000)), { role: null });
    await as(COO, () => c.query(`insert into pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, operation_type)
      values ($1, 150000, 'cash_in', 'roi_payout', 'investor_portfolios', $2, 'roi_wallet_credit')`, [PARTNER, FREE]));
    assert(await legs(FREE) === 2, 'free portfolio blocked');
  });

  await test('daily top-up merge skips the held portfolio and still merges the free one', async () => {
    // Each portfolio: an approved Return payout 2 days ago and a funded parked top-up from 3 days ago.
    // Parked top-ups queued before the hold are seeded with the hold trigger bypassed (as if queued earlier).
    await c.query(`set session_replication_role = replica`);
    for (const pf of [HELD, FREE]) {
      await c.query(`insert into pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, operation_type, status, reviewed_at, created_at)
        values ($1, 150000, 'cash_in', 'roi_payout', 'investor_portfolios', $2, 'roi_wallet_credit', 'approved', now() - interval '2 days', now() - interval '2 days')`, [PARTNER, pf]);
      await c.query(`insert into pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, operation_type, status, created_at, metadata)
        values ($1, 500000, 'cash_out', 'wallet_to_investment', 'investor_portfolios', $2, 'portfolio_topup', 'approved', now() - interval '3 days', '{"funded": true}')`, [PARTNER, pf]);
    }
    await c.query(`set session_replication_role = origin`);
    const heldBefore = await principal(HELD), freeBefore = await principal(FREE);
    const r = (await q1(`select merge_paidout_topups() r`)).r;
    assert(r.merged_portfolios === 1, `merged ${JSON.stringify(r)}`);
    assert(await principal(HELD) === heldBefore, 'held principal changed');
    assert(await principal(FREE) === freeBefore + 500000, 'free portfolio not merged');
    const parked = await q1(`select status from pending_wallet_operations where source_id = $1 and operation_type = 'portfolio_topup'`, [HELD]);
    assert(parked.status === 'approved', 'held top-up was consumed');
  });

  await test('withdrawals are not part of the hold (wallet debit not sourced to the portfolio is allowed)', async () => {
    await as(null, () => post([{ user_id: PARTNER, amount: 1000, direction: 'cash_out', category: 'wallet_withdrawal', ledger_scope: 'wallet', wallet_bucket: 'withdrawable', source_table: 'withdrawal_requests', source_id: ID(900) },
      { user_id: PARTNER, amount: 1000, direction: 'cash_in', category: 'wallet_withdrawal', ledger_scope: 'platform', source_table: 'withdrawal_requests', source_id: ID(900) }]), { role: null });
  });

  await test('only the CFO approver can release; after release the portfolio works again; audited', async () => {
    assert(await codeOf(as(COO, () => c.query(`select release_portfolio_return_hold($1, $2)`, [HELD, REASON]))) === '42501', 'COO release accepted');
    await as(CFO, () => c.query(`select release_portfolio_return_hold($1, $2)`, [HELD, 'Evidence reviewed and correction posted']));
    await as(COO, () => c.query(`update investor_portfolios set next_roi_date = next_roi_date + 1 where id = $1`, [HELD]));
    await as(null, () => post(compound(HELD, 150000)), { role: null });
    const a = await q1(`select count(*) n from audit_logs where action_type = 'portfolio_return_hold_released' and record_id = $1`, [HELD]);
    assert(Number(a.n) === 1, 'no release audit');
  });

  await test('a portfolio can be held again after release (history kept)', async () => {
    await as(CFO, () => c.query(`select place_portfolio_return_hold($1, $2)`, [HELD, REASON]));
    const r = await q1(`select count(*) n, count(*) filter (where released_at is null) a from portfolio_return_holds where portfolio_id = $1`, [HELD]);
    assert(Number(r.n) === 2 && Number(r.a) === 1, JSON.stringify(r));
  });

  await test('grants: anon cannot call the hold functions; trigger functions are not callable', async () => {
    const g = await q1(`select has_function_privilege('anon', 'public.place_portfolio_return_hold(uuid,text)', 'EXECUTE') a,
                               has_function_privilege('anon', 'public.is_portfolio_on_hold(uuid)', 'EXECUTE') b,
                               has_function_privilege('authenticated', 'public.enforce_portfolio_return_hold_ledger()', 'EXECUTE') t,
                               has_table_privilege('anon', 'public.portfolio_return_holds', 'SELECT') s,
                               has_table_privilege('authenticated', 'public.portfolio_return_holds', 'INSERT') i`);
    assert(!g.a && !g.b && !g.t && !g.s && !g.i, JSON.stringify(g));
  });

  await test('rollback restores merge_paidout_topups exactly, removes the hold, keeps the table', async () => {
    await c.query(ROLLBACK);
    const m = await q1(`select md5(pg_get_functiondef('public.merge_paidout_topups()'::regprocedure)) m`);
    assert(m.m === 'b9e3b9ce7d300f6fe080b9f87dfee614', `fingerprint ${m.m}`);
    await as(COO, () => c.query(`update investor_portfolios set next_roi_date = next_roi_date + 1 where id = $1`, [HELD]));
    const t = await q1(`select to_regclass('public.portfolio_return_holds') t, (select count(*) from portfolio_return_holds) n`);
    assert(t.t && Number(t.n) === 2, 'table not kept');
  });

  await test('precondition aborts if production merge_paidout_topups has changed', async () => {
    await c.query(MERGE_PROD.replace('v_grace_days CONSTANT int := 10;', 'v_grace_days CONSTANT int := 11;'));
    const e = await codeOf(c.query(PRECONDITION));
    assert(e && e !== null, 'precondition did not abort');
  });
} finally {
  await c.end(); await epg.stop();
  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`HOLD-TESTS ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
