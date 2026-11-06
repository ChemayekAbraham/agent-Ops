// Run: node scripts/test-partner-commission-payables.mjs   (needs @electric-sql/pglite; exit code 1 on any failure)
// Executes the firm view and the contingent function from
// supabase/migrations/20261026120000_partner_commission_payables_v2.sql against an embedded Postgres (PGlite)
// with minimal stand-in tables. The helpers they call (earner resolver, prior-fund-in test, rate lookups,
// payables guard) are loaded verbatim from production via scripts/fixtures/partner-commission-helpers.sql.
import fs from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const MIGRATION = fs.readFileSync(here('../supabase/migrations/20261026120000_partner_commission_payables_v2.sql'), 'utf8');
const HELPERS = fs.readFileSync(here('./fixtures/partner-commission-helpers.sql'), 'utf8');
const between = (text, start, end) => {
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`marker missing: ${start}`);
  return text.slice(a + start.length, b);
};

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

await db.exec(`
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table user_roles (user_id uuid, role text);
create function has_role(uuid, text) returns boolean language sql stable as $$ select exists (select 1 from user_roles where user_id = $1 and role = $2) $$;

create table profiles (id uuid primary key, full_name text, phone text, email text, is_frozen boolean default false);
create table promissory_notes (id uuid primary key, agent_id uuid, partner_name text, whatsapp_number text, phone_number text,
  email text, partner_user_id uuid, status text default 'activated', approved_at timestamptz, approval_bonus_paid boolean default true,
  created_at timestamptz default now());
create table pso_note_reversals (note_id uuid);
create table proxy_agent_assignments (id uuid primary key, agent_id uuid, beneficiary_id uuid, is_active boolean default true,
  is_managed_account boolean default true, approval_status text default 'approved', created_at timestamptz, expires_at timestamptz);
create table commission_fund_ins (id uuid primary key, partner_id uuid, fund_in_key text unique, amount numeric, occurred_at timestamptz,
  status text, created_at timestamptz default now(), earner_id uuid, earner_path text, note_id uuid, assignment_id uuid,
  attempts integer default 0, last_attempt_at timestamptz);
create table investor_portfolios (id uuid primary key, investor_id uuid, status text, locked_from_portfolio_id uuid, investment_amount numeric, created_at timestamptz);
create table portfolio_renewals (portfolio_id uuid, old_created_at timestamptz);
create table partner_self_commitments (id uuid primary key, partner_id uuid, status text, created_at timestamptz);
create table hr_pay_staff_reinvestments (portfolio_id uuid);
create table promissory_commission_rates (kind text, rate numeric, effective_from timestamptz);
create table partner_note_rates (payee_role text, amount numeric, effective_from timestamptz);
create table commission_gate_settings (id boolean primary key, cutover_at timestamptz);
create table pending_wallet_operations (id uuid primary key, created_at timestamptz);
create table general_ledger (idempotency_key text, ledger_scope text, direction text, amount numeric);
create table proxy_commission_queue (source_id uuid, status text);
create table promissory_commission_events (source_id uuid, status text);
create table partner_note_reversals (note_id uuid, payee_role text);
create table partner_note_overrides (id uuid primary key default gen_random_uuid(), note_id uuid unique, lead_user_id uuid, status text, ledger_group_id uuid);
create table partner_lead_assignments (agent_id uuid, lead_user_id uuid, attached_at timestamptz, detached_at timestamptz);
create table audit_logs (table_name text, record_id text, action text, metadata jsonb);
create table hr_staff (id uuid primary key, user_id uuid, ended_on date);
create table hr_positions (id uuid primary key, key text, title text);
create table hr_assignments (staff_id uuid, position_id uuid, started_on date, ended_on date);
create table commission_fund_in_candidates (id uuid primary key, partner_id uuid, amount numeric, observed_at timestamptz, state text);

insert into promissory_commission_rates values ('portfolio_creation', 0.02, '2026-01-01'), ('portfolio_topup', 0.01, '2026-01-01');
insert into partner_note_rates values ('agent', 1500, '2026-01-01'), ('lead', 1000, '2026-08-06');
insert into commission_gate_settings values (true, '2026-10-02 11:07:07+00');
`);
await db.exec('set check_function_bodies = off;\n' + HELPERS + '\nset check_function_bodies = on;');
await db.exec(between(MIGRATION, '-- BEGIN FIRM VIEW', '-- END FIRM VIEW'));
await db.exec(between(MIGRATION, '-- BEGIN CONTINGENT FUNCTION', '-- END CONTINGENT FUNCTION'));

