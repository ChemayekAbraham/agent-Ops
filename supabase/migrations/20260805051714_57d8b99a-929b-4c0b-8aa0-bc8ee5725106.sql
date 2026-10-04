CREATE OR REPLACE FUNCTION public.partner_self_nearing_payouts(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_days integer := GREATEST(0, LEAST(COALESCE(p_days, 7), 60));
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT (
      public.is_ops_role(v_uid) OR public.has_role(v_uid,'partner_ops') OR public.has_role(v_uid,'financial_ops') OR public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'coo')
      OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'manager') OR public.has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501';
  END IF;

  RETURN (
    WITH due AS (
      SELECT cm.id AS commitment_id,
             cm.partner_id,
             COALESCE(NULLIF(btrim(pr.full_name),''),'Partner') AS partner_name,
             pr.phone AS partner_phone,
             cm.committed_amount,
             cm.monthly_rate,
             cm.next_payout_at::date AS next_payout_date,
             (cm.next_payout_at::date - CURRENT_DATE) AS days_until,
             (SELECT COALESCE(SUM(l.principal),0)
                FROM public.partner_self_funding_lines l
               WHERE l.commitment_id = cm.id AND l.status = 'active') AS active_principal,
             (SELECT COALESCE(SUM(p.total_amount),0)
                FROM public.partner_self_payout_cycles p
               WHERE p.commitment_id = cm.id AND p.status = 'pending') AS pending_amount,
             cm.total_earned,
             cm.total_paid
        FROM public.partner_self_commitments cm
        LEFT JOIN public.profiles pr ON pr.id = cm.partner_id
       WHERE cm.status = 'active'
         AND cm.next_payout_at IS NOT NULL
         AND cm.next_payout_at::date <= (CURRENT_DATE + v_days)
    )
    SELECT jsonb_build_object(
      'count', (SELECT COUNT(*) FROM due),
      'expected_total', (SELECT COALESCE(SUM(GREATEST(pending_amount,
                          round(active_principal * monthly_rate / 100))), 0) FROM due),
      'rows', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'commitment_id', d.commitment_id,
                 'partner_id', d.partner_id,
                 'partner_name', d.partner_name,
                 'partner_phone', d.partner_phone,
                 'committed_amount', d.committed_amount,
                 'active_principal', d.active_principal,
                 'monthly_rate', d.monthly_rate,
                 'next_payout_date', d.next_payout_date,
                 'days_until', d.days_until,
                 'expected_amount', GREATEST(d.pending_amount,
                                    round(d.active_principal * d.monthly_rate / 100)),
                 'pending_amount', d.pending_amount,
                 'total_earned', d.total_earned,
                 'total_paid', d.total_paid
               ) ORDER BY d.next_payout_date ASC), '[]'::jsonb)
        FROM due d
      )
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_self_portfolio(p_partner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid := COALESCE(p_partner_id, auth.uid());
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF v_target <> v_uid AND NOT (
      public.is_ops_role(v_uid) OR public.has_role(v_uid,'partner_ops') OR public.has_role(v_uid,'financial_ops') OR public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'coo')
      OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'manager') OR public.has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501';
  END IF;

  RETURN (
    WITH commitments AS (
      SELECT * FROM public.partner_self_commitments WHERE partner_id = v_target
    ),
    lines AS (
      SELECT l.*, rr.rent_amount, rr.duration_days, rr.daily_repayment,
             rr.request_city, rr.house_category, rr.status AS plan_status,
             rr.disbursed_at, rr.amount_repaid,
             split_part(COALESCE(NULLIF(btrim(tp.full_name),''),'Tenant'),' ',1) AS tenant_first_name,
             tp.full_name AS tenant_full_name,
             tp.avatar_url AS tenant_avatar_url,
             COALESCE(NULLIF(btrim(lp.full_name),''),'Landlord') AS landlord_name
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
      WHERE l.partner_id = v_target AND l.status <> 'cancelled'
    ),
    holds AS (
      SELECT * FROM public.partner_self_plan_claims
      WHERE partner_id = v_target AND status='held' AND expires_at > now()
    ),
    payouts AS (
      SELECT * FROM public.partner_self_payout_cycles WHERE partner_id = v_target
    )
    SELECT jsonb_build_object(
      'available_balance', public.get_user_available_balance(v_target),
      'minimum_funding', 50000,
      'totals', jsonb_build_object(
        'committed', (SELECT COALESCE(SUM(committed_amount),0) FROM commitments WHERE status <> 'cancelled'),
        'active', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='active'),
        'earning', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='active'),
        'idle', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='idle'),
        'completed', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='completed'),
        'total_earned', (SELECT COALESCE(SUM(total_earned),0) FROM commitments),
        'total_paid', (SELECT COALESCE(SUM(total_paid),0) FROM commitments),
        'lines_count', (SELECT COUNT(*) FROM lines)
      ),
      'commitments', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb) FROM commitments c),
      'lines', (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC), '[]'::jsonb) FROM lines l),
      'active_holds', (SELECT COALESCE(jsonb_agg(to_jsonb(h)), '[]'::jsonb) FROM holds h),
      'payout_cycles', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.cycle_end DESC), '[]'::jsonb) FROM payouts p),
      'next_payout', (SELECT jsonb_build_object('date', MIN(next_payout_at))
                        FROM commitments WHERE status='active' AND next_payout_at IS NOT NULL)
    )
  );
END;
$function$;