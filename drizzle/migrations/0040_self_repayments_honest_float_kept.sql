-- Make the tenant self-repayments card truthful:
--  1. float_kept: settled rows keep surplus_amount; refused rows kept the whole
--     deposit minus whatever was applied (deposits are credited at approval time,
--     independent of the repayment outcome).
--  2. kept_bucket: deposits route to float by default; only cash-receipt-code
--     'personal_deposit' deposits route to withdrawable (approve-deposit, 2026-09-07).

CREATE OR REPLACE VIEW public.v_tenant_self_repayments AS
SELECT
  a.id AS attempt_id,
  a.created_at AS paid_at,
  a.tenant_id,
  tp.full_name AS tenant_name,
  a.paid_from_phone,
  a.deposit_request_id,
  dr.amount AS amount_deposited,
  dr.provider,
  dr.transaction_id AS external_reference,
  a.applied_amount,
  a.surplus_amount,
  a.outcome,
  a.reason AS refusal_reason,
  a.rent_request_id,
  rr.total_repayment,
  rr.amount_repaid,
  GREATEST((0)::numeric, (COALESCE(rr.total_repayment, (0)::numeric) - COALESCE(rr.amount_repaid, (0)::numeric))) AS outstanding_after,
  rr.status AS plan_status,
  a.agent_id,
  ap.full_name AS agent_name,
  ((a.metadata ->> 'commission_agent'::text))::numeric AS commission_agent,
  ((a.metadata ->> 'commission_parent'::text))::numeric AS commission_parent,
  ((a.metadata ->> 'commission_total'::text))::numeric AS commission_total,
  ((a.metadata ->> 'parent_agent_id'::text))::uuid AS parent_agent_id,
  a.transaction_group_id,
  ac.tracking_id,
  ac.collection_channel,
  ac.performance_weight,
  CASE
    WHEN a.outcome = 'settled' THEN COALESCE(a.surplus_amount, (0)::numeric)
    ELSE COALESCE(dr.amount, (0)::numeric) - COALESCE(a.applied_amount, (0)::numeric)
  END AS float_kept,
  CASE
    WHEN dr.deposit_purpose = 'personal_deposit'
         AND EXISTS (SELECT 1 FROM public.cash_deposit_verifications v WHERE v.deposit_request_id = dr.id)
    THEN 'withdrawable'
    ELSE 'float'
  END AS kept_bucket
FROM public.tenant_self_repayment_attempts a
LEFT JOIN public.profiles tp ON tp.id = a.tenant_id
LEFT JOIN public.profiles ap ON ap.id = a.agent_id
LEFT JOIN public.deposit_requests dr ON dr.id = a.deposit_request_id
LEFT JOIN public.rent_requests rr ON rr.id = a.rent_request_id
LEFT JOIN public.agent_collections ac ON ac.deposit_request_id = a.deposit_request_id;

CREATE OR REPLACE FUNCTION public.get_tenant_self_repayments(
  p_from timestamp with time zone DEFAULT (now() - '30 days'::interval),
  p_to timestamp with time zone DEFAULT now(),
  p_outcome text DEFAULT NULL::text,
  p_search text DEFAULT NULL::text,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
  v_total bigint;
  v_totals jsonb;
BEGIN
  IF NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'tenant_ops') OR public.has_role(v_uid, 'agent_ops')
    OR public.has_role(v_uid, 'coo') OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'operations') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  WITH base AS (
    SELECT * FROM public.tenant_self_repayment_attempts a
     WHERE a.created_at >= p_from AND a.created_at <= p_to
       AND (p_outcome IS NULL OR a.outcome = p_outcome)
  ), joined AS (
    SELECT v.* FROM public.v_tenant_self_repayments v
     JOIN base b ON b.id = v.attempt_id
     WHERE p_search IS NULL OR p_search = ''
       OR v.tenant_name ILIKE '%' || p_search || '%'
       OR v.agent_name ILIKE '%' || p_search || '%'
       OR v.paid_from_phone ILIKE '%' || p_search || '%'
       OR COALESCE(v.external_reference, '') ILIKE '%' || p_search || '%'
       OR COALESCE(v.tracking_id, '') ILIKE '%' || p_search || '%'
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.paid_at DESC), '[]'::jsonb),
    (SELECT count(*) FROM joined),
    (SELECT jsonb_build_object(
        'settled_count', count(*) FILTER (WHERE outcome = 'settled'),
        'refused_count', count(*) FILTER (WHERE outcome <> 'settled'),
        'total_applied', COALESCE(sum(applied_amount), 0),
        'total_surplus', COALESCE(sum(float_kept), 0),
        'total_commission', COALESCE(sum(commission_total), 0)
      ) FROM joined)
  INTO v_rows, v_total, v_totals
  FROM (
    SELECT * FROM joined ORDER BY paid_at DESC LIMIT GREATEST(1, LEAST(p_limit, 500)) OFFSET GREATEST(0, p_offset)
  ) t;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total, 'totals', v_totals);
END;
$function$;