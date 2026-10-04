CREATE OR REPLACE FUNCTION public.get_float_deposit_allocations(p_user_id uuid, p_entry_id uuid)
RETURNS TABLE(
  use_entry_id uuid,
  occurred_at timestamp with time zone,
  category text,
  use_amount numeric,
  allocated_amount numeric,
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  description text,
  reference_id text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _is_staff boolean := false;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;

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
      gl.amount,
      gl.description,
      gl.reference_id,
      gl.transaction_group_id,
      COALESCE(gl.wallet_bucket, (wallet_route_for_category(p_user_id, gl.category, gl.direction)).bucket) AS bucket,
      CASE
        WHEN gl.wallet_bucket IS NOT NULL THEN
          CASE WHEN gl.direction IN ('cash_in','credit') THEN gl.amount ELSE -gl.amount END
        ELSE (wallet_route_for_category(p_user_id, gl.category, gl.direction)).sign * gl.amount
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
  -- Deposits occupy contiguous ranges on the cumulative-deposit axis (FIFO).
  deposits AS (
    SELECT
      entry_id,
      SUM(signed_amount) OVER (ORDER BY occurred_at, entry_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_end,
      SUM(signed_amount) OVER (ORDER BY occurred_at, entry_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - signed_amount AS cum_start
    FROM float_only
    WHERE signed_amount > 0
  ),
  target AS (
    SELECT cum_start, cum_end FROM deposits WHERE entry_id = p_entry_id
  ),
  -- Outflows consume the same axis in chronological (FIFO) order.
  uses AS (
    SELECT
      entry_id,
      occurred_at,
      category,
      amount,
      description,
      reference_id,
      transaction_group_id,
      SUM(-signed_amount) OVER (ORDER BY occurred_at, entry_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_end,
      SUM(-signed_amount) OVER (ORDER BY occurred_at, entry_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) + signed_amount AS cum_start
    FROM float_only
    WHERE signed_amount < 0
  )
  SELECT
    u.entry_id AS use_entry_id,
    u.occurred_at,
    u.category,
    u.amount AS use_amount,
    (LEAST(u.cum_end, t.cum_end) - GREATEST(u.cum_start, t.cum_start)) AS allocated_amount,
    tnt.tenant_id,
    tp.full_name AS tenant_name,
    tp.phone AS tenant_phone,
    u.description,
    u.reference_id
  FROM uses u
  CROSS JOIN target t
  LEFT JOIN LATERAL (
    SELECT gl3.user_id AS tenant_id
    FROM general_ledger gl3
    WHERE gl3.transaction_group_id = u.transaction_group_id
      AND gl3.category = 'rent_receivable_created'
      AND gl3.ledger_scope = 'bridge'
    LIMIT 1
  ) tnt ON true
  LEFT JOIN profiles tp ON tp.id = tnt.tenant_id
  WHERE t.cum_start IS NOT NULL
    AND LEAST(u.cum_end, t.cum_end) > GREATEST(u.cum_start, t.cum_start)
  ORDER BY u.occurred_at, u.entry_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_float_deposit_allocations(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_float_deposit_allocations(uuid, uuid) TO service_role;