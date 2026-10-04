-- =====================================================================
-- PHASE 8: queue visibility. Merchant queue stays actionable-only;
-- FinOps/CFO get a dedicated reconciliation surface for dangerous states.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.payout_reconciliation_bucket(
  p_status text,
  p_settlement_state text,
  p_missing jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_status IN ('paid','completed','disbursed')
     AND p_settlement_state <> 'settled'
     AND coalesce(p_missing, '[]'::jsonb) ? 'customer_wallet_debit'
      THEN 'ledger_gap'
    WHEN p_status IN ('paid','completed','disbursed')
     AND p_settlement_state = 'unsettled'
     AND jsonb_array_length(coalesce(p_missing, '[]'::jsonb)) >= 3
      THEN 'paid_without_settlement'
    WHEN p_status IN ('paid','completed','disbursed')
     AND p_settlement_state = 'unsettled'
      THEN 'partial_settlement'
    WHEN p_status IN ('processing','failed','held')
     AND p_settlement_state = 'unsettled'
      THEN 'settlement_failed'
    WHEN p_status = 'processing'
      THEN 'processing'
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.payout_reconciliation_bucket(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payout_reconciliation_bucket(text, text, jsonb) TO authenticated, service_role;

-- Role gate: finance/exec only ------------------------------------------
CREATE OR REPLACE FUNCTION public.can_view_payout_reconciliation(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id
      AND role IN ('cfo','financial_ops','manager','super_admin','ceo','coo')
  );
$$;

REVOKE ALL ON FUNCTION public.can_view_payout_reconciliation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_view_payout_reconciliation(uuid) TO authenticated, service_role;

-- Counts summary ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_payout_reconciliation_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res jsonb;
BEGIN
  IF NOT public.can_view_payout_reconciliation(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT coalesce(jsonb_object_agg(bucket, cnt), '{}'::jsonb) INTO v_res
  FROM (
    SELECT public.payout_reconciliation_bucket(w.status, w.settlement_state, w.settlement_missing_legs) AS bucket,
           count(*) AS cnt,
           sum(w.amount) AS amt
      FROM public.withdrawal_requests w
     WHERE w.status IN ('processing','failed','held','paid','completed','disbursed')
       AND w.settlement_state <> 'settled'
     GROUP BY 1
  ) s
  WHERE bucket IS NOT NULL;

  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.get_payout_reconciliation_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payout_reconciliation_counts() TO authenticated, service_role;

-- Paged queue ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_payout_reconciliation_queue(
  p_bucket text DEFAULT 'all',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  withdrawal_id uuid,
  bucket text,
  amount numeric,
  status text,
  settlement_state text,
  settlement_missing_legs jsonb,
  settlement_checked_at timestamptz,
  settlement_attempts integer,
  user_id uuid,
  user_name text,
  user_phone text,
  merchant_id uuid,
  merchant_name text,
  payout_method text,
  fin_ops_reference text,
  has_payment_evidence boolean,
  created_at timestamptz,
  processed_at timestamptz,
  age_hours numeric,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_view_payout_reconciliation(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT w.*,
           public.payout_reconciliation_bucket(w.status, w.settlement_state, w.settlement_missing_legs) AS bkt
      FROM public.withdrawal_requests w
     WHERE w.status IN ('processing','failed','held','paid','completed','disbursed')
       AND w.settlement_state <> 'settled'
  ), filtered AS (
    SELECT * FROM base
     WHERE bkt IS NOT NULL
       AND (coalesce(p_bucket, 'all') = 'all' OR bkt = p_bucket)
  ), counted AS (
    SELECT count(*) AS n FROM filtered
  )
  SELECT f.id,
         f.bkt,
         f.amount,
         f.status,
         f.settlement_state,
         f.settlement_missing_legs,
         f.settlement_checked_at,
         f.settlement_attempts,
         f.user_id,
         p.full_name,
         p.phone,
         m.mid,
         mp.full_name,
         f.payout_method,
         f.fin_ops_reference,
         EXISTS (SELECT 1 FROM public.withdrawal_payment_evidence e WHERE e.withdrawal_id = f.id),
         f.created_at,
         f.processed_at,
         round(extract(epoch FROM (now() - coalesce(f.processed_at, f.created_at))) / 3600.0, 1),
         c.n
    FROM filtered f
    CROSS JOIN counted c
    LEFT JOIN public.profiles p ON p.id = f.user_id
    LEFT JOIN LATERAL (
      SELECT coalesce(
               f.processing_started_by,
               (SELECT ca.agent_id FROM public.cashout_agents ca WHERE ca.id = f.assigned_cashout_agent_id),
               f.dispatch_claimed_by
             ) AS mid
    ) m ON true
    LEFT JOIN public.profiles mp ON mp.id = m.mid
   ORDER BY CASE f.bkt
              WHEN 'ledger_gap' THEN 1
              WHEN 'paid_without_settlement' THEN 2
              WHEN 'partial_settlement' THEN 3
              WHEN 'settlement_failed' THEN 4
              ELSE 5
            END,
            coalesce(f.processed_at, f.created_at) ASC
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  OFFSET greatest(0, coalesce(p_offset, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.get_payout_reconciliation_queue(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payout_reconciliation_queue(text, integer, integer) TO authenticated, service_role;