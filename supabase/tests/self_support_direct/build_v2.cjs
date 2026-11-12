// Builds migration 20261117140000_self_support_activate_on_landlord_paid (+ rollback to the v1 state).
//   node build_v2.cjs
// Part 2 restores the production originals (live/*.def.sql) that v1 had patched for merchant-direct, and
// re-patches the core and co_support_accept from their originals for the agent-float flow. The guard refuses
// to run unless production still holds exactly the v1 bodies, and never touches a protected function.
const fs = require('fs'), path = require('path');
const D = __dirname;
const ROOT = path.resolve(D, '../../..');
const NAME = '20261117140000_self_support_activate_on_landlord_paid';
const rd = (f) => fs.readFileSync(path.join(D, f), 'utf8').replace(/\r\n/g, '\n');
const v1 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261117120000_self_support_merchant_direct.sql'), 'utf8');

// production md5 (CR stripped) of the v1 bodies, read from production 2026-11-12 after v1 was applied
const V1 = {
  '_approve_pending_portfolio_core/2': '06210247b2b0c9c4cdacac5832bd2b5d',
  'apply_landlord_payout_to_allocation/0': '52f242b3b588848ed8046d03b5f48795',
  'co_support_accept/1': '3b52134d70dfa268e2815319805aca7b',
  'deduct_agent_float_for_payout/1': '0e676658fd0b772128b25ce8c281fcb5',
  'enforce_landlord_float_performance_gate/0': '69ec7dab18cb171bf38acf7ea41dec60',
  'get_agent_lp_float_available/1': 'c72aac93531ec497fc63ceb02695b313',
  'post_landlord_payout_finops_commission/0': 'a894e6a688f514d9337d3ff1912a99b2',
  'prevent_duplicate_pending_withdrawal/0': 'a35773076c7ff2a428c0b7f38a5d467f',
  'refund_agent_float_for_payout/2': '483a8bc263b754ab297d7b828c38037b',
  'require_withdrawal_pin_proof/0': '76696d891d96e7a1d1ef4bba06d90400',
  'trg_bike_sweep_block_withdrawal_fn/0': '41d4e1c23e58326ff8802b4453073526',
};
const RESTORE = ['apply_landlord_payout_to_allocation', 'deduct_agent_float_for_payout', 'enforce_landlord_float_performance_gate',
  'get_agent_lp_float_available', 'post_landlord_payout_finops_commission', 'prevent_duplicate_pending_withdrawal',
  'refund_agent_float_for_payout', 'require_withdrawal_pin_proof', 'trg_bike_sweep_block_withdrawal_fn'];

// each edit: [anchor, replacement, expected count (default 1)]; every occurrence is replaced
const patch = (file, edits) => {
  let t = rd(`live/${file}.def.sql`).trimEnd();
  for (const [a, r, want = 1] of edits) {
    const n = t.split(a).length - 1;
    if (n !== want) throw new Error(`${file}: anchor found ${n} times (want ${want}): ${a.slice(0, 90)}`);
    t = t.split(a).join(r);
  }
  return t;
};
const NOTE = '-- Self-support (switch self_support_activate_on_landlord_paid): ';

