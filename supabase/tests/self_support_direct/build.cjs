// Builds the merchant-direct migration + rollback.
//   node build.js <version>
// live/*.def.sql are production definitions (pg_get_functiondef, 2026-11-12). Each patch
// replaces one exact anchor (must occur exactly once). The migration starts with a guard
// that refuses to run if any of these bodies changed on production since the export.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const D = __dirname;
const ROOT = path.resolve(D, '../../..');
const version = process.argv[2] || '20261117090000';
const NAME = `${version}_self_support_merchant_direct`;
const rd = (f) => fs.readFileSync(path.join(D, f), 'utf8').replace(/\r\n/g, '\n');
const body = (def) => def.slice(def.indexOf('AS $function$') + 'AS $function$'.length, def.lastIndexOf('$function$'));
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

const DIRECT_WR = (col) => `${col} IS NOT NULL AND public._ssd_wr_insert_is_direct(${col})`;
const NOTE = '-- Self-support merchant-direct (switch self_support_merchant_direct): ';

// [file, proname, nargs, [[anchor, replacement], ...]]
const patches = [
  ['enforce_landlord_payout_eligibility', 'enforce_landlord_payout_eligibility', 0, [
    [`  IF v_kampala_hour < 6 OR v_kampala_hour >= 22 THEN`,
     `  ${NOTE}partner-direct payouts are exempt from the night window.\n  IF NOT public._ssd_inserting() AND (v_kampala_hour < 6 OR v_kampala_hour >= 22) THEN`],
    [`  SELECT balance INTO v_float_balance\n  FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id;`,
     `  ${NOTE}a partner-direct payout never touches the agent's landlord float.\n  IF public._ssd_inserting() THEN\n    RETURN NEW;\n  END IF;\n\n  SELECT balance INTO v_float_balance\n  FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id;`],
  ]],
  ['enforce_landlord_float_performance_gate', 'enforce_landlord_float_performance_gate', 0, [
    [`  IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;\n`,
     `  IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;\n  ${NOTE}partner money, not the agent's float.\n  IF public._ssd_wr_insert_is_direct(NEW.landlord_payout_id) THEN RETURN NEW; END IF;\n`],
  ]],
  ['trg_bike_sweep_block_withdrawal_fn', 'trg_bike_sweep_block_withdrawal_fn', 0, [
    [`BEGIN\n  IF public._bike_sweep_blocks_outflow(NEW.user_id) THEN`,
     `BEGIN\n  ${NOTE}the agent receives nothing from this row.\n  IF ${DIRECT_WR('NEW.landlord_payout_id')} THEN\n    RETURN NEW;\n  END IF;\n  IF public._bike_sweep_blocks_outflow(NEW.user_id) THEN`],
  ]],
  ['require_withdrawal_pin_proof', 'require_withdrawal_pin_proof', 0, [
    [`  if v_uid is null or v_uid is distinct from NEW.user_id then\n    return NEW;\n  end if;\n`,
     `  if v_uid is null or v_uid is distinct from NEW.user_id then\n    return NEW;\n  end if;\n\n  ${NOTE}not the user's own withdrawal.\n  if TG_TABLE_NAME = 'withdrawal_requests' then\n    if ${DIRECT_WR('NEW.landlord_payout_id')} then\n      return NEW;\n    end if;\n  end if;\n`],
  ]],
  ['prevent_duplicate_pending_withdrawal', 'prevent_duplicate_pending_withdrawal', 0, [
    [`BEGIN\n  IF NEW.status IS DISTINCT FROM 'pending'`,
     `BEGIN\n  ${NOTE}one payout per Rent Plan is enforced by its own unique index.\n  IF ${DIRECT_WR('NEW.landlord_payout_id')} THEN\n    RETURN NEW;\n  END IF;\n\n  IF NEW.status IS DISTINCT FROM 'pending'`],
  ]],
  ['get_agent_lp_float_available', 'get_agent_lp_float_available', 1, [
    [`          AND status IN ('otp_verified','pending_merchant_payout')\n`,
     `          AND status IN ('otp_verified','pending_merchant_payout')\n          AND NOT EXISTS (SELECT 1 FROM public.self_support_landlord_payments s\n                           WHERE s.landlord_payout_id = landlord_payouts.id)\n`],
  ]],
  ['deduct_agent_float_for_payout', 'deduct_agent_float_for_payout', 1, [
    [`  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;\n`,
     `  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;\n\n  ${NOTE}never on the agent's landlord float, so nothing to deduct.\n  IF public._ssd_payout_is_direct(p_payout_id) THEN\n    UPDATE public.landlord_payouts SET attempts = attempts + 1, last_attempt_at = now()\n     WHERE id = p_payout_id AND last_attempt_at IS NULL;\n    RETURN jsonb_build_object('ok', true, 'skipped', 'direct_partner', 'status', v_payout.status);\n  END IF;\n`],
  ]],
  ['refund_agent_float_for_payout', 'refund_agent_float_for_payout', 2, [
    [`  perform 1 from public.agent_landlord_float where agent_id = v_payout.agent_id for update;`,
     `  ${NOTE}nothing to return to the agent; failing the payout\n  -- refunds the partner (trg_a0_ssd_landlord_payout_status).\n  if public._ssd_payout_is_direct(p_payout_id) then\n    update public.landlord_payouts\n       set status = 'failed', last_error = p_reason, escalated_at = now(), escalated_reason = p_reason, updated_at = now()\n     where id = p_payout_id;\n    return jsonb_build_object('ok', true, 'refunded', 0, 'reason', p_reason, 'status', 'failed',\n                              'direct_partner', true, 'partner_refunded', true);\n  end if;\n\n  perform 1 from public.agent_landlord_float where agent_id = v_payout.agent_id for update;`],
  ]],
  ['apply_landlord_payout_to_allocation', 'apply_landlord_payout_to_allocation', 0, [
    [`  IF NEW.allocation_applied_id IS NOT NULL THEN\n    RETURN NEW;\n  END IF;\n`,
     `  IF NEW.allocation_applied_id IS NOT NULL THEN\n    RETURN NEW;\n  END IF;\n\n  ${NOTE}there is no allocation, and the tenant\n  -- fallback below could otherwise match an unrelated one.\n  IF public._ssd_payout_is_direct(NEW.id) THEN\n    RETURN NEW;\n  END IF;\n`],
  ]],
  ['post_landlord_payout_finops_commission', 'post_landlord_payout_finops_commission', 0, [
    [`  IF NEW.agent_id IS NULL OR COALESCE(NEW.amount, 0) <= 0 THEN\n    RETURN NEW;\n  END IF;\n`,
     `  IF NEW.agent_id IS NULL OR COALESCE(NEW.amount, 0) <= 0 THEN\n    RETURN NEW;\n  END IF;\n\n  ${NOTE}owner decision 2026-11-12: no 1% payout\n  -- commission (the agent keeps the UGX 5,000 posted-rent bonus).\n  IF public._ssd_payout_is_direct(NEW.id) THEN\n    RETURN NEW;\n  END IF;\n`],
  ]],
  ['landlord_payout_allowed_today', 'landlord_payout_allowed_today', 0, [
    [`   WHERE w.landlord_payout_id IS NOT NULL\n`,
     `   WHERE w.landlord_payout_id IS NOT NULL\n     -- partner-direct payouts are partner money, not this allowance\n     AND NOT EXISTS (SELECT 1 FROM public.self_support_landlord_payments s WHERE s.landlord_payout_id = w.landlord_payout_id)\n`],
  ]],
  ['landlord_payout_goal_allowed', 'landlord_payout_goal_allowed', 0, [
    [`WHERE w.landlord_payout_id IS NOT NULL AND w.landlord_block_exempt_at`,
     `WHERE w.landlord_payout_id IS NOT NULL\n       AND NOT EXISTS (SELECT 1 FROM public.self_support_landlord_payments s WHERE s.landlord_payout_id = w.landlord_payout_id)\n       AND w.landlord_block_exempt_at`],
  ]],
  ['trg_e60_no_self_approval', 'trg_e60_no_self_approval', 0, [
    [`begin\n  if auth.uid() is not null`,
     `begin\n  -- System releases (merchant-direct queue, instant houses) are nobody's approval.\n  if coalesce(current_setting('app.ss_system_release', true), '') = 'on' then\n    return new;\n  end if;\n  if auth.uid() is not null`],
  ]],
  ['_approve_pending_portfolio_core', '_approve_pending_portfolio_core', 2, [
    [`  UPDATE public.investor_portfolios\n     SET status = 'active',\n         next_roi_date = COALESCE(next_roi_date, (now() + interval '30 days')::date),`,
     `  ${NOTE}a Rent Plan is not activated here.\n  -- The partner is debited and the payout queued; the portfolio activates when the landlord is paid.\n  IF v_pending.id IS NOT NULL AND v_pending.source = 'self_managed' AND v_pending.commitment_id IS NOT NULL\n     AND public._ssd_on() THEN\n    PERFORM public._ssd_queue_commitment(p_portfolio_id, v_pending.id, v_caller);\n    IF v_direct THEN\n      PERFORM set_config('psm.owner_release', coalesce(v_prev_owner, ''), true);\n    END IF;\n    PERFORM set_config('app.funder_direct_release_busy', '', true);\n    RETURN p_portfolio_id;\n  END IF;\n\n  UPDATE public.investor_portfolios\n     SET status = 'active',\n         next_roi_date = COALESCE(next_roi_date, (now() + interval '30 days')::date),`],
  ]],
  ['funder_support_tenant_direct', 'funder_support_tenant_direct', 3, [
    [`    ELSIF v_port_status = 'active' THEN\n      v_released := true;\n    END IF;\n`,
     `    ELSIF v_port_status = 'active' THEN\n      v_released := true;\n    END IF;\n\n    IF public._ssd_portfolio_queued(v_portfolio) THEN\n      RETURN v_res || public._ssd_support_result(v_portfolio, v_uid) || jsonb_build_object('idempotent_replay', true);\n    END IF;\n`],
    [`    PERFORM public._approve_pending_portfolio_core(v_portfolio, v_uid);\n\n    BEGIN`,
     `    PERFORM public._approve_pending_portfolio_core(v_portfolio, v_uid);\n\n    ${NOTE}the money is in the merchant queue.\n    IF public._ssd_portfolio_queued(v_portfolio) THEN\n      RETURN v_res || public._ssd_support_result(v_portfolio, v_uid);\n    END IF;\n\n    BEGIN`],
  ]],
  ['co_support_accept', 'co_support_accept', 1, [
    [`  IF v_is_house THEN\n    -- Partner Ops approves the pair (approve_pending_portfolio); nothing is debited yet.`,
     `  ${NOTE}empty houses are instant.\n  -- Both halves are debited and active here, in one transaction, in a fixed order.\n  IF v_is_house AND public._ssd_on() THEN\n    PERFORM public._ssd_house_instant(LEAST((v_lead->>'portfolio_id')::uuid, (v_mine->>'portfolio_id')::uuid));\n    PERFORM public._ssd_house_instant(GREATEST((v_lead->>'portfolio_id')::uuid, (v_mine->>'portfolio_id')::uuid));\n    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,\n      jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,\n                         'portfolio_id', v_mine->>'portfolio_id', 'house_id', v.house_id, 'status', 'active'));\n    RETURN public._co_support_invite_json(v.id, v_uid)\n        || jsonb_build_object('ok', true, 'awaiting_partner_ops', false, 'house_active', true,\n                              'earning_from', public._ssd_earning_date(), 'landlord_float_released', false,\n                              'available_balance', public.funder_float_available(v_uid));\n  END IF;\n\n  IF v_is_house THEN\n    -- Partner Ops approves the pair (approve_pending_portfolio); nothing is debited yet.`],
    [`  IF NOT EXISTS (\n    SELECT 1 FROM public.agent_landlord_float_allocations a`,
     `  IF NOT public._ssd_plan_queued(v.rent_request_id, v.rent_amount) AND NOT EXISTS (\n    SELECT 1 FROM public.agent_landlord_float_allocations a`],
    [`      || jsonb_build_object('ok', true, 'landlord_float_released', true,\n                            'available_balance', public.funder_float_available(v_uid));`,
     `      || jsonb_build_object('ok', true, 'landlord_float_released', NOT public._ssd_plan_queued(v.rent_request_id),\n                            'available_balance', public.funder_float_available(v_uid))\n      || public._ssd_plan_result(v.rent_request_id);`],
  ]],
  ...['partner_support_houses__3', 'partner_support_houses__4'].map((f) => [f, 'partner_support_houses', f.endsWith('3') ? 3 : 4, [
    [`  RETURN jsonb_build_object(\n    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,\n    'committed_amount', v_total, 'houses', v_count,`,
     `  ${NOTE}empty houses are instant, no Partner Ops.\n  IF public._ssd_on() THEN\n    PERFORM public._ssd_house_instant(v_portfolio_id);\n    RETURN jsonb_build_object(\n      'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,\n      'committed_amount', v_total, 'houses', v_count,\n      'monthly_return', round(v_total * v_rate / 100),\n      'roi_percentage', v_rate,\n      'status', 'active', 'earning_from', public._ssd_earning_date(),\n      'available_balance', public.funder_float_available(v_partner)\n    );\n  END IF;\n\n  RETURN jsonb_build_object(\n    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,\n    'committed_amount', v_total, 'houses', v_count,`],
  ]]),
  ['funder_release_sms_dispatch', 'funder_release_sms_dispatch', 0, [
    [`     WHERE status = 'pending' AND attempts < 4\n  ) THEN`,
     `     WHERE status = 'pending' AND attempts < 4\n  ) AND NOT EXISTS (\n    -- merchant-direct self-support messages share this batch sender\n    SELECT 1 FROM public.self_support_notices\n     WHERE status = 'pending' AND channel = 'sms' AND attempts < 4\n  ) THEN`],
  ]],
];

