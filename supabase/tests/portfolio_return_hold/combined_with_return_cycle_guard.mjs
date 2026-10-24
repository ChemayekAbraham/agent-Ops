// Combined local test: Option C (Return-cycle guard, 20261024140000) + Option A (portfolio Return hold, 20261024160000).
// THROWAWAY embedded Postgres on 127.0.0.1 only. Never touches a shared or production database.
//   node combined_ac.mjs <guard worktree> <hold worktree>
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [GUARD, HOLD] = process.argv.slice(2);
const rd = (root, p) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n');
const C_MIG = rd(GUARD, 'supabase/migrations/20261024140000_return_cycle_guard.sql').replace(/DO \$pre\$[\s\S]*?\$pre\$;/, '');
const C_RB = rd(GUARD, 'supabase/rollbacks/20261024140000_return_cycle_guard.rollback.sql');
const C_STUB = rd(GUARD, 'supabase/tests/return_cycle_guard/00_stub_schema.sql');
const C_PROD = C_RB.slice(C_RB.indexOf('CREATE OR REPLACE FUNCTION public.enforce_roi_cycle_once()'),
  C_RB.indexOf('DROP FUNCTION IF EXISTS public.post_portfolio_roi_ledger(text, uuid, numeric, text, text, text, date, uuid);'));
const A_MIG = rd(HOLD, 'supabase/migrations/20261024160000_portfolio_return_hold.sql');   // WITH its precondition
const A_RB = rd(HOLD, 'supabase/rollbacks/20261024160000_portfolio_return_hold.rollback.sql');
const MERGE_PROD = A_RB.slice(A_RB.indexOf('CREATE OR REPLACE FUNCTION public.merge_paidout_topups()'),
  A_RB.indexOf(';', A_RB.lastIndexOf('$function$')) + 1);
// Extra columns / objects production has and Option A or merge_paidout_topups use (the guard stub omits them).
const EXTRA = `
ALTER TABLE public.investor_portfolios ADD COLUMN agent_id uuid, ADD COLUMN account_name text, ADD COLUMN roi_mode text DEFAULT 'monthly_payout',
  ADD COLUMN duration_months integer DEFAULT 12, ADD COLUMN maturity_date date, ADD COLUMN auto_reinvest boolean DEFAULT false;
CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text, message text, type text, metadata jsonb);
CREATE FUNCTION public.topup_op_is_funded(p_status text, p_metadata jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce((p_metadata->>'funded')::boolean, true) $$;
GRANT DELETE ON public.investor_portfolios TO authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;
`;