// ---- fixtures -------------------------------------------------------------------------------------------
const person = async (name, extra = {}) => {
  const id = uuid();
  await db.query('insert into profiles (id, full_name, phone, email, is_frozen) values ($1,$2,$3,$4,$5)',
    [id, name, extra.phone ?? null, extra.email ?? null, extra.frozen ?? false]);
  return id;
};
const note = async (agent, partner, approvedAt, extra = {}) => {
  const id = uuid();
  await db.query(`insert into promissory_notes (id, agent_id, partner_user_id, partner_name, status, approved_at, approval_bonus_paid, created_at)
                  values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, agent, partner, extra.partnerName ?? 'Partner Name', extra.status ?? 'activated', approvedAt, extra.flag ?? true, extra.createdAt ?? '2026-08-01']);
  return id;
};
const fundIn = async (partner, key, amount, at, status = 'unattributed') => {
  const id = uuid();
  await db.query('insert into commission_fund_ins (id, partner_id, fund_in_key, amount, occurred_at, status) values ($1,$2,$3,$4,$5,$6)',
    [id, partner, key, amount, at, status]);
  return id;
};
const credit = (key) => db.query(`insert into general_ledger values ($1, 'wallet', 'cash_in', 1)`, [key]);
const firm = async () => rows('select * from v_partner_commission_payable_lines');
const lineFor = (all, itemId, product) => all.filter((l) => l.item_id === itemId && (!product || l.product_key === product));
const contingent = async (asUser) => {
  await db.query(`select set_config('test.uid', $1, false)`, [asUser ?? '']);
  return rows('select * from get_partner_commission_contingent()');
};

// ---- fund-in commissions ----------------------------------------------------------------------------------
const noteAgent = await person('Note Agent');
const pA = await person('Partner A');                       // promissory-note earner
await note(noteAgent, pA, '2026-09-01');
const fA1 = await fundIn(pA, 'pf:' + uuid(), 1_000_000, '2026-10-03');            // first fund-in -> 2%
const fA2 = await fundIn(pA, 'pf:' + uuid(), 500_000, '2026-10-10');              // later -> 1%

const proxyAgent = await person('Proxy Agent');
const pB = await person('Partner B');                       // managed-proxy earner
await db.query(`insert into proxy_agent_assignments (id, agent_id, beneficiary_id, created_at) values ($1,$2,$3,'2026-09-01')`, [uuid(), proxyAgent, pB]);
const fB1 = await fundIn(pB, 'pf:' + uuid(), 2_000_000, '2026-10-04');

const pC = await person('Partner C');                       // earner identified after the 60-day window
const fC1 = await fundIn(pC, 'pf:' + uuid(), 3_000_000, '2026-07-01', 'no_earner');
const lateAgent = await person('Late Agent');
await note(lateAgent, pC, '2026-10-20');                    // note approved late: earner now resolves

const pD = await person('Partner D');                       // no earner at all -> contingent only
const fD1 = await fundIn(pD, 'pf:' + uuid(), 4_000_000, '2026-10-05');

const frozenAgent = await person('Frozen Agent', { frozen: true });
const pE = await person('Partner E');                       // earner frozen -> contingent only
await note(frozenAgent, pE, '2026-09-01');
const fE1 = await fundIn(pE, 'pf:' + uuid(), 1_000_000, '2026-10-06');

const pF = await person('Partner F');                       // settled (gate credit exists) -> excluded
await note(noteAgent, pF, '2026-09-01');
const kF = 'pf:' + uuid();
const fF1 = await fundIn(pF, kF, 1_000_000, '2026-10-06');
await credit('fund_in_commission:' + kF);

const pG = await person('Partner G');                       // paid by the pre-gate queue -> excluded
await note(noteAgent, pG, '2026-09-01');
const srcG = uuid();
const fG1 = await fundIn(pG, 'pf:' + srcG, 1_000_000, '2026-10-02 08:00+00');
await db.query(`insert into proxy_commission_queue values ($1, 'paid')`, [srcG]);

const pH = await person('Partner H');                       // pre-gate top-up -> excluded
await note(noteAgent, pH, '2026-09-01');
const pwoH = uuid();
await db.query(`insert into pending_wallet_operations values ($1, '2026-10-01')`, [pwoH]);
const fH1 = await fundIn(pH, 'pwo:' + pwoH, 1_000_000, '2026-10-03');

const pI = await person('Partner I');                       // not_commissionable -> excluded
await note(noteAgent, pI, '2026-09-01');
const fI1 = await fundIn(pI, 'pf:' + uuid(), 1_000_000, '2026-10-03', 'not_commissionable');

const pJ = await person('Partner J');                       // two fund-ins at the same instant: one 2%, one 1%
await note(noteAgent, pJ, '2026-09-01');
const fJ1 = await fundIn(pJ, 'pf:00000000-0000-0000-0000-00000000000a', 1_000_000, '2026-10-07 09:00+00');
const fJ2 = await fundIn(pJ, 'pf:00000000-0000-0000-0000-00000000000b', 1_000_000, '2026-10-07 09:00+00');

const pK = await person('Partner K');                       // first fund-in already paid; open top-up -> 1%
await note(noteAgent, pK, '2026-09-01');
const kK1 = 'pf:' + uuid();
await db.query(`insert into commission_fund_ins (id, partner_id, fund_in_key, amount, occurred_at, status, earner_id, earner_path)
                values ($1,$2,$3,1000000,'2026-10-03','paid',$4,'promissory_note')`, [uuid(), pK, kK1, noteAgent]);
await credit('fund_in_commission:' + kK1);
const fK2 = await fundIn(pK, 'pf:' + uuid(), 800_000, '2026-10-12');

// The hourly job keeps 'unattributed' rows current: a row it checked in the last 90 minutes is not re-resolved
// (contingent until the next run); a row whose last check is older is re-resolved here.
const pL = await person('Partner L');
await note(noteAgent, pL, '2026-09-01');
const fLrecent = await fundIn(pL, 'pf:' + uuid(), 1_000_000, '2026-10-08');
await db.query(`update commission_fund_ins set attempts = 5, last_attempt_at = now() - interval '30 minutes' where id = $1`, [fLrecent]);
const pM = await person('Partner M');
await note(noteAgent, pM, '2026-09-01');
const fMstale = await fundIn(pM, 'pf:' + uuid(), 1_000_000, '2026-10-08');
await db.query(`update commission_fund_ins set attempts = 5, last_attempt_at = now() - interval '3 hours' where id = $1`, [fMstale]);

const candId = uuid();                                      // awaiting CFO review -> contingent only
await db.query(`insert into commission_fund_in_candidates values ($1,$2,700000,'2026-10-15','needs_review')`, [candId, pD]);

let all = await firm();
const one = (id) => lineFor(all, id);
ok(one(fA1).length === 1 && one(fA1)[0].product_key === 'proxy_note_fulfilment_commission' && Number(one(fA1)[0].outstanding_amount) === 20000,
  'first fund-in, note earner: firm 2% line (20,000)');
ok(one(fA2).length === 1 && one(fA2)[0].product_key === 'proxy_note_topup_commission' && Number(one(fA2)[0].outstanding_amount) === 5000,
  'later fund-in: firm 1% line (5,000)');
ok(one(fB1).length === 1 && one(fB1)[0].counterparty_id === proxyAgent && Number(one(fB1)[0].outstanding_amount) === 40000,
  'managed-proxy earner: firm 2% line to the proxy agent (40,000)');
ok(one(fC1).length === 1 && one(fC1)[0].status === 'earner_identified_late' && one(fC1)[0].counterparty_id === lateAgent && Number(one(fC1)[0].outstanding_amount) === 60000,
  "past the 60-day window ('no_earner'), earner identified late: still firm (60,000)");
ok(one(fD1).length === 0, 'no identifiable earner: not firm');
ok(one(fE1).length === 0, 'frozen earner: not firm');
ok(one(fF1).length === 0, 'commission already credited (gate key): excluded');
ok(one(fG1).length === 0, 'commission paid by the pre-gate queue: excluded');
ok(one(fH1).length === 0, 'pre-gate top-up: excluded');
ok(one(fI1).length === 0, "'not_commissionable': excluded");
const j = [...one(fJ1), ...one(fJ2)].map((l) => l.product_key).sort();
ok(j.length === 2 && j[0] === 'proxy_note_fulfilment_commission' && j[1] === 'proxy_note_topup_commission',
  'equal-time fund-ins: exactly one first-fund-in (2%) line, the other 1%');
ok(one(fK2).length === 1 && one(fK2)[0].product_key === 'proxy_note_topup_commission' && one(fK2)[0].counterparty_id === noteAgent,
  'open top-up after a paid first fund-in: 1% to the locked earner');

ok(one(fLrecent).length === 0, 'row the hourly job checked 30 minutes ago: not re-resolved, not firm');
ok(one(fMstale).length === 1 && Number(one(fMstale)[0].outstanding_amount) === 20000, 'row last checked 3 hours ago: re-resolved, firm');

// settle the late commission: it must drop out
await credit('fund_in_commission:' + (await rows('select fund_in_key from commission_fund_ins where id = $1', [fC1]))[0].fund_in_key);
all = await firm();
ok(lineFor(all, fC1).length === 0, 'late commission disappears once its credit exists (settled vs unsettled)');

// contingent: guard + contents, and never overlapping the firm set
let refused = false;
try { await contingent(null); } catch { refused = true; }
ok(refused, 'contingent list refuses a caller without a finance role');
const cfo = uuid();
await db.query(`insert into user_roles values ($1, 'cfo')`, [cfo]);
const cont = await contingent(cfo);
const cIds = new Set(cont.map((c) => c.item_id));
ok(cIds.has(fD1) && cont.find((c) => c.item_id === fD1).reason === 'no_earner_identified' && Number(cont.find((c) => c.item_id === fD1).potential_commission) === 80000,
  'contingent: fund-in with no earner (potential 80,000)');
ok(cIds.has(fE1) && cont.find((c) => c.item_id === fE1).reason === 'earner_frozen', 'contingent: fund-in with a frozen earner');
ok(cIds.has(candId) && cont.find((c) => c.item_id === candId).reason === 'awaiting_cfo_review', 'contingent: candidate awaiting CFO review');
ok(!cIds.has(fF1) && !cIds.has(fG1) && !cIds.has(fH1) && !cIds.has(fI1), 'contingent excludes settled, pre-gate and not-commissionable items');
ok(cIds.has(fLrecent) && cont.find((c) => c.item_id === fLrecent).reason === 'no_earner_identified',
  'recently checked row shows as contingent (until the next hourly run)');
ok(!cIds.has(fMstale), 'stale-checked resolvable row is firm, not contingent');
ok(all.every((l) => !cIds.has(l.item_id)), 'no item is both firm and contingent');

// ---- note bonus ------------------------------------------------------------------------------------------
const pso = await person('Sales Officer');
const exPso = await person('Former Sales Officer');
const laterPso = await person('Later Sales Officer');
const posId = uuid(), sId1 = uuid(), sId2 = uuid(), sId3 = uuid();
await db.query(`insert into hr_positions values ($1, 'platform_sales_officer', 'Platform Sales Officer')`, [posId]);
await db.query(`insert into hr_staff (id, user_id) values ($1,$2), ($3,$4), ($5,$6)`, [sId1, pso, sId2, exPso, sId3, laterPso]);
// left the company on 16 Oct, but the officer assignment was never closed
const leaver = await person('Leaver');
const sId4 = uuid();
await db.query(`insert into hr_staff values ($1, $2, '2026-10-16')`, [sId4, leaver]);
await db.query(`insert into hr_assignments values ($1, $2, '2026-09-15', null)`, [sId4, posId]);
await db.query(`insert into hr_assignments values ($1,$2,'2026-09-01',null), ($3,$2,'2026-09-01','2026-10-01'), ($4,$2,'2026-10-15',null)`,
  [sId1, posId, sId2, sId3]);
const partnerN = await person('Note Partner');
const nPlain = await note(noteAgent, partnerN, '2026-10-05');                                  // no audit record at all
const nCredited = await note(noteAgent, partnerN, '2026-10-05');
await credit('promissory_note_verified:' + nCredited);
const nPso = await note(pso, partnerN, '2026-10-05');                                          // officer on approval date
const nExPso = await note(exPso, partnerN, '2026-09-15');                                      // officer then, assignment ended since
const nExPsoAfter = await note(exPso, partnerN, '2026-10-05');                                 // after the assignment ended
const nLaterPso = await note(laterPso, partnerN, '2026-10-05');                                // before becoming an officer
const nLeaverDuring = await note(leaver, partnerN, '2026-10-01');                            // officer while employed
const nLeaverAfter = await note(leaver, partnerN, '2026-10-20');                             // after leaving; open assignment ignored
const nAuditExcluded = await note(noteAgent, partnerN, '2026-10-06');
await db.query(`insert into audit_logs values ('promissory_notes', $1, 'approve_promissory_note', '{"pso_bonus_excluded": true}')`, [nAuditExcluded]);
const nReversed = await note(noteAgent, partnerN, '2026-10-05');
await db.query(`insert into partner_note_reversals values ($1, 'agent')`, [nReversed]);
const nRejected = await note(noteAgent, partnerN, '2026-10-05', { status: 'rejected' });
const nNotApproved = await note(noteAgent, partnerN, null);

all = await firm();
const bonus = (id) => lineFor(all, id, 'proxy_note_registration_bonus');
ok(bonus(nPlain).length === 1 && Number(bonus(nPlain)[0].outstanding_amount) === 1500, 'note bonus with no audit record: firm 1,500');
ok(bonus(nCredited).length === 0, 'note bonus already credited: excluded');
ok(bonus(nPso).length === 0, 'Sales Officer on the approval date: no bonus');
ok(bonus(nExPso).length === 0, 'former Sales Officer, officer on the approval date: no bonus');
ok(bonus(nExPsoAfter).length === 1, 'former Sales Officer, approval after the assignment ended: bonus due');
ok(bonus(nLaterPso).length === 1, 'approval before the agent became a Sales Officer: bonus due');
ok(bonus(nLeaverDuring).length === 0, 'officer while employed (assignment open): no bonus');
ok(bonus(nLeaverAfter).length === 1, 'approval after the staff record ended: bonus due even though the assignment was left open');
ok(bonus(nAuditExcluded).length === 0, 'exclusion recorded at approval: no bonus');
ok(bonus(nReversed).length === 0 && bonus(nRejected).length === 0 && bonus(nNotApproved).length === 0, 'reversed, rejected or unapproved notes: no bonus');

// ---- lead override ---------------------------------------------------------------------------------------
const lead = await person('Lead');
const agentL = await person('Led Agent');
const agentDetachedBefore = await person('Agent detached before');
const agentDetachedAfter = await person('Agent detached after');
await db.query(`insert into partner_lead_assignments values ($1,$4,'2026-08-10',null), ($2,$4,'2026-08-10','2026-09-01'), ($3,$4,'2026-08-10','2026-10-20')`,
  [agentL, agentDetachedBefore, agentDetachedAfter, lead]);
const lMissing = await note(agentL, partnerN, '2026-10-05');                                   // no override row
const lFailed = await note(agentL, partnerN, '2026-10-06');
await db.query(`insert into partner_note_overrides (note_id, lead_user_id, status) values ($1,$2,'failed')`, [lFailed, lead]);
const lPosted = await note(agentL, partnerN, '2026-10-07');
await db.query(`insert into partner_note_overrides (note_id, lead_user_id, status, ledger_group_id) values ($1,$2,'posted',$3)`, [lPosted, lead, uuid()]);
await credit('promissory_note_lead:' + lPosted);
const lDetachedBefore = await note(agentDetachedBefore, partnerN, '2026-10-05');
const lDetachedAfter = await note(agentDetachedAfter, partnerN, '2026-10-05');
const lBeforeRate = await note(agentL, partnerN, '2026-08-11');
await db.query(`update partner_note_rates set effective_from = '2026-08-20' where payee_role = 'lead'`);
const lReversed = await note(agentL, partnerN, '2026-10-08');
await db.query(`insert into partner_note_reversals values ($1, 'lead')`, [lReversed]);

all = await firm();
const ovr = (id) => lineFor(all, id, 'proxy_lead_override');
ok(ovr(lMissing).length === 1 && ovr(lMissing)[0].status === 'override_row_missing' && ovr(lMissing)[0].counterparty_id === lead && Number(ovr(lMissing)[0].outstanding_amount) === 1000,
  'active lead, override row missing: firm 1,000 to the lead');
ok(ovr(lFailed).length === 1 && ovr(lFailed)[0].status === 'override_failed', 'failed override row: firm');
ok(ovr(lPosted).length === 0, 'posted and credited override: excluded');
ok(ovr(lDetachedBefore).length === 0, 'lead detached before approval: no override');
ok(ovr(lDetachedAfter).length === 1, 'lead detached after approval: override due');
ok(ovr(lBeforeRate).length === 0, 'approval before the lead rate took effect: no override');
ok(ovr(lReversed).length === 0, 'reversed lead override: excluded');

// ---- duplicates ------------------------------------------------------------------------------------------
const keys = all.map((l) => `${l.product_key}|${l.item_id}`);
ok(new Set(keys).size === keys.length, 'no earning appears twice (one line per product and item)');
ok(all.every((l) => Number(l.outstanding_amount) > 0), 'every firm line carries a positive amount');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