let guard = '', patched = '', restore = '';
for (const [file, proname, nargs, edits] of patches) {
  const def = rd(`live/${file}.def.sql`).trimEnd();
  const orig = body(def);
  let next = def;
  for (const [a, r] of edits) {
    const n = next.split(a).length - 1;
    if (n !== 1) throw new Error(`${file}: anchor found ${n} times: ${a.slice(0, 80)}`);
    next = next.replace(a, () => r);
  }
  guard += `    ('${proname}', ${nargs}, '${md5(orig)}'),\n`;
  patched += `-- ${file}\n${next};\n\n`;
  restore += `-- ${file}\n${def};\n\n`;
}
guard = guard.replace(/,\n$/, '\n');

const guardSql = `-- Fail fast instead of queueing behind live traffic for the table locks below.
SET LOCAL lock_timeout = '5s';

-- Refuse to run if production changed any function this migration patches since 2026-11-12.
DO $guard$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
${guard}  ) AS t(proname, nargs, expected) LOOP
    -- line endings ignored: some live bodies were saved with CRLF
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.proname AND p.pronargs = r.nargs;
    IF v_md5 IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION 'self_support_merchant_direct: %(% args) changed on production (md5 % <> %). Re-export and rebuild.',
        r.proname, r.nargs, v_md5, r.expected;
    END IF;
  END LOOP;
END $guard$;

`;

