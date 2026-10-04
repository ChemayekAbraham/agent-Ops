CREATE TABLE IF NOT EXISTS public.crm_call_complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL,
  call_session_id uuid NULL REFERENCES public.crm_call_sessions(id) ON DELETE SET NULL,
  body_html text NOT NULL,
  body_text text NOT NULL,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.crm_call_complaints TO authenticated;
GRANT ALL ON public.crm_call_complaints TO service_role;
ALTER TABLE public.crm_call_complaints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Call centre staff read complaints" ON public.crm_call_complaints
  FOR SELECT TO authenticated USING ((SELECT public.crm_call_centre_authorized(auth.uid())));
CREATE INDEX IF NOT EXISTS idx_crm_call_complaints_target ON public.crm_call_complaints(target_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.crm_record_call_complaint(
  p_target_user_id uuid, p_call_session_id uuid, p_body_html text, p_body_text text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF length(btrim(coalesce(p_body_text,''))) < 3 THEN RAISE EXCEPTION 'complaint_too_short'; END IF;
  INSERT INTO public.crm_call_complaints(target_user_id, call_session_id, body_html, body_text, recorded_by)
  VALUES (p_target_user_id, p_call_session_id, left(p_body_html, 20000), left(btrim(p_body_text), 10000), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.crm_record_call_complaint(uuid,uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.crm_record_call_complaint(uuid,uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.crm_callee_dossier(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_partner_ok boolean;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_is_agent boolean; v_is_sub boolean; v_is_proxy boolean; v_is_tenant boolean; v_is_partner boolean;
  v_out jsonb;
BEGIN
  IF NOT public.crm_call_centre_authorized(v_caller) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  v_partner_ok := public._has_enabled_role(v_caller, ARRAY['partner_ops','super_admin','hr']);

  v_is_agent  := EXISTS (SELECT 1 FROM user_roles WHERE user_id=p_user_id AND enabled AND role::text IN ('agent','sub_agent','senior_agent'));
  v_is_sub    := EXISTS (SELECT 1 FROM agent_subagents WHERE sub_agent_id=p_user_id AND status IS DISTINCT FROM 'rejected');
  v_is_proxy  := EXISTS (SELECT 1 FROM proxy_agent_assignments WHERE agent_id=p_user_id)
                 OR EXISTS (SELECT 1 FROM promissory_notes WHERE agent_id=p_user_id);
  v_is_tenant := EXISTS (SELECT 1 FROM rent_requests WHERE tenant_id=p_user_id);
  v_is_partner:= EXISTS (SELECT 1 FROM investor_portfolios WHERE investor_id=p_user_id);

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
    'wallet', (SELECT jsonb_build_object(
        'withdrawable', coalesce(w.withdrawable_balance,0), 'operational_float', coalesce(w.float_balance,0),
        'advance', coalesce(w.advance_balance,0),
        'landlord_float', coalesce((SELECT sum(balance) FROM agent_landlord_float f WHERE f.agent_id=p_user_id),0))
      FROM (SELECT 1) x LEFT JOIN wallets w ON w.user_id=p_user_id),
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
          WHERE coalesce(rr.assigned_agent_id, rr.agent_id)=p_user_id AND rr.status IN ('funded','repaying')
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
          SELECT rr.id, rr.status, rr.rent_amount, rr.total_repayment, rr.amount_repaid, rr.daily_repayment, rr.duration_days,
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
          WHERE ac.tenant_id=p_user_id AND ac.reversed_at IS NULL ORDER BY ac.created_at DESC LIMIT 1)));
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
END $$;
REVOKE ALL ON FUNCTION public.crm_callee_dossier(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.crm_callee_dossier(uuid) TO authenticated;