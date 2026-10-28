-- crm_callee_dossier was hitting the 8s authenticated statement_timeout because its
-- wallet block LEFT JOINed v_user_wallet_strict. That view aggregates every wallet
-- ledger row (about 349k) and calls wallet_route_for_category once per row with a
-- null wallet_bucket (about 139k calls, ~7.5s) before discarding every user but one.
-- A projection row does not stop that join: coalesce(bp, ws, 0) still evaluates ws.
--
-- This migration does not change statement_timeout and does not rewrite the view.
-- user_wallet_strict_for repeats the view for one user, with the user filter inside
-- the ledger, anchor and hold steps, so idx_general_ledger_wallet_scope_user_created
-- is used. Read-only on 2026-10-27: the heaviest wallet (8,199 wallet rows, anchor
-- applied) finished in 67ms. The same math matched v_user_wallet_strict on 20 sample
-- users (heavy ledgers, anchors, open holds, and ledger users with no projection row):
-- zero column mismatches.
--
-- crm_callee_dossier reads wallet_balances_projection first. That table's balance
-- columns are NOT NULL, so a present row is exactly what coalesce(bp, ws, 0) already
-- returned. The helper runs only when the projection row is missing. If the helper
-- also has no row, the three balances are 0. Landlord float is still the sum of
-- agent_landlord_float and does not use either source.
--
-- The helper is owner/service_role only. Default privileges would grant EXECUTE to
-- anon and authenticated, so this file revokes those. crm_callee_dossier stays the
-- authorized caller (crm_call_centre_authorized) and keeps its grants.
--
-- Apply on byrzshwlentqvktcksem after merge. Do not apply from this branch.
-- Parity script (after apply): supabase/tests/user_wallet_strict_for_parity.sql
-- Rollback: supabase/rollbacks/20261027235500_crm_callee_dossier_wallet_projection.rollback.sql

SET lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.crm_callee_dossier(uuid)') IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.crm_callee_dossier(uuid)'::regprocedure)
          IS DISTINCT FROM 'd1a83ef6b9dec11aaf2a522be424b3bb'
     OR md5(pg_get_viewdef('public.v_user_wallet_strict'::regclass)) IS DISTINCT FROM '569364d2c0f996a6cddcafd9cba82c82' THEN
    RAISE EXCEPTION 'precondition failed: crm_callee_dossier or v_user_wallet_strict changed since 2026-10-27; nothing was changed. Regenerate this migration from the current definitions';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.user_wallet_strict_for(p_user_id uuid)