const ID = (n) => `0e0f0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CFO = ID(1), COO = ID(2), PARTNER = ID(3), P2 = ID(4);
const REASON = 'Investigation of duplicate Returns and unsupported principal edits';

const port = 59100 + Math.floor(Math.random() * 300);
const epg = new EmbeddedPostgres({ databaseDir: `./pgac-${Date.now()}`, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {} });
await epg.initialise(); await epg.start();
const results = [];
let c;

async function freshDb(name) {
  const a = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'pw', database: 'postgres' });
  await a.connect(); await a.query(`create database ${name} encoding 'UTF8' template template0 lc_collate 'C' lc_ctype 'C'`); await a.end();
  const cl = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'pw', database: name });
  await cl.connect(); return cl;
}
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
  finally { await c.query('rollback').catch(() => {}); await c.query(`select set_config('request.jwt.claim.sub', '', false)`).catch(() => {}); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
async function as(uid, fn, role = null) {
  await c.query('begin');
  try {
    if (uid) await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    if (role) await c.query(`set local role ${role}`);
    const r = await fn(); await c.query('commit'); return r;
  } catch (e) { await c.query('rollback'); throw e; }
}
async function codeOf(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const q1 = async (s, a) => (await c.query(s, a)).rows[0];
const principal = async (pf) => Number((await q1(`select investment_amount a from investor_portfolios where id=$1`, [pf])).a);
const wallet = async (u) => Number((await q1(`select coalesce((select withdrawable from wallets where user_id=$1),0) w`, [u])).w);
const returnLegs = async (pf) => Number((await q1(`select count(*) n from general_ledger where source_id=$1 and direction='cash_in' and category in ('roi_wallet_credit','roi_reinvestment')`, [pf])).n);
const post = (entries, key = null) => c.query(`select public.create_ledger_transaction($1::jsonb, $2, false)`, [JSON.stringify(entries), key]);
let seq = 0; const ref = (p) => `${p}-T${Date.now().toString(36).toUpperCase()}${(seq++).toString(36).toUpperCase()}-AB12`;
const compound = (pf, amt, cycle) => as(COO, () => c.query(`select public.post_portfolio_roi_ledger('compound', $1::uuid, $2, $3, 'out', 'in', $4::date)`, [pf, amt, ref('CMP'), cycle]));
async function requestPayout(pf, amt, cycle) {
  return as(COO, async () => (await c.query(`insert into pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, operation_type, description, status, metadata)
     values ($1,$2,'cash_in','roi_payout','investor_portfolios',$3,$4,'roi_wallet_credit','ROI payout','pending_coo_approval',$5) returning id`, [PARTNER, amt, pf, ref('PAY'), JSON.stringify({ cycle_anchor: cycle })])).rows[0].id);
}
async function approve(opId, amt) {
  await c.query(`update pending_wallet_operations set status='coo_approved' where id=$1`, [opId]);
  const claim = (await q1(`select public.claim_return_cycle_for_operation($1) r`, [opId])).r;
  if (!claim || !claim.ledger_key) return { claim };
  const op = await q1(`select * from pending_wallet_operations where id=$1`, [opId]);
  const entries = [
    { user_id: PARTNER, amount: amt, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet', recipient_type: 'user', wallet_bucket: 'withdrawable', source_table: 'investor_portfolios', source_id: op.source_id, reference_id: op.reference_id },
    { user_id: PARTNER, amount: amt, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: op.source_id }];
  return (await q1(`select public.post_return_payout($1::uuid, $2::jsonb, $3, $4, $5::uuid) r`, [opId, JSON.stringify(entries), claim.ledger_key, amt, CFO])).r;
}
const topupFunding = (pf, amt) => post([
  { user_id: PARTNER, amount: amt, direction: 'cash_out', category: 'partner_funding', ledger_scope: 'wallet', wallet_bucket: 'withdrawable', source_table: 'investor_portfolios', source_id: pf },
  { user_id: PARTNER, amount: amt, direction: 'cash_in', category: 'pending_portfolio_topup', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: pf }]);
const refund = (pf, amt) => post([
  { user_id: PARTNER, amount: amt, direction: 'cash_in', category: 'partner_funding', ledger_scope: 'wallet', wallet_bucket: 'withdrawable', source_table: 'investor_portfolios', source_id: pf },
  { user_id: PARTNER, amount: amt, direction: 'cash_out', category: 'pending_portfolio_topup', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: pf }]);
const withdrawal = (amt) => post([
  { user_id: PARTNER, amount: amt, direction: 'cash_out', category: 'wallet_withdrawal', ledger_scope: 'wallet', wallet_bucket: 'withdrawable', source_table: 'withdrawal_requests', source_id: ID(990 + (seq++ % 9)) },
  { user_id: PARTNER, amount: amt, direction: 'cash_in', category: 'wallet_withdrawal', ledger_scope: 'platform', source_table: 'withdrawal_requests', source_id: ID(990) }]);
async function parkTopup(pf, amt) {   // a funded top-up parked before the hold (seeded with triggers off) plus an approved payout 2 days ago
  await c.query(`set session_replication_role = replica`);
  await c.query(`insert into pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, operation_type, status, reviewed_at, created_at)
     values ($1,100000,'cash_in','roi_payout','investor_portfolios',$2,'roi_wallet_credit','approved', now() - interval '2 days', now() - interval '2 days')`, [PARTNER, pf]);
  await c.query(`insert into pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, operation_type, status, created_at, metadata)
     values ($1,$3,'cash_out','wallet_to_investment','investor_portfolios',$2,'portfolio_topup','approved', now() - interval '3 days', '{"funded": true}')`, [PARTNER, pf, amt]);
  await c.query(`set session_replication_role = origin`);
}
const fp = async () => q1(`select md5(pg_get_functiondef('public.merge_paidout_topups()'::regprocedure)) merge,
   (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid='public.enforce_roi_cycle_once()'::regprocedure) eroc,
   (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid='public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text)'::regprocedure) pprl6,
   to_regprocedure('public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text,date,uuid)') is not null pprl8,
   (select count(*) from pg_trigger where not tgisinternal and tgname in ('trg_zz_portfolio_return_hold','trg_portfolio_return_hold_ledger','trg_aa_portfolio_return_hold_request')) a_trg,
   (select count(*) from pg_trigger where not tgisinternal and tgname in ('trg_guard_portfolio_return_fields','trg_enforce_return_cycle_ledger_key','trg_release_return_cycle_claim')) c_trg`);

async function scenario(order) {
  const tag = `[${order}] `;
  c = await freshDb(`ac_${order.replace(/\W/g, '').toLowerCase()}_${Date.now()}`);
  await c.query(C_STUB); await c.query(EXTRA); await c.query(C_PROD);
  await c.query('CREATE TRIGGER trg_enforce_roi_cycle_once BEFORE INSERT ON public.pending_wallet_operations FOR EACH ROW EXECUTE FUNCTION public.enforce_roi_cycle_once();');
  await c.query(MERGE_PROD);
  const prodFp = await fp();
  const today = (await q1(`select (now() at time zone 'Africa/Kampala')::date::text d`)).d;
  const due = (await q1(`select ((now() at time zone 'Africa/Kampala')::date + 3)::text d`)).d;
  await c.query(`insert into user_roles values ($1,'cfo',true), ($2,'coo',true), ($2,'manager',true)`, [CFO, COO]);
  // Portfolios: F* free, H* held.
  const pfs = { F1: ID(201), F2: ID(202), F3: ID(203), H1: ID(211), H2: ID(212), H3: ID(213), FB: ID(221), HB: ID(222) };
  for (const [k, id] of Object.entries(pfs)) {
    await c.query(`insert into investor_portfolios (id, investor_id, agent_id, portfolio_code, investment_amount, roi_percentage, next_roi_date, payout_day, auto_reinvest)
      values ($1,$2,$2,$3,1000000,15,$4::date,extract(day from $4::date)::int, $5)`, [id, k.startsWith('HB') || k.startsWith('FB') ? P2 : PARTNER, `WIP-${k}`, due, k === 'H3']);
  }
  await post([{ user_id: PARTNER, amount: 5000000, direction: 'cash_in', category: 'wallet_deposit', ledger_scope: 'wallet', wallet_bucket: 'withdrawable', source_table: 'deposit_requests', source_id: ID(980) }]);

  const applyC = async () => c.query(C_MIG), applyA = async () => c.query(A_MIG);
  await test(tag + 'both migrations apply in this order (Option A with its production fingerprint precondition)', async () => {
    if (order === 'C-then-A') { await applyC(); await applyA(); } else { await applyA(); await applyC(); }
    const f = await fp(); ok(f.a_trg == 3 && f.c_trg == 3 && f.pprl8, JSON.stringify(f));
  });
  await test(tag + 'CFO places holds on H1, H2, H3, HB (eight-portfolio list modelled by these)', async () => {
    for (const k of ['H1', 'H2', 'H3', 'HB']) await as(CFO, () => c.query(`select place_portfolio_return_hold($1,$2)`, [pfs[k], REASON]));
    ok(Number((await q1(`select count(*) n from portfolio_return_holds where released_at is null`)).n) === 4, 'holds');
  });

  // ---- Returns
  await test(tag + 'free portfolio: one payout per cycle posts; a second request for the same cycle is refused (guard)', async () => {
    const op = await requestPayout(pfs.F1, 150000, due); const r = await approve(op, 150000);
    ok(r.inserted === true, 'first payout not posted ' + JSON.stringify(r));
    ok(await codeOf(requestPayout(pfs.F1, 150000, due)) === '23505', 'second request not refused');
    ok(await returnLegs(pfs.F1) === 1, 'legs');
  });
  await test(tag + 'free portfolio: compound then cash Return for the same cycle (the 30-case pattern) - cash refused (guard)', async () => {
    await compound(pfs.F2, 150000, due);
    const e = await codeOf(requestPayout(pfs.F2, 150000, due));
    ok(e === '23505', 'cash request after compound not refused: ' + e);
    ok(await returnLegs(pfs.F2) === 1, 'legs');
  });
  await test(tag + 'free portfolio: the same compound twice (double click) - second refused, principal moved once (guard)', async () => {
    const before = await principal(pfs.F3);
    await compound(pfs.F3, 150000, due);
    const e = await codeOf(compound(pfs.F3, 150000, due));
    ok(e !== null, 'second compound accepted');
    ok(await principal(pfs.F3) === before + 150000, 'principal moved twice');
  });
  await test(tag + 'held portfolio: compound refused, no claim left behind, principal unchanged', async () => {
    const before = await principal(pfs.H1);
    ok(await codeOf(compound(pfs.H1, 150000, due)) === '42501', 'not refused');
    ok(await principal(pfs.H1) === before && await returnLegs(pfs.H1) === 0, 'changed');
    ok(Number((await q1(`select count(*) n from portfolio_return_cycle_claims where portfolio_id=$1 and status='active'`, [pfs.H1])).n) === 0, 'claim left');
  });
  await test(tag + 'held portfolio: payout request refused by the hold', async () => {
    ok(await codeOf(requestPayout(pfs.H1, 150000, due)) === '42501', 'not refused');
  });
  await test(tag + 'held portfolio: request queued BEFORE the hold cannot be approved; request stays approvable later, wallet unchanged', async () => {
    await as(CFO, () => c.query(`select release_portfolio_return_hold($1,$2)`, [pfs.H2, 'temporary release to queue a test request']));
    const op = await requestPayout(pfs.H2, 150000, due);
    await as(CFO, () => c.query(`select place_portfolio_return_hold($1,$2)`, [pfs.H2, REASON]));
    const w = await wallet(PARTNER);
    const e = await codeOf(approve(op, 150000));
    ok(e === '42501', 'approval not refused: ' + e);
    ok(await wallet(PARTNER) === w && await returnLegs(pfs.H2) === 0, 'money moved');
    const st = (await q1(`select status from pending_wallet_operations where id=$1`, [op])).status;
    ok(st === 'coo_approved', 'request status changed to ' + st);
  });

  // ---- top-ups, refunds, withdrawals
  await test(tag + 'top-up into a free portfolio: funding legs post; held portfolio: refused, wallet unchanged', async () => {
    await topupFunding(pfs.F1, 200000);
    const w = await wallet(PARTNER);
    ok(await codeOf(topupFunding(pfs.H1, 200000)) === '42501', 'held top-up not refused');
    ok(await wallet(PARTNER) === w, 'wallet moved');
  });
  await test(tag + 'refund of a parked top-up on a held portfolio back to the wallet is allowed', async () => {
    const w = await wallet(PARTNER); await refund(pfs.H1, 50000); ok(await wallet(PARTNER) === w + 50000, 'refund failed');
  });
  await test(tag + 'withdrawal from the wallet of a partner whose portfolio is held is allowed', async () => {
    const w = await wallet(PARTNER); await withdrawal(100000); ok(await wallet(PARTNER) === w - 100000, 'withdrawal failed');
  });
  await test(tag + 'daily merge job: held portfolio skipped, free portfolio merged, job does not fail', async () => {
    await parkTopup(pfs.FB, 300000); await parkTopup(pfs.HB, 300000);
    const hb = await principal(pfs.HB), fb = await principal(pfs.FB);
    const r = (await q1(`select merge_paidout_topups() r`)).r;
    ok(await principal(pfs.FB) === fb + 300000 && await principal(pfs.HB) === hb, JSON.stringify(r));
  });

  // ---- failed jobs and side effects
  await test(tag + 'renewal / redemption-style backend update on held portfolio refused (job must log and continue)', async () => {
    ok(await codeOf(c.query(`update investor_portfolios set next_roi_date = next_roi_date + 30, duration_months = 24 where id=$1`, [pfs.H1])) === '42501', 'not refused');
  });
  await test(tag + 'RISK: rent-reward auto-reinvest into a held portfolio leaves a "reinvested" payment row with no posting', async () => {
    // process-supporter-roi: inserts the payment row (own statement), then updates the portfolio, then posts.
    await c.query(`insert into supporter_roi_payments (rent_request_id, supporter_id, roi_amount, payment_number, status) values ($1,$2,50000,1,'reinvested')`, [ID(970), PARTNER]);
    const u = await codeOf(c.query(`update investor_portfolios set investment_amount = investment_amount + 50000 where id=$1`, [pfs.H3]));
    const l = await codeOf(post([{ user_id: PARTNER, amount: 50000, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform', source_table: 'supporter_roi_payments', source_id: ID(970) },
      { user_id: PARTNER, amount: 50000, direction: 'cash_in', category: 'roi_reinvestment', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: pfs.H3, linked_party: 'platform' }]));
    const row = await q1(`select status from supporter_roi_payments where rent_request_id=$1`, [ID(970)]);
    ok(u === '42501' && l === '42501' && row.status === 'reinvested', `update ${u} ledger ${l} row ${row && row.status}`);
  });
  await test(tag + 'rent-reward auto-reinvest into a FREE portfolio still works with both options (guard accepts the payment row)', async () => {
    await c.query(`insert into supporter_roi_payments (rent_request_id, supporter_id, roi_amount, payment_number, status) values ($1,$2,60000,1,'reinvested')`, [ID(971), PARTNER]);
    const before = await principal(pfs.F3);
    await c.query(`update investor_portfolios set investment_amount = investment_amount + 60000 where id=$1`, [pfs.F3]);
    await post([{ user_id: PARTNER, amount: 60000, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform', source_table: 'supporter_roi_payments', source_id: ID(971) },
      { user_id: PARTNER, amount: 60000, direction: 'cash_in', category: 'roi_reinvestment', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: pfs.F3, linked_party: 'platform' }]);
    ok(await principal(pfs.F3) === before + 60000, 'not applied');
  });
  await test(tag + 'partner-level bulk edit (rate / mode / payout day for all a partner\'s portfolios): held row refused, others updated', async () => {
    const res = [];
    for (const id of [pfs.F1, pfs.H1]) res.push(await codeOf(as(COO, () => c.query(`update investor_portfolios set payout_day = 9 where id=$1`, [id]), 'authenticated')));
    ok(res[0] === null && res[1] === '42501', JSON.stringify(res));
  });
  await test(tag + 'explicit staff principal edit with edit token: free portfolio allowed, held refused; old screen without token refused (guard)', async () => {
    const a = await codeOf(as(COO, () => c.query(`update investor_portfolios set investment_amount = investment_amount + 1, return_fields_edit_token = gen_random_uuid() where id=$1`, [pfs.F1]), 'authenticated'));
    const b = await codeOf(as(COO, () => c.query(`update investor_portfolios set investment_amount = investment_amount + 1, return_fields_edit_token = gen_random_uuid() where id=$1`, [pfs.H1]), 'authenticated'));
    const d = await codeOf(as(COO, () => c.query(`update investor_portfolios set investment_amount = investment_amount + 1 where id=$1`, [pfs.F1]), 'authenticated'));
    ok(a === null && b === '42501' && d === '42501', JSON.stringify({ a, b, d }));
  });
  await test(tag + 'release: CFO releases H1; compound for the cycle then posts once (guard still applies)', async () => {
    await as(CFO, () => c.query(`select release_portfolio_return_hold($1,$2)`, [pfs.H1, 'Evidence reviewed; releasing the test hold']));
    await compound(pfs.H1, 150000, due);
    ok(await codeOf(compound(pfs.H1, 150000, due)) !== null, 'second compound accepted');
    ok(await returnLegs(pfs.H1) === 1, 'legs');
  });

  // ---- rollback, both orders
  const firstRb = order === 'C-then-A' ? 'A' : 'C';
  await test(tag + `rollback ${firstRb} first: the other option keeps working`, async () => {
    if (firstRb === 'A') {
      await c.query(A_RB);
      ok((await fp()).merge === prodFp.merge, 'merge not restored');
      ok(await codeOf(requestPayout(pfs.F1, 150000, due)) === '23505', 'guard stopped working');
      ok(await codeOf(compound(pfs.H3, 150000, due)) === null, 'H3 still blocked after A rollback');
      ok(await codeOf(compound(pfs.H2, 150000, due)) === '23505', 'H2: its earlier reserved request for this cycle should still block a compound (guard)');
    } else {
      await c.query(C_RB);
      const f = await fp(); ok(f.eroc === prodFp.eroc && f.pprl6 === prodFp.pprl6 && !f.pprl8, 'C functions not restored ' + JSON.stringify(f));
      ok(await codeOf(as(COO, () => c.query(`select post_portfolio_roi_ledger('compound', $1::uuid, 150000, $2, 'out', 'in')`, [pfs.H2, ref('CMP')]))) === '42501', 'hold stopped working after C rollback');
    }
  });
  await test(tag + 'rollback the second: production function state restored; holds and reservations kept as records', async () => {
    if (firstRb === 'A') await c.query(C_RB); else await c.query(A_RB);
    const f = await fp();
    ok(f.merge === prodFp.merge && f.eroc === prodFp.eroc && f.pprl6 === prodFp.pprl6 && !f.pprl8 && f.a_trg == 0 && f.c_trg == 0, JSON.stringify({ f, prodFp }));
    const k = await q1(`select to_regclass('public.portfolio_return_holds') is not null h, to_regclass('public.portfolio_return_cycle_claims') is not null c`);
    ok(k.h && k.c, 'record tables dropped');
  });
  await test(tag + 'after full rollback: a month paid while the guard was live cannot be requested again (compat check)', async () => {
    const e = await codeOf(requestPayout(pfs.F1, 150000, due));
    ok(e !== null, 'duplicate request accepted after rollback');
  });
  await c.end();
}

try {
  await scenario('C-then-A');
  await scenario('A-then-C');
} finally {
  await epg.stop();
  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`COMBINED-AC ${results.length - failed}/${results.length} passed`);
}