const header = `-- Self-support merchant-direct (owner decisions 2026-11-12).
--
-- With pipeline switch self_support_merchant_direct ON:
--   * Rent Plan (one partner or a co-support pair): no Partner Ops, no agent landlord float, no landlord OTP.
--     The partner is debited and a payout to the landlord's Landlord-Ops-approved number goes straight
--     into the merchant payout queue (exempt from the night window and the landlord-payout freeze).
--     When the merchant pays (landlord_payouts -> awaiting_agent_receipt) the portfolio activates and
--     Rent Profit Share earns from the NEXT day (Kampala). Not paid in 48h, or rejected: partner refunded.
--     Agent: keeps the UGX 5,000 posted-rent bonus, no 1% payout commission.
--   * Empty house: instant (debited and active at once), earning from the next day.
-- Switch OFF: every patched function behaves exactly as before.
-- Also fixes E60: a partner's own direct release / co-support accept no longer trips the
-- self-approval guard (system releases set app.ss_system_release).
-- Built by supabase/tests/self_support_direct/build.js from production definitions.

`;
const migration = header + guardSql + rd('template_new.sql') + '\n-- ============================================================================\n'
  + '-- Part 2: production functions with the merchant-direct branch.\n'
  + '-- ============================================================================\n\n' + patched;