RETURNS TABLE (
  user_id uuid,
  withdrawable numeric,
  float_balance numeric,
  advance_balance numeric,
  pending_holds numeric,
  restricted_held numeric,
  total_visible numeric,
  float_balance_signed numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH anchors AS (
    SELECT a.user_id, a.anchor_at
    FROM public.wallet_fresh_start_anchors a
    WHERE a.user_id = p_user_id
  ),
  ledger AS (
    SELECT gl.user_id, gl.category, gl.direction, gl.amount, gl.wallet_bucket,
           gl.maturity_met, gl.maturity_expired, gl.withdrawable_after
    FROM public.general_ledger gl
    LEFT JOIN anchors a ON a.user_id = gl.user_id
    WHERE p_user_id IS NOT NULL
      AND gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction = ANY (ARRAY['debit','cash_out'])
        )
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction = ANY (ARRAY['credit','cash_in'])
          AND gl.source_table = 'fin_s14b1r_lines'
          AND gl.idempotency_key ~~ 'batch1\_restore:s14b1:%'
          AND EXISTS (
            SELECT 1
            FROM public.fin_s14b1r_lines l
            WHERE ('batch1_restore:' || l.orig_idempotency_key) = gl.idempotency_key
              AND l.ledger_scope = 'wallet'
              AND l.user_id = gl.user_id
              AND l.amount = gl.amount
          )
        )
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'merchant_float_correction_writedown'
          AND gl.direction = ANY (ARRAY['debit','cash_out'])
        )
      )
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      AND NOT (
        gl.source_table = 'commission_engine'
        AND EXISTS (
          SELECT 1
          FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = gl.user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
            AND cal.source_id = gl.source_id::text
        )
      )
      AND NOT (
        gl.source_table = 'commission_engine_reversal'
        AND gl.classification = 'admin_correction'
        AND gl.category = 'system_balance_correction'
        AND gl.amount = 10000
        AND EXISTS (
          SELECT 1
          FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = gl.user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
        )
      )
  ),
  routed_explicit AS (
    SELECT ledger.user_id, ledger.amount, ledger.wallet_bucket AS bucket,
           CASE
             WHEN ledger.direction = ANY (ARRAY['cash_in','credit']) THEN 1
             WHEN ledger.direction = ANY (ARRAY['cash_out','debit']) THEN -1
             ELSE 0
           END AS sign,
           ledger.maturity_met, ledger.maturity_expired, ledger.withdrawable_after,
           ledger.direction, ledger.category
    FROM ledger
    WHERE ledger.wallet_bucket = ANY (ARRAY['withdrawable','float','advance_credit','advance_repayment'])
  ),
  routed_category AS (
    SELECT l.user_id, l.amount, r.bucket, r.sign,
           l.maturity_met, l.maturity_expired, l.withdrawable_after, l.direction, l.category
    FROM ledger l
    CROSS JOIN LATERAL public.wallet_route_for_category(l.user_id, l.category, l.direction) r(bucket, sign)
    WHERE l.wallet_bucket IS NULL
  ),
  routed AS (
    SELECT routed_explicit.user_id, routed_explicit.amount, routed_explicit.bucket, routed_explicit.sign,
           routed_explicit.maturity_met, routed_explicit.maturity_expired, routed_explicit.withdrawable_after,
           routed_explicit.direction, routed_explicit.category
    FROM routed_explicit
    UNION ALL
    SELECT routed_category.user_id, routed_category.amount, routed_category.bucket, routed_category.sign,
           routed_category.maturity_met, routed_category.maturity_expired, routed_category.withdrawable_after,
           routed_category.direction, routed_category.category
    FROM routed_category
  ),
  buckets AS (
    SELECT routed.user_id,
           sum(CASE WHEN routed.bucket = 'withdrawable' THEN routed.sign::numeric * routed.amount ELSE 0 END) AS withdrawable_raw,
           sum(CASE WHEN routed.bucket = 'float' THEN routed.sign::numeric * routed.amount ELSE 0 END) AS float_raw,
           sum(CASE WHEN routed.bucket = ANY (ARRAY['advance_credit','advance_repayment']) THEN routed.sign::numeric * routed.amount ELSE 0 END) AS advance_raw,
           sum(CASE
                 WHEN routed.bucket = 'withdrawable'
                  AND routed.direction = ANY (ARRAY['cash_in','credit'])
                  AND (
                    routed.maturity_expired = true
                    OR (routed.maturity_met = false AND now() <= COALESCE(routed.withdrawable_after, now()))
                  )
                 THEN routed.amount
                 ELSE 0
               END) AS restricted_held
    FROM routed
    GROUP BY routed.user_id
  ),
  holds AS (
    SELECT CASE
             WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
             ELSE wr.user_id
           END AS user_id,
           COALESCE(sum(wr.amount), 0) AS pending_holds
    FROM public.withdrawal_requests wr
    WHERE p_user_id IS NOT NULL
      AND (
        (wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL AND wr.agent_id = p_user_id)
        OR ((wr.proxy_partner_id IS NULL OR wr.agent_id IS NULL) AND wr.user_id = p_user_id)
      )
      AND wr.status = ANY (ARRAY['pending','requested','manager_approved','processing','approved'])
      AND NOT EXISTS (
        SELECT 1
        FROM public.general_ledger g
        WHERE g.source_table = 'withdrawal_requests'
          AND g.source_id = wr.id
          AND g.ledger_scope = 'wallet'
          AND g.direction = ANY (ARRAY['cash_out','debit'])
      )
      AND (wr.reason IS NULL OR wr.reason !~~ 'Landlord float payout%')
    GROUP BY 1
  ),
  universe AS (
    SELECT wp.user_id
    FROM public.wallets_physical wp
    WHERE wp.user_id = p_user_id
    UNION
    SELECT b.user_id FROM buckets b
    UNION
    SELECT h.user_id FROM holds h
  )
  SELECT u.user_id,
         GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(b.restricted_held, 0) - COALESCE(h.pending_holds, 0)) AS withdrawable,
         GREATEST(0, COALESCE(b.float_raw, 0)) AS float_balance,
         GREATEST(0, COALESCE(b.advance_raw, 0)) AS advance_balance,
         COALESCE(h.pending_holds, 0) AS pending_holds,
         COALESCE(b.restricted_held, 0) AS restricted_held,
         GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(b.restricted_held, 0) - COALESCE(h.pending_holds, 0))
           + GREATEST(0, COALESCE(b.float_raw, 0)) AS total_visible,
         COALESCE(b.float_raw, 0) AS float_balance_signed
  FROM universe u
  LEFT JOIN buckets b ON b.user_id = u.user_id
  LEFT JOIN holds h ON h.user_id = u.user_id;
