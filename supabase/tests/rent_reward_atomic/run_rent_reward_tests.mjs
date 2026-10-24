// Rent-facilitation reward atomic posting (migration 20261024170000) — regression tests on a THROWAWAY local Postgres.
// Runs together with the Return-cycle guard (20261024140000) and the portfolio Return hold (20261024160000), so the
// reward posting is proven against the ledger rules and holds it will meet in production.
//   node run_rent_reward_tests.mjs <rent-reward worktree> <guard worktree> <hold worktree>
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [RR, GUARD, HOLD] = process.argv.slice(2);
if (!HOLD) throw new Error('usage: node run_rent_reward_tests.mjs <rent-reward worktree> <guard worktree> <hold worktree>');
const rd = (root, p) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n');
const RR_MIG = rd(RR, 'supabase/migrations/20261024170000_rent_reward_atomic_post.sql');
const RR_RB = rd(RR, 'supabase/rollbacks/20261024170000_rent_reward_atomic_post.rollback.sql');
const C_MIG = rd(GUARD, 'supabase/migrations/20261024140000_return_cycle_guard.sql').replace(/DO \$pre\$[\s\S]*?\$pre\$;/, '');
const C_RB = rd(GUARD, 'supabase/rollbacks/20261024140000_return_cycle_guard.rollback.sql');
const C_STUB = rd(GUARD, 'supabase/tests/return_cycle_guard/00_stub_schema.sql');
const C_PROD = C_RB.slice(C_RB.indexOf('CREATE OR REPLACE FUNCTION public.enforce_roi_cycle_once()'),
  C_RB.indexOf('DROP FUNCTION IF EXISTS public.post_portfolio_roi_ledger(text, uuid, numeric, text, text, text, date, uuid);'));
const A_MIG = rd(HOLD, 'supabase/migrations/20261024160000_portfolio_return_hold.sql');
const A_RB = rd(HOLD, 'supabase/rollbacks/20261024160000_portfolio_return_hold.rollback.sql');
const MERGE_PROD = A_RB.slice(A_RB.indexOf('CREATE OR REPLACE FUNCTION public.merge_paidout_topups()'), A_RB.indexOf(';', A_RB.lastIndexOf('$function$')) + 1);
// Production columns the stubs omit. supporter_roi_payments in production has NO unique (rent request, payment number).
const EXTRA = `
ALTER TABLE public.investor_portfolios ADD COLUMN agent_id uuid, ADD COLUMN account_name text, ADD COLUMN roi_mode text DEFAULT 'monthly_payout',
  ADD COLUMN duration_months integer DEFAULT 12, ADD COLUMN maturity_date date, ADD COLUMN auto_reinvest boolean DEFAULT false;
CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text, message text, type text, metadata jsonb);
CREATE FUNCTION public.topup_op_is_funded(p_status text, p_metadata jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
ALTER TABLE public.supporter_roi_payments DROP CONSTRAINT IF EXISTS supporter_roi_payments_rent_request_id_payment_number_key;
ALTER TABLE public.supporter_roi_payments ADD COLUMN rent_amount numeric, ADD COLUMN due_date timestamptz, ADD COLUMN paid_at timestamptz,
  ADD COLUMN created_at timestamptz DEFAULT now();
ALTER TABLE public.supporter_roi_payments ALTER COLUMN status SET DEFAULT 'pending';
CREATE TABLE public.rent_requests (id uuid PRIMARY KEY, supporter_id uuid, rent_amount numeric, funded_at timestamptz, status text,
  next_roi_due_date timestamptz, total_roi_paid numeric DEFAULT 0, roi_payments_count integer DEFAULT 0);
ALTER TABLE public.supporter_roi_payments ADD CONSTRAINT supporter_roi_payments_rent_request_id_fkey FOREIGN KEY (rent_request_id) REFERENCES public.rent_requests(id);
GRANT SELECT ON public.rent_requests, public.supporter_roi_payments TO authenticated;
`;

