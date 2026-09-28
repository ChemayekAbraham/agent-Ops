-- Reporting only. Reads rent_requests / audit_logs; writes nothing.

CREATE OR REPLACE FUNCTION public.rent_plan_waterfall_report()
RETURNS TABLE (
  rent_request_id uuid, tenant_id uuid, duration_days integer, status text, created_at timestamptz,
  rent numeric, total_repayment numeric, fees numeric, amount_repaid numeric,
  principal numeric, agent_commission numeric, partner_returns_target numeric, partner_returns numeric,
  partner_returns_memo_gap numeric, platform_fee numeric,
  collected_principal numeric, collected_agent_commission numeric, collected_partner_returns numeric, collected_platform_fee numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['cfo','ceo','super_admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH b AS (
    SELECT r.id, r.tenant_id, r.duration_days, r.status, r.created_at,
           r.rent_amount AS rr, r.total_repayment AS tt, coalesce(r.amount_repaid,0) AS pd,
           round(0.10 * r.total_repayment) AS comm,
           round(0.15 * r.rent_amount) AS ptarget
      FROM public.rent_requests r
     WHERE r.status IN ('funded','repaying') AND r.rent_amount > 0 AND r.total_repayment > 0
       AND r.total_repayment > r.rent_amount
       AND (r.total_repayment - r.rent_amount) >= round(0.10 * r.total_repayment)
  ), w AS (
    SELECT b.*, least(b.ptarget, b.tt - b.rr - b.comm) AS partner FROM b
  ), s AS (
    SELECT w.*, (w.tt - w.rr - w.comm - w.partner) AS plat,
           floor(w.pd * w.comm / w.tt) AS c_comm,
           floor(w.pd * w.partner / w.tt) AS c_part,
           floor(w.pd * (w.tt - w.rr - w.comm - w.partner) / w.tt) AS c_plat
      FROM w
  )
  SELECT s.id, s.tenant_id, s.duration_days, s.status, s.created_at,
         s.rr, s.tt, s.tt - s.rr, s.pd,
         s.rr, s.comm, s.ptarget, s.partner, s.ptarget - s.partner, s.plat,
         s.pd - s.c_comm - s.c_part - s.c_plat, s.c_comm, s.c_part, s.c_plat
    FROM s;
END $$;

CREATE OR REPLACE FUNCTION public.rent_plan_waterfall_exceptions()
RETURNS TABLE (
  rent_request_id uuid, tenant_id uuid, duration_days integer, status text, created_at timestamptz,
  exception_type text, below_principal boolean,
  rent numeric, total_repayment numeric, amount_repaid numeric, gap_to_principal numeric,
  fees numeric, agent_commission numeric, commission_fee_shortfall numeric,
  correction_count integer, correction_before_total numeric, correction_after_total numeric,
  correction_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['cfo','ceo','super_admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH e AS (
    SELECT r.id, r.tenant_id, r.duration_days, r.status, r.created_at,
           r.rent_amount AS rr, r.total_repayment AS tt, coalesce(r.amount_repaid,0) AS pd,
           round(0.10 * r.total_repayment) AS comm,
           CASE WHEN r.total_repayment <= r.rent_amount THEN 'legacy_carryover'
                ELSE 'commission_fee_shortfall' END AS kind
      FROM public.rent_requests r
     WHERE r.status IN ('funded','repaying') AND r.rent_amount > 0 AND r.total_repayment > 0
       AND (r.total_repayment <= r.rent_amount
            OR (r.total_repayment - r.rent_amount) < round(0.10 * r.total_repayment))
  )
  SELECT e.id, e.tenant_id, e.duration_days, e.status, e.created_at,
         e.kind, e.tt < e.rr,
         e.rr, e.tt, e.pd, greatest(e.rr - e.tt, 0),
         e.tt - e.rr, e.comm,
         CASE WHEN e.kind = 'commission_fee_shortfall' THEN e.comm - (e.tt - e.rr) ELSE 0 END,
         coalesce(c.n, 0)::integer, c.before_t, c.after_t, c.at
    FROM e
    LEFT JOIN LATERAL (
      SELECT count(*) OVER () AS n,
             (a.metadata->'before'->>'total_repayment')::numeric AS before_t,
             (a.metadata->'after'->>'total_repayment')::numeric AS after_t,
             a.created_at AS at
        FROM public.audit_logs a
       WHERE a.table_name = 'rent_requests' AND a.record_id = e.id::text
         AND a.action_type = 'tenant_ops_outstanding_correction'
       ORDER BY a.created_at DESC LIMIT 1
    ) c ON true;
END $$;

REVOKE ALL ON FUNCTION public.rent_plan_waterfall_report() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rent_plan_waterfall_exceptions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_plan_waterfall_report() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rent_plan_waterfall_exceptions() TO authenticated;