fs.writeFileSync(path.join(ROOT, 'supabase/migrations', `${NAME}.sql`), migration);

const rollback = `-- Rollback for ${NAME}. Refuses while any partner money is still waiting in the merchant queue.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.self_support_landlord_payments WHERE status = 'queued') THEN
    RAISE EXCEPTION 'self-support landlord payments are still queued: let them pay or refund (ssd_expire_unpaid) first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_self_commitments WHERE status = 'awaiting_landlord') THEN
    RAISE EXCEPTION 'commitments still awaiting_landlord';
  END IF;
END $$;

SELECT cron.unschedule('ssd_expire_unpaid') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ssd_expire_unpaid');
DROP TRIGGER IF EXISTS trg_a0_ssd_landlord_payout_status ON public.landlord_payouts;
DROP TRIGGER IF EXISTS zzzz_ssd_landlord_paid_notify ON public.landlord_payouts;

-- production definitions as of 2026-11-12
${restore}
DROP FUNCTION IF EXISTS public.self_support_my_landlord_payments(integer);
DROP FUNCTION IF EXISTS public.self_support_staff_resolve(uuid, text, text);
DROP FUNCTION IF EXISTS public.ssd_expire_unpaid(integer);
DROP FUNCTION IF EXISTS public.trg_ssd_landlord_payout_status();
DROP FUNCTION IF EXISTS public.trg_ssd_landlord_paid_notify();
DROP FUNCTION IF EXISTS public._ssd_house_instant(uuid);
DROP FUNCTION IF EXISTS public._ssd_refund(uuid, text);
DROP FUNCTION IF EXISTS public._ssd_activate(uuid);
DROP FUNCTION IF EXISTS public._ssd_settle_commitment(uuid);
DROP FUNCTION IF EXISTS public._ssd_queue_plan(uuid);
DROP FUNCTION IF EXISTS public._ssd_queue_commitment(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._ssd_notify(uuid, text);
DROP FUNCTION IF EXISTS public._ssd_notice(text, uuid, text, text, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public._ssd_support_result(uuid, uuid);
DROP FUNCTION IF EXISTS public._ssd_plan_result(uuid);
DROP FUNCTION IF EXISTS public._ssd_payment_json(uuid);
DROP FUNCTION IF EXISTS public._ssd_plan_queued(uuid, numeric);
DROP FUNCTION IF EXISTS public._ssd_portfolio_queued(uuid);
DROP FUNCTION IF EXISTS public._ssd_first(text);
DROP FUNCTION IF EXISTS public._ssd_momo_provider(text, boolean);
DROP FUNCTION IF EXISTS public._ssd_wr_insert_is_direct(uuid);
DROP FUNCTION IF EXISTS public._ssd_inserting();
DROP FUNCTION IF EXISTS public._ssd_payout_is_direct(uuid);
DROP FUNCTION IF EXISTS public._ssd_day_start(date);
DROP FUNCTION IF EXISTS public._ssd_earning_date();
DROP FUNCTION IF EXISTS public._ssd_debit_ref(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._ssd_on();
-- the tables keep their history; drop them only once nobody needs the record
-- DROP TABLE public.self_support_notices; DROP TABLE public.self_support_landlord_payments;
-- index names are schema-wide: move them aside too, so the migration can be applied again
DO $r$ DECLARE i record; BEGIN
  FOR i IN SELECT c.relname FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
            WHERE x.indrelid IN ('public.self_support_landlord_payments'::regclass, 'public.self_support_notices'::regclass) LOOP
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', i.relname, left(i.relname, 40) || '_r${version}');
  END LOOP;
END $r$;
ALTER TABLE public.self_support_landlord_payments RENAME TO self_support_landlord_payments_retired_${version};
ALTER TABLE public.self_support_notices RENAME TO self_support_notices_retired_${version};

ALTER TABLE public.partner_self_commitments DROP CONSTRAINT partner_self_commitments_status_check;
ALTER TABLE public.partner_self_commitments ADD CONSTRAINT partner_self_commitments_status_check
  CHECK (status = ANY (ARRAY['pending_ops_approval'::text, 'active'::text, 'matured'::text, 'cancelled'::text]));
DELETE FROM public.pipeline_switches WHERE key = 'self_support_merchant_direct';
`;
fs.mkdirSync(path.join(ROOT, 'supabase/rollbacks'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'supabase/rollbacks', `${NAME}.rollback.sql`), rollback);
console.log(NAME, 'migration', migration.length, 'rollback', rollback.length, 'patched', patches.length);
