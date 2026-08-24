-- Batch plan/probe helper for bulk advance reversal.
-- One round trip for a whole batch: no N+1 calls to advance_reversal_plan.
CREATE OR REPLACE FUNCTION public.advance_reversal_plan_batch(
  p_advance_ids uuid[] DEFAULT NULL,
  p_today_only boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_rows jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.has_role(v_caller, 'cfo'::app_role) OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can reverse an advance';
  END IF;

  WITH base AS (
    SELECT a.id, a.agent_id, a.request_id, a.status, a.principal,
           a.outstanding_balance, a.reversed_at, a.issued_at
    FROM public.agent_advances a
    WHERE (p_advance_ids IS NULL OR a.id = ANY(p_advance_ids))
      AND (
        p_advance_ids IS NOT NULL
        OR (
          a.reversed_at IS NULL
          AND (a.issued_at AT TIME ZONE 'Africa/Kampala')::date
              = (now() AT TIME ZONE 'Africa/Kampala')::date
        )
      )
  ), enriched AS (
    SELECT
      b.*,
      r.status AS request_status,
      r.reviewed_by_agent_ops,
      COALESCE(r.cfo_paid_at, r.cfo_approved_at, b.issued_at) AS approved_at,
      p.full_name AS agent_name,
      p.phone AS agent_phone,
      COALESCE(d.disbursed_amount, 0) AS disbursed_amount,
      COALESCE(c.clawed, 0) AS clawback_posted_amount,
      COALESCE(public.get_user_available_balance(b.agent_id), 0) AS withdrawable
    FROM base b
    LEFT JOIN public.agent_advance_requests r ON r.id = b.request_id
    LEFT JOIN public.profiles p ON p.id = b.agent_id
    LEFT JOIN LATERAL (
      SELECT SUM(gl.amount) AS disbursed_amount
      FROM public.general_ledger gl
      WHERE gl.source_table = 'agent_advance_requests'
        AND gl.source_id = b.request_id
        AND gl.category = 'agent_advance_credit'
        AND gl.ledger_scope = 'wallet'
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT SUM(o.amount) AS clawed
      FROM public.cfo_debit_obligations o
      WHERE o.user_id = b.agent_id
        AND o.metadata->>'sub_category' = 'advance_reversal:' || b.id::text
    ) c ON true
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'agent_name' NULLS LAST), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'advance_id', e.id,
      'agent_id', e.agent_id,
      'agent_name', e.agent_name,
      'agent_phone', e.agent_phone,
      'request_id', e.request_id,
      'has_request', e.request_id IS NOT NULL,
      'status', e.status,
      'request_status', e.request_status,
      'principal', COALESCE(e.principal, 0),
      'outstanding_balance', COALESCE(e.outstanding_balance, 0),
      'already_reversed', e.reversed_at IS NOT NULL,
      'approved_at', e.approved_at,
      'approved_today', (e.approved_at AT TIME ZONE 'Africa/Kampala')::date
                        = (now() AT TIME ZONE 'Africa/Kampala')::date,
      'disbursed', e.disbursed_amount > 0,
      'disbursed_amount', e.disbursed_amount,
      'clawback_posted_amount', e.clawback_posted_amount,
      'amount_to_reverse', GREATEST(0, e.disbursed_amount - e.clawback_posted_amount),
      'withdrawable', e.withdrawable,
      'recoverable_now', GREATEST(0, LEAST(e.disbursed_amount - e.clawback_posted_amount, e.withdrawable)),
      'shortfall', GREATEST(0,
        GREATEST(0, e.disbursed_amount - e.clawback_posted_amount)
        - GREATEST(0, LEAST(e.disbursed_amount - e.clawback_posted_amount, e.withdrawable))),
      'clawback_tag', 'advance_reversal:' || e.id::text
    ) AS x
    FROM enriched e
    WHERE p_today_only = false
       OR p_advance_ids IS NOT NULL
       OR (e.approved_at AT TIME ZONE 'Africa/Kampala')::date
          = (now() AT TIME ZONE 'Africa/Kampala')::date
  ) s;

  RETURN jsonb_build_object('rows', v_rows, 'count', jsonb_array_length(v_rows));
END;
$function$;

REVOKE ALL ON FUNCTION public.advance_reversal_plan_batch(uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_reversal_plan_batch(uuid[], boolean) TO authenticated;