CREATE OR REPLACE FUNCTION public.merchant_float_visible_net(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH anchor AS (
    SELECT a.anchor_at FROM public.wallet_fresh_start_anchors a
    WHERE a.user_id = p_agent_id LIMIT 1
  ), ledger AS (
    SELECT gl.user_id, gl.category, gl.direction, gl.amount, gl.wallet_bucket
    FROM public.general_ledger gl
    LEFT JOIN anchor a ON true
    WHERE gl.user_id = p_agent_id
      AND gl.ledger_scope = 'wallet'
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction = ANY (ARRAY['debit','cash_out'])
        )
      )
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
  ), routed AS (
    SELECT l.amount,
           l.wallet_bucket AS bucket,
           CASE
             WHEN l.direction = ANY (ARRAY['cash_in','credit']) THEN 1
             WHEN l.direction = ANY (ARRAY['cash_out','debit']) THEN -1
             ELSE 0
           END AS sign
    FROM ledger l
    WHERE l.wallet_bucket = ANY (ARRAY['withdrawable','float','advance_credit','advance_repayment'])
    UNION ALL
    SELECT l.amount, r.bucket, r.sign
    FROM ledger l
    CROSS JOIN LATERAL public.wallet_route_for_category(l.user_id, l.category, l.direction) AS r(bucket, sign)
    WHERE l.wallet_bucket IS NULL
  )
  SELECT COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END), 0)
  FROM routed;
$$;

REVOKE ALL ON FUNCTION public.merchant_float_visible_net(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merchant_float_visible_net(uuid) TO authenticated, service_role;