const ID = (n) => `0f0a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CFO = ID(1), COO = ID(2), SUP = ID(3), OTHER = ID(4);
const REASON = 'Investigation of duplicate Returns and unsupported principal edits';

const port = 59500 + Math.floor(Math.random() * 300);
const epg = new EmbeddedPostgres({ databaseDir: `./pgrr-${Date.now()}`, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {} });
await epg.initialise(); await epg.start();
const conn = async (db) => { const cl = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'pw', database: db }); await cl.connect(); return cl; };
const a0 = await conn('postgres'); const DB = `rr_test_${Date.now()}`;
await a0.query(`create database ${DB} encoding 'UTF8' template template0 lc_collate 'C' lc_ctype 'C'`); await a0.end();
const c = await conn(DB), c2 = await conn(DB);

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
  finally { await c.query('rollback').catch(() => {}); await c2.query('rollback').catch(() => {}); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
async function codeOf(p) { try { await p; return null; } catch (e) { return e.message; } }
const q1 = async (s, a, cl = c) => (await cl.query(s, a)).rows[0];
// Calls as the edge function does: service role.
async function postReward(rr, n, pf = null, cl = c) {
  await cl.query('begin'); await cl.query('set local role service_role');
  try { const r = (await cl.query(`select public.post_rent_facilitation_reward($1, $2, $3, null) r`, [rr, n, pf])).rows[0].r; await cl.query('commit'); return r; }
  catch (e) { await cl.query('rollback'); throw e; }
}
const state = async (rr, pf) => q1(`select (select count(*) from supporter_roi_payments where rent_request_id=$1)::int rows,
   (select count(*) from general_ledger where source_table='supporter_roi_payments' and source_id=$1)::int exp_legs,
   (select count(*) from general_ledger where category in ('roi_wallet_credit','roi_reinvestment') and (source_id=$1 or source_id=$2))::int ret_legs,
   (select roi_payments_count from rent_requests where id=$1) cnt, (select total_roi_paid from rent_requests where id=$1)::numeric paid,
   (select investment_amount from investor_portfolios where id=$2)::numeric principal,
   coalesce((select withdrawable from wallets where user_id=$3),0)::numeric wallet`, [rr, pf ?? ID(999), SUP]);
let rrSeq = 300;
async function newRequest({ count = 0, due = "now() - interval '1 day'", rent = 450000 } = {}) {
  const id = ID(rrSeq++);
  await c.query(`insert into rent_requests values ($1,$2,$3, now() - interval '90 days','funded', ${due}, 0, $4)`, [id, SUP, rent, count]);
  return id;
}
async function newPortfolio(owner = SUP, status = 'active') {
  const id = ID(rrSeq++);
  await c.query(`insert into investor_portfolios (id, investor_id, agent_id, portfolio_code, investment_amount, roi_percentage, next_roi_date, status, auto_reinvest)
    values ($1,$2,$2,$3,1000000,15,current_date + 20,$4,true)`, [id, owner, `WIP-RR${rrSeq}`, status]);
  return id;
}

try {
  await c.query(C_STUB); await c.query(EXTRA); await c.query(C_PROD);
  await c.query('CREATE TRIGGER trg_enforce_roi_cycle_once BEFORE INSERT ON public.pending_wallet_operations FOR EACH ROW EXECUTE FUNCTION public.enforce_roi_cycle_once();');
  await c.query(MERGE_PROD);
  await c.query(`insert into user_roles values ($1,'cfo',true), ($2,'coo',true)`, [CFO, COO]);
  await c.query(C_MIG); await c.query(A_MIG);

  await test('migration applies on top of guard + hold (precondition passes, unique index created)', async () => {
    await c.query(RR_MIG);
    const r = await q1(`select to_regclass('public.supporter_roi_payments_rent_request_payment_uniq') i`); ok(r.i, 'no index');
  });

  await test('wallet reward: one paid row, balanced legs, wallet +15%, schedule advanced — guard accepts it', async () => {
    const rr = await newRequest(); const b = await state(rr);
    const r = await postReward(rr, 1); ok(r.status === 'posted' && Number(r.amount) === 67500, JSON.stringify(r));
    const a = await state(rr);
    ok(a.rows === 1 && a.exp_legs === 2 && a.ret_legs === 1 && a.cnt === 1 && Number(a.paid) === 67500 && Number(a.wallet) === Number(b.wallet) + 67500, JSON.stringify(a));
  });

  await test('reinvest reward: one reinvested row, principal +15%, ledger posted, schedule advanced — guard accepts it', async () => {
    const rr = await newRequest(); const pf = await newPortfolio();
    const r = await postReward(rr, 1, pf); ok(r.status === 'posted' && Number(r.new_principal) === 1067500, JSON.stringify(r));
    const a = await state(rr, pf); ok(a.rows === 1 && Number(a.principal) === 1067500 && a.ret_legs === 1 && a.cnt === 1, JSON.stringify(a));
    ok((await q1(`select status from supporter_roi_payments where rent_request_id=$1`, [rr])).status === 'reinvested', 'status');
  });

  await test('HELD portfolio: reinvest refused, NOTHING recorded (no row, no legs, principal and schedule unchanged)', async () => {
    const rr = await newRequest(); const pf = await newPortfolio();
    await c.query('begin'); await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [CFO]); await c.query(`select place_portfolio_return_hold($1,$2)`, [pf, REASON]); await c.query('commit');
    const b = await state(rr, pf);
    const e = await codeOf(postReward(rr, 1, pf)); ok(e && e.includes('PORTFOLIO_ON_HOLD'), e);
    const a = await state(rr, pf); ok(JSON.stringify(a) === JSON.stringify(b), JSON.stringify({ b, a }));
    // retry while still held: still nothing
    ok((await codeOf(postReward(rr, 1, pf))).includes('PORTFOLIO_ON_HOLD'), 'second attempt');
    ok((await state(rr, pf)).rows === 0, 'row created');
    // release -> the SAME payment number posts exactly once
    await c.query('begin'); await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [CFO]); await c.query(`select release_portfolio_return_hold($1,'Evidence reviewed, releasing test hold')`, [pf]); await c.query('commit');
    const r = await postReward(rr, 1, pf); ok(r.status === 'posted', JSON.stringify(r));
    const f = await state(rr, pf); ok(f.rows === 1 && f.cnt === 1 && Number(f.principal) === Number(b.principal) + 67500, JSON.stringify(f));
  });

  await test('reinvest target not the supporter\'s / not active: refused, nothing recorded', async () => {
    const rr = await newRequest();
    const foreign = await newPortfolio(OTHER); const closed = await newPortfolio(SUP, 'redeemed');
    for (const pf of [foreign, closed, ID(888)]) {
      const e = await codeOf(postReward(rr, 1, pf)); ok(e && e.includes('RENT_REWARD_REINVEST_TARGET_UNAVAILABLE'), e);
    }
    ok((await state(rr)).rows === 0, 'row recorded');
  });

  await test('ledger failure mid-transaction: nothing recorded; retry after the fault clears posts once', async () => {
    const rr = await newRequest();
    await c.query(`create function public.t_fail() returns trigger language plpgsql as $$ begin raise exception 'simulated ledger outage'; end $$;
                   create trigger zz_t_fail before insert on public.general_ledger for each row when (new.source_id = '${rr}') execute function public.t_fail();`);
    const e = await codeOf(postReward(rr, 1)); ok(e && e.includes('simulated ledger outage'), e);
    const a = await state(rr); ok(a.rows === 0 && a.exp_legs === 0 && a.cnt === 0, JSON.stringify(a));
    await c.query(`drop trigger zz_t_fail on public.general_ledger; drop function public.t_fail();`);
    ok((await postReward(rr, 1)).status === 'posted', 'retry failed');
    const f = await state(rr); ok(f.rows === 1 && f.exp_legs === 2, JSON.stringify(f));
  });

  await test('retry of a posted payment: already_posted, no second row or posting', async () => {
    const rr = await newRequest(); await postReward(rr, 1);
    const r = await postReward(rr, 1); ok(r.status === 'already_posted', JSON.stringify(r));
    const a = await state(rr); ok(a.rows === 1 && a.exp_legs === 2, JSON.stringify(a));
  });

  await test('two overlapping runs for the same reward: exactly one posts', async () => {
    const rr = await newRequest();
    await c2.query('begin');
    await c2.query(`select 1 from rent_requests where id=$1 for update`, [rr]);         // run 2 holds the request
    await c2.query('set local role service_role');
    const p1 = postReward(rr, 1);                                                       // run 1 waits
    await new Promise((r) => setTimeout(r, 300));
    const r2 = (await c2.query(`select public.post_rent_facilitation_reward($1, 1, null, null) r`, [rr])).rows[0].r;
    await c2.query('commit');
    const r1 = await p1;
    const statuses = [r1.status, r2.status].sort();
    ok(JSON.stringify(statuses) === JSON.stringify(['already_posted', 'posted']), JSON.stringify(statuses));
    const a = await state(rr); ok(a.rows === 1 && a.exp_legs === 2 && a.cnt === 1, JSON.stringify(a));
  });

  await test('not yet due: not_due, nothing recorded', async () => {
    const rr = await newRequest({ due: "now() + interval '5 days'" });
    ok((await postReward(rr, 1)).status === 'not_due', 'not refused'); ok((await state(rr)).rows === 0, 'row');
  });

  await test('stale or skipped payment number refused; earlier number reports already_posted', async () => {
    const rr = await newRequest({ count: 3 });
    ok((await codeOf(postReward(rr, 5))).includes('RENT_REWARD_STALE'), 'skip ahead accepted');
    ok((await postReward(rr, 2)).status === 'already_posted', 'old number');
  });

  await test('row left by the OLD flow (schedule not advanced): never posted over; listed in the gaps report', async () => {
    const rr = await newRequest({ count: 2 });
    await c.query(`insert into supporter_roi_payments (rent_request_id, supporter_id, roi_amount, payment_number, status, rent_amount) values ($1,$2,67500,3,'paid',450000)`, [rr, SUP]);
    const r = await postReward(rr, 3); ok(r.status === 'recorded_without_schedule', JSON.stringify(r));
    ok((await state(rr)).exp_legs === 0, 'posted over legacy row');
    const g = await q1(`select * from rent_reward_posting_gaps() where rent_request_id=$1`, [rr]);
    ok(g && Number(g.rows_without_posting) === 1, JSON.stringify(g));
  });

  await test('access: browser roles cannot post; gaps report is CFO-approver only', async () => {
    const g = await q1(`select has_function_privilege('authenticated','public.post_rent_facilitation_reward(uuid,integer,uuid,text)','EXECUTE') a,
                               has_function_privilege('anon','public.post_rent_facilitation_reward(uuid,integer,uuid,text)','EXECUTE') b,
                               has_function_privilege('service_role','public.post_rent_facilitation_reward(uuid,integer,uuid,text)','EXECUTE') s`);
    ok(!g.a && !g.b && g.s, JSON.stringify(g));
    await c.query('begin'); await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [COO]); await c.query('set local role authenticated');
    const e = await codeOf(c.query(`select * from rent_reward_posting_gaps()`)); await c.query('rollback');
    ok(e && e.includes('Only the CFO approver'), e);
    await c.query('begin'); await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [CFO]); await c.query('set local role authenticated');
    await c.query(`select * from rent_reward_posting_gaps()`); await c.query('rollback');
  });

  await test('the unique index refuses a second row for the same reward from any path', async () => {
    const rr = await newRequest(); await postReward(rr, 1);
    const e = await codeOf(c.query(`insert into supporter_roi_payments (rent_request_id, supporter_id, roi_amount, payment_number, status) values ($1,$2,67500,1,'paid')`, [rr, SUP]));
    ok(e && e.includes('supporter_roi_payments_rent_request_payment_uniq'), e);
  });

  await test('rollback removes the functions and index; posted rows and ledger stay', async () => {
    const before = await q1(`select (select count(*) from supporter_roi_payments)::int r, (select count(*) from general_ledger)::int g`);
    await c.query(RR_RB);
    const a = await q1(`select to_regproc('public.post_rent_facilitation_reward') f, to_regclass('public.supporter_roi_payments_rent_request_payment_uniq') i,
                          (select count(*) from supporter_roi_payments)::int r, (select count(*) from general_ledger)::int g`);
    ok(!a.f && !a.i && a.r === before.r && a.g === before.g, JSON.stringify({ before, a }));
    await c.query(RR_MIG);   // re-apply cleanly after rollback
  });
} finally {
  await c.end(); await c2.end(); await epg.stop();
  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`RENT-REWARD-TESTS ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