$function$;

REVOKE ALL ON FUNCTION public.user_wallet_strict_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_wallet_strict_for(uuid) TO service_role;

COMMENT ON FUNCTION public.user_wallet_strict_for(uuid) IS
  'One user, same figures as v_user_wallet_strict. Not callable by anon or authenticated. crm_callee_dossier uses it only when wallet_balances_projection has no row.';

CREATE OR REPLACE FUNCTION public.crm_callee_dossier(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_partner_ok boolean;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_is_agent boolean; v_is_sub boolean; v_is_proxy boolean; v_is_tenant boolean; v_is_partner boolean;
  v_out jsonb;
  v_withdrawable numeric := 0;
  v_operational_float numeric := 0;
  v_advance numeric := 0;
  v_landlord_float numeric := 0;
BEGIN
  IF NOT public.crm_call_centre_authorized(v_caller) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  v_partner_ok := public._has_enabled_role(v_caller, ARRAY['partner_ops','super_admin','hr']);

  v_is_agent  := EXISTS (SELECT 1 FROM user_roles WHERE user_id=p_user_id AND enabled AND role::text IN ('agent','sub_agent','senior_agent'));
  v_is_sub    := EXISTS (SELECT 1 FROM agent_subagents WHERE sub_agent_id=p_user_id AND status IS DISTINCT FROM 'rejected');
  v_is_proxy  := EXISTS (SELECT 1 FROM proxy_agent_assignments WHERE agent_id=p_user_id)
                 OR EXISTS (SELECT 1 FROM promissory_notes WHERE agent_id=p_user_id);
  v_is_tenant := EXISTS (SELECT 1 FROM rent_requests WHERE tenant_id=p_user_id);
  v_is_partner:= EXISTS (SELECT 1 FROM investor_portfolios WHERE investor_id=p_user_id);

  -- One indexed projection row. user_wallet_strict_for runs only when that row is missing.
  SELECT bp.withdrawable, bp.float_balance, bp.advance_balance
    INTO v_withdrawable, v_operational_float, v_advance
  FROM public.wallet_balances_projection bp
  WHERE bp.user_id = p_user_id;
  IF NOT FOUND THEN
    SELECT s.withdrawable, s.float_balance, s.advance_balance
      INTO v_withdrawable, v_operational_float, v_advance
    FROM public.user_wallet_strict_for(p_user_id) s;
    IF NOT FOUND THEN
      v_withdrawable := 0;
      v_operational_float := 0;
      v_advance := 0;
    END IF;
  END IF;
  SELECT coalesce(sum(f.balance), 0)
    INTO v_landlord_float
  FROM public.agent_landlord_float f
  WHERE f.agent_id = p_user_id;

  SELECT jsonb_build_object(
    'profile', (SELECT jsonb_build_object(
        'id', p.id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone,
        'avatar_url', p.avatar_url, 'joined_at', p.created_at, 'last_active_at', p.last_active_at,
        'location', nullif(concat_ws(', ', p.village, p.parish, p.sub_county, p.district, coalesce(p.region, p.city)), ''),
        'landmark', p.landmark, 'is_frozen', p.is_frozen,
        'roles', (SELECT coalesce(jsonb_agg(DISTINCT r.role::text), '[]') FROM user_roles r WHERE r.user_id=p.id AND r.enabled))
      FROM profiles p WHERE p.id=p_user_id),
    'kinds', jsonb_build_object('agent',v_is_agent,'sub_agent',v_is_sub,'proxy_agent',v_is_proxy,'tenant',v_is_tenant,'partner',v_is_partner),
    'partner_access', v_partner_ok,
    'wallet', jsonb_build_object(
        'withdrawable', coalesce(v_withdrawable, 0),
        'operational_float', coalesce(v_operational_float, 0),
        'advance', coalesce(v_advance, 0),
        'landlord_float', coalesce(v_landlord_float, 0)),
    'wallet_txns', (SELECT coalesce(jsonb_agg(t ORDER BY t.created_at DESC), '[]') FROM (
        SELECT g.id, g.created_at, g.amount, g.direction, g.category, g.description, g.wallet_bucket,
          CASE WHEN g.category IN ('agent_repayment','rent_payment_for_tenant','agent_float_used_for_rent') THEN 'agent'
               WHEN g.category IN ('tenant_repayment','tenant_rent_settlement') THEN 'self'
               ELSE NULL END AS paid_by
        FROM general_ledger g
        WHERE g.user_id=p_user_id AND g.ledger_scope='wallet'
          AND g.classification IS DISTINCT FROM 'admin_correction' AND g.category <> 'system_balance_correction'
        ORDER BY g.created_at DESC LIMIT 10) t),
    'complaints', (SELECT coalesce(jsonb_agg(c ORDER BY c.created_at DESC), '[]') FROM (
        SELECT cc.id, cc.body_text, cc.created_at, pr.full_name AS recorded_by_name
        FROM crm_call_complaints cc LEFT JOIN profiles pr ON pr.id=cc.recorded_by
        WHERE cc.target_user_id=p_user_id ORDER BY cc.created_at DESC LIMIT 5) c)
  ) INTO v_out;

  IF v_is_agent OR v_is_sub OR v_is_proxy THEN
    v_out := v_out || jsonb_build_object('agent', jsonb_build_object(
      'totals', (SELECT jsonb_build_object(
          'today',     jsonb_build_object('count', count(*) FILTER (WHERE d=v_today),   'amount', coalesce(sum(amount) FILTER (WHERE d=v_today),0)),
          'yesterday', jsonb_build_object('count', count(*) FILTER (WHERE d=v_today-1), 'amount', coalesce(sum(amount) FILTER (WHERE d=v_today-1),0)),
          'month',     jsonb_build_object('count', count(*) FILTER (WHERE d>=date_trunc('month',v_today)::date), 'amount', coalesce(sum(amount) FILTER (WHERE d>=date_trunc('month',v_today)::date),0)),
          'all',       jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount),0)))
        FROM (SELECT amount, (created_at AT TIME ZONE 'Africa/Kampala')::date d FROM agent_collections
              WHERE agent_id=p_user_id AND reversed_at IS NULL) a),
      'collections', (SELECT coalesce(jsonb_agg(c ORDER BY c.created_at DESC), '[]') FROM (
          SELECT ac.id, ac.created_at, ac.amount, ac.payment_method::text AS payment_method, ac.tenant_id, tp.full_name AS tenant_name,
                 ((ac.created_at AT TIME ZONE 'Africa/Kampala')::date) AS kampala_day
          FROM agent_collections ac LEFT JOIN profiles tp ON tp.id=ac.tenant_id
          WHERE ac.agent_id=p_user_id AND ac.reversed_at IS NULL
          ORDER BY ac.created_at DESC LIMIT 300) c),
      'tenants', (SELECT coalesce(jsonb_agg(t ORDER BY t.outstanding DESC), '[]') FROM (
          SELECT rr.id AS rent_request_id, rr.tenant_id, tp.full_name AS tenant_name, tp.phone AS tenant_phone,
                 rr.status, coalesce(rr.daily_repayment,0) AS daily, coalesce(rr.daily_repayment,0)*7 AS weekly,
                 coalesce(rr.total_repayment,0) AS total, coalesce(rr.amount_repaid,0) AS repaid,
                 greatest(coalesce(rr.total_repayment,0)-coalesce(rr.amount_repaid,0),0) AS outstanding,
                 coalesce((SELECT sum(ac.amount) FROM agent_collections ac WHERE ac.rent_request_id=rr.id AND ac.reversed_at IS NULL
                           AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date=v_today),0) AS collected_today
          FROM rent_requests rr LEFT JOIN profiles tp ON tp.id=rr.tenant_id
          WHERE (rr.assigned_agent_id = p_user_id OR (rr.assigned_agent_id IS NULL AND rr.agent_id = p_user_id)) AND rr.status IN ('funded','repaying')
          LIMIT 500) t)));
  END IF;

  IF v_is_proxy THEN
    v_out := v_out || jsonb_build_object('proxy', jsonb_build_object(
      'notes', (SELECT coalesce(jsonb_agg(n ORDER BY n.created_at DESC), '[]') FROM (
          SELECT id, partner_name, phone_number, email, amount, contribution_type, deduction_day, status,
                 total_collected, next_deduction_date, recorded_on, fulfilment_due_on, follow_up_status,
                 last_followed_up_on, follow_up_note, notes, created_at, approved_at, partner_user_id,
                 (partner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM investor_portfolios ip WHERE ip.investor_id=promissory_notes.partner_user_id AND ip.status IN ('active','locked'))) AS came_in
          FROM promissory_notes WHERE agent_id=p_user_id LIMIT 200) n),
      'partners', (SELECT coalesce(jsonb_agg(x ORDER BY x.created_at DESC), '[]') FROM (
          SELECT a.beneficiary_id, bp.full_name, bp.phone, a.approval_status, a.is_active, a.is_managed_account, a.created_at,
                 EXISTS (SELECT 1 FROM investor_portfolios ip WHERE ip.investor_id=a.beneficiary_id AND ip.status IN ('active','locked')) AS came_in,
                 CASE WHEN v_partner_ok THEN (SELECT coalesce(sum(investment_amount),0) FROM investor_portfolios ip
                      WHERE ip.investor_id=a.beneficiary_id AND ip.status IN ('active','locked')) END AS active_support
          FROM proxy_agent_assignments a LEFT JOIN profiles bp ON bp.id=a.beneficiary_id
          WHERE a.agent_id=p_user_id LIMIT 200) x)));
  END IF;

  IF v_is_tenant THEN
    v_out := v_out || jsonb_build_object('tenant', jsonb_build_object(
      'plans', (SELECT coalesce(jsonb_agg(pl ORDER BY pl.created_at DESC), '[]') FROM (
          SELECT rr.id, rr.status, rr.rent_amount, rr.total_repayment, rr.amount_repaid, rr.daily_repayment, rr.duration_days, coalesce(rr.repayment_frequency,'daily') AS repayment_frequency,
                 greatest(coalesce(rr.total_repayment,0)-coalesce(rr.amount_repaid,0),0) AS outstanding,
                 rr.created_at, rr.funded_at, rr.tenancy_status, ap.full_name AS agent_name
          FROM rent_requests rr LEFT JOIN profiles ap ON ap.id=coalesce(rr.assigned_agent_id, rr.agent_id)
          WHERE rr.tenant_id=p_user_id AND rr.status <> 'deleted_by_agent') pl),
      'repayments', (SELECT coalesce(jsonb_agg(r ORDER BY r.created_at DESC), '[]') FROM (
          SELECT rp.id, rp.rent_request_id, rp.amount, rp.created_at, rp.payment_method,
                 CASE WHEN rp.initiated_by=rp.tenant_id OR rp.paid_by=rp.tenant_id THEN 'self' ELSE 'agent' END AS paid_by,
                 (SELECT ap.full_name FROM agent_collections ac JOIN profiles ap ON ap.id=ac.agent_id
                   WHERE ac.tenant_id=rp.tenant_id AND ac.amount=rp.amount
                     AND abs(extract(epoch FROM ac.created_at-rp.created_at))<300 LIMIT 1) AS agent_name
          FROM repayments rp WHERE rp.tenant_id=p_user_id ORDER BY rp.created_at DESC LIMIT 200) r),
      'last_collection', (SELECT jsonb_build_object('amount', ac.amount, 'created_at', ac.created_at, 'agent_name', ap.full_name)
          FROM agent_collections ac LEFT JOIN profiles ap ON ap.id=ac.agent_id
          WHERE ac.tenant_id=p_user_id AND ac.reversed_at IS NULL ORDER BY ac.created_at DESC LIMIT 1),
      'paid_totals', (SELECT jsonb_build_object(
          'today', jsonb_build_object('amount', coalesce(sum(amount) FILTER (WHERE d = (now() AT TIME ZONE 'Africa/Kampala')::date),0), 'count', count(*) FILTER (WHERE d = (now() AT TIME ZONE 'Africa/Kampala')::date)),
          'yesterday', jsonb_build_object('amount', coalesce(sum(amount) FILTER (WHERE d = (now() AT TIME ZONE 'Africa/Kampala')::date - 1),0), 'count', count(*) FILTER (WHERE d = (now() AT TIME ZONE 'Africa/Kampala')::date - 1)),
          'month', jsonb_build_object('amount', coalesce(sum(amount) FILTER (WHERE d >= date_trunc('month', now() AT TIME ZONE 'Africa/Kampala')::date),0), 'count', count(*) FILTER (WHERE d >= date_trunc('month', now() AT TIME ZONE 'Africa/Kampala')::date)),
          'all', jsonb_build_object('amount', coalesce(sum(amount),0), 'count', count(*)))
        FROM (SELECT ac.amount, (ac.created_at AT TIME ZONE 'Africa/Kampala')::date d FROM agent_collections ac
               WHERE ac.tenant_id=p_user_id AND ac.reversed_at IS NULL) x)));
  END IF;

  IF v_is_partner THEN
    IF NOT v_partner_ok THEN
      v_out := v_out || jsonb_build_object('partner', jsonb_build_object('restricted', true));
    ELSE
      v_out := v_out || jsonb_build_object('partner', jsonb_build_object('restricted', false,
        'portfolios', (SELECT coalesce(jsonb_agg(ip ORDER BY ip.created_at DESC), '[]') FROM (
            SELECT id, portfolio_code, investment_amount, duration_months, roi_percentage, roi_mode, status,
                   created_at, maturity_date, next_roi_date, total_roi_earned, payout_day, auto_reinvest, payment_method
            FROM investor_portfolios WHERE investor_id=p_user_id LIMIT 200) ip),
        'topups', (SELECT coalesce(jsonb_agg(t ORDER BY t.created_at DESC), '[]') FROM (
            SELECT id, amount, status, effective_at, prorata_amount, created_at FROM partner_self_topups
            WHERE partner_id=p_user_id ORDER BY created_at DESC LIMIT 100) t),
        'changes', (SELECT coalesce(jsonb_agg(c ORDER BY c.changed_at DESC), '[]') FROM (
            SELECT id, action, portfolio_id, portfolio_code, changed_fields, changed_at
            FROM portfolio_change_log WHERE partner_id=p_user_id ORDER BY changed_at DESC LIMIT 100) c),
        'returns', (SELECT coalesce(jsonb_agg(g ORDER BY g.created_at DESC), '[]') FROM (
            SELECT id, created_at, amount, direction, category, description FROM general_ledger
            WHERE user_id=p_user_id AND ledger_scope='wallet' AND category ILIKE 'roi%'
              AND classification IS DISTINCT FROM 'admin_correction'
            ORDER BY created_at DESC LIMIT 100) g)));
    END IF;
  END IF;

  RETURN v_out;
END $function$;

REVOKE ALL ON FUNCTION public.crm_callee_dossier(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_callee_dossier(uuid) TO authenticated, service_role;

DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.user_wallet_strict_for(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.user_wallet_strict_for(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'user_wallet_strict_for is still executable by anon or authenticated';
  END IF;
  IF position('v_user_wallet_strict' in (
       SELECT prosrc FROM pg_proc WHERE oid = 'public.crm_callee_dossier(uuid)'::regprocedure
     )) > 0 THEN
    RAISE EXCEPTION 'crm_callee_dossier still reads v_user_wallet_strict';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.crm_callee_dossier(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.crm_callee_dossier(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'crm_callee_dossier grants changed: authenticated must keep EXECUTE and anon must not';
  END IF;
END
$post$;

RESET lock_timeout;
