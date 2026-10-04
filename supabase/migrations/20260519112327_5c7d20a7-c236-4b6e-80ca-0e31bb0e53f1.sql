-- RPC: Agent Float Breakdown
-- Returns every float-bucket ledger leg for an agent since their fresh-start
-- anchor (or all-time if no anchor), with a running float balance. Mirrors the
-- routing logic used inside v_user_wallet_strict so the totals reconcile to
-- the agent's displayed float_balance exactly.
--
-- RLS: SECURITY DEFINER but gated to the calling agent OR staff roles.

CREATE OR REPLACE FUNCTION public.get_agent_float_breakdown(
  p_user_id uuid,
  p_limit int DEFAULT 200
)
RETURNS TABLE (
  entry_id uuid,
  occurred_at timestamptz,
  category text,
  direction text,
  amount numeric,
  signed_amount numeric,
  running_balance numeric,
  description text,
  transaction_group_id uuid,
  linked_party uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _is_staff boolean := false;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;

  -- Allow self OR any staff role that already has CFO/ops visibility.
  IF _caller <> p_user_id THEN
    SELECT EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = _caller
        AND ur.role IN ('super_admin','manager','cfo','coo','ceo','cto','operations','employee')
    ) INTO _is_staff;
    IF NOT _is_staff THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;

  RETURN QUERY
  WITH anchor AS (
    SELECT anchor_at FROM wallet_fresh_start_anchors WHERE user_id = p_user_id
  ),
  routed AS (
    SELECT
      gl.id AS entry_id,
      gl.created_at AS occurred_at,
      gl.category,
      gl.direction,
      gl.amount,
      gl.description,
      gl.transaction_group_id,
      gl.linked_party,
      COALESCE(gl.wallet_bucket, (wallet_route_for_category(p_user_id, gl.category, gl.direction)).bucket) AS bucket,
      CASE
        WHEN gl.wallet_bucket IS NOT NULL THEN
          CASE WHEN gl.direction IN ('cash_in','credit') THEN gl.amount ELSE -gl.amount END
        ELSE
          (wallet_route_for_category(p_user_id, gl.category, gl.direction)).sign * gl.amount
      END AS signed_amount
    FROM general_ledger gl
    LEFT JOIN anchor a ON true
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND (gl.classification IS NULL OR gl.classification = 'production')
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
  ),
  float_only AS (
    SELECT * FROM routed WHERE bucket = 'float'
  ),
  with_running AS (
    SELECT
      entry_id, occurred_at, category, direction, amount, signed_amount,
      SUM(signed_amount) OVER (ORDER BY occurred_at, entry_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance,
      description, transaction_group_id, linked_party
    FROM float_only
  )
  SELECT * FROM with_running
  ORDER BY occurred_at DESC, entry_id DESC
  LIMIT GREATEST(p_limit, 1);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_float_breakdown(uuid, int) TO authenticated;