const core = patch('_approve_pending_portfolio_core', [
  [`  IF v_direct THEN\n    PERFORM set_config('psm.owner_release', 'on', true);\n  END IF;\n\n  IF v_caller IS NULL THEN`,
   `  IF v_direct THEN\n    PERFORM set_config('psm.owner_release', 'on', true);\n    -- A direct release runs as the partner; activating their own portfolio is not an owner edit\n    -- (guard_investor_portfolio_self_edit otherwise refuses it with PORTFOLIO_FIELD_LOCKED).\n    PERFORM set_config('welile.portfolio_trusted', 'on', true);\n  END IF;\n\n  IF v_caller IS NULL THEN`],
  // general_ledger allows one wallet leg per (partner, category, reference, direction): the second support of
  // the same plan by the same partner (after a recall or cancel) failed on uq_general_ledger_reference_dedupe.
  [`          'source_table', 'partner_self_funding_lines', 'source_id', l.id,\n          'reference_id', l.rent_request_id::text,\n          'description', 'Self-managed partner funding approved`,
   `          'source_table', 'partner_self_funding_lines', 'source_id', l.id,\n          'reference_id', public._ssd_debit_ref(v_pending.funder_id, l.rent_request_id, l.id),\n          'description', 'Self-managed partner funding approved`],
  [`  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)\n  VALUES (v_caller, 'approve_pending_portfolio', 'investor_portfolios'`,
   `  ${NOTE}the rent is on the agent's landlord\n  -- float as above, but the portfolio does not earn until the merchant pays the landlord.\n  IF v_pending.id IS NOT NULL AND v_pending.source = 'self_managed' AND v_pending.commitment_id IS NOT NULL\n     AND public._ssd_on() THEN\n    PERFORM public._ssd_hold_until_landlord_paid(p_portfolio_id, v_pending.commitment_id);\n  END IF;\n  IF v_direct THEN\n    PERFORM set_config('welile.portfolio_trusted', '', true);\n  END IF;\n\n  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)\n  VALUES (v_caller, 'approve_pending_portfolio', 'investor_portfolios'`],
]);
const accept = patch('co_support_accept', [
  [`  IF v_is_house THEN\n    -- Partner Ops approves the pair (approve_pending_portfolio); nothing is debited yet.`,
   `  ${NOTE}empty houses are active at once.\n  -- Both halves are debited and active here, in one transaction, in a fixed order.\n  IF v_is_house AND public._ssd_on() THEN\n    PERFORM public._ssd_house_instant(LEAST((v_lead->>'portfolio_id')::uuid, (v_mine->>'portfolio_id')::uuid));\n    PERFORM public._ssd_house_instant(GREATEST((v_lead->>'portfolio_id')::uuid, (v_mine->>'portfolio_id')::uuid));\n    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,\n      jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,\n                         'portfolio_id', v_mine->>'portfolio_id', 'house_id', v.house_id, 'status', 'active'));\n    RETURN public._co_support_invite_json(v.id, v_uid)\n        || jsonb_build_object('ok', true, 'awaiting_partner_ops', false, 'house_active', true,\n                              'earning_from', public._ssd_earning_date(), 'landlord_float_released', false,\n                              'available_balance', public.funder_float_available(v_uid));\n  END IF;\n\n  IF v_is_house THEN\n    -- Partner Ops approves the pair (approve_pending_portfolio); nothing is debited yet.`],
  [`      || jsonb_build_object('ok', true, 'landlord_float_released', true,\n                            'available_balance', public.funder_float_available(v_uid));`,
   `      || jsonb_build_object('ok', true, 'landlord_float_released', true,\n                            'available_balance', public.funder_float_available(v_uid))\n      || public._ssd_plan_result(v.rent_request_id);`],
]);

// Co-support release posted both halves under one reference (PSC-...); uq_general_ledger_reference_dedupe
// rejects the second, so no co-supported Rent Plan could be released. The invitee's half gets its own reference.
const coDisburse = patch('_co_support_disburse_landlord_float', [
  [`    SELECT l.id, l.partner_id, COALESCE(l.rent_amount, l.principal) AS amount\n      FROM public.partner_self_funding_lines l\n     WHERE l.co_support_id = v_co AND l.status <> 'cancelled'`,
   `    SELECT l.id, l.partner_id, COALESCE(l.rent_amount, l.principal) AS amount,\n           CASE WHEN l.partner_id = v_inv.lead_partner_id THEN v_ref ELSE v_ref || '-2' END AS ref\n      FROM public.partner_self_funding_lines l\n     WHERE l.co_support_id = v_co AND l.status <> 'cancelled'`],
  [`'reference_id', v_ref,`, `'reference_id', v_line.ref,`, 2],
]);
V1['_co_support_disburse_landlord_float/1'] = '4b56231e1632a7787657563acef4bb9d'; // unchanged by v1

const replaced = [...RESTORE.map((n) => [n, Number(Object.keys(V1).find((k) => k.startsWith(n + '/')).split('/')[1])]),
                  ['_approve_pending_portfolio_core', 2], ['co_support_accept', 1], ['_co_support_disburse_landlord_float', 1]];
const guard = `-- Fail fast instead of queueing behind live traffic.
SET LOCAL lock_timeout = '5s';

-- Refuse unless production holds exactly the v1 (20261117120000) bodies of what this replaces,
-- and never replace a protected function (protected_functions_guard would silently revert it).
DO $guard$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
${replaced.map(([n, a]) => `    ('${n}', ${a}, '${V1[`${n}/${a}`]}')`).join(',\n')}
  ) AS t(proname, nargs, expected) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.proname AND p.pronargs = r.nargs;
    IF v_md5 IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION 'self_support v2: %(% args) is not the v1 body on production (md5 % <> %). Re-export and rebuild.',
        r.proname, r.nargs, v_md5, r.expected;
    END IF;
    IF to_regclass('public.protected_functions') IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.protected_functions f WHERE f.schema_name = 'public' AND f.func_name = r.proname) THEN
      RAISE EXCEPTION 'self_support v2: % is a protected function; this migration must not change it', r.proname;
    END IF;
  END LOOP;
END $guard$;

`;
const header = `-- Self-support v2: activate on landlord paid (owner correction 2026-11-12).
--
-- Replaces the merchant-direct Rent Plan path of 20261117120000 (switch never ON):
--   partner supports a Rent Plan -> rent goes to the agent's landlord float with no Partner Ops step ->
--   agent informed (existing release notices) -> agent withdraws as today (landlord OTP, 06:00-22:00,
--   1% + UGX 5,000) -> merchant pays the landlord -> partner told -> portfolio active, Rent Profit Share
--   from that day. 48 hours unpaid: recalled from the agent and the partner refunded (as funded_recall).
--   The agent's payout for such a plan is let through the landlord-payout freeze.
--   Empty houses: active at once.
-- Also: a partner's own direct release no longer trips PORTFOLIO_FIELD_LOCKED (this part is live
-- whatever the switch says: it is what funder_direct_release needs).
-- Built by supabase/tests/self_support_direct/build_v2.cjs.

`;
let part2 = '';
for (const n of RESTORE) part2 += `-- ${n} (production original)\n${rd(`live/${n}.def.sql`).trimEnd()};\n\n`;
part2 += `-- _approve_pending_portfolio_core
${core};

-- co_support_accept
${accept};

-- _co_support_disburse_landlord_float
${coDisburse};

`;
part2 += `-- merchant-direct helpers no production function references any more\nDROP FUNCTION IF EXISTS public._ssd_wr_insert_is_direct(uuid);\nDROP FUNCTION IF EXISTS public._ssd_inserting();\nDROP FUNCTION IF EXISTS public._ssd_payout_is_direct(uuid);\n`;
const migration = header + guard + rd('template_v2.sql') +
  '\n-- ============================================================================\n-- Part 2: production functions\n-- ============================================================================\n\n' + part2;
fs.writeFileSync(path.join(ROOT, 'supabase/migrations', `${NAME}.sql`), migration);

// Rollback: remove the whole feature, back to production originals: v2's own objects first, then the
// generated v1 rollback (which restores every original body, drops the rest, keeps the history tables).
const v1rb = fs.readFileSync(path.join(ROOT, 'supabase/rollbacks/20261117120000_self_support_merchant_direct.rollback.sql'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace("DELETE FROM public.pipeline_switches WHERE key = 'self_support_merchant_direct';",
           "DELETE FROM public.pipeline_switches WHERE key IN ('self_support_merchant_direct', 'self_support_activate_on_landlord_paid');");
const rb = `-- Rollback for ${NAME}: removes self-support activate-on-landlord-paid entirely (production originals).
-- Refuses while plans are waiting for a landlord (the v1 part below checks).
${v1rb}
-- _co_support_disburse_landlord_float (production original; v2 gave the invitee's half its own reference)
${rd('live/_co_support_disburse_landlord_float.def.sql').trimEnd()};

DROP TRIGGER IF EXISTS aaa_01_ssd_freeze_exempt ON public.withdrawal_requests;
DROP FUNCTION IF EXISTS public.trg_ssd_freeze_exempt();
DROP TRIGGER IF EXISTS aa_00_ssd_payout_recall_lock ON public.landlord_payouts;
DROP FUNCTION IF EXISTS public.trg_ssd_payout_recall_lock();
DROP FUNCTION IF EXISTS public._ssd_hold_until_landlord_paid(uuid, uuid);
DROP FUNCTION IF EXISTS public._ssd_track_plan(uuid);
DROP FUNCTION IF EXISTS public._ssd_recall(uuid, text);
DROP FUNCTION IF EXISTS public._ssd_activate(uuid, uuid);
DROP FUNCTION IF EXISTS public._ssd_settle_commitment(uuid);
DROP FUNCTION IF EXISTS public.self_support_staff_landlord_payments(text, integer);
DROP FUNCTION IF EXISTS public._ssd_is_finance_staff();
`;
fs.writeFileSync(path.join(ROOT, 'supabase/rollbacks', `${NAME}.rollback.sql`), rb);
console.log(NAME, 'migration', migration.length, 'rollback', rb.length);
