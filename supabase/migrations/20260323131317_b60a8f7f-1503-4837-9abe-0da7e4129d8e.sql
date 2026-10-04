
-- Server-side aggregation function for financial ops pulse metrics
-- Avoids fetching all rows client-side (critical for 1M+ transactions)
CREATE OR REPLACE FUNCTION public.get_financial_ops_pulse()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'pending_deposits', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM deposit_requests WHERE status = 'pending'
    ),
    'pending_withdrawals', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM investment_withdrawal_requests WHERE status = 'pending'
    ),
    'pending_wallet_withdrawals', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM withdrawal_requests WHERE status IN ('requested', 'manager_approved', 'cfo_approved')
    ),
    'pending_wallet_ops', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM pending_wallet_operations WHERE status = 'pending'
    ),
    'today_volume', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM general_ledger WHERE transaction_date >= CURRENT_DATE
    )
  );
$$;

-- Server-side paginated transaction query for the financial transactions table
CREATE OR REPLACE FUNCTION public.get_paginated_transactions(
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0,
  p_direction text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  amount numeric,
  direction text,
  category text,
  description text,
  linked_party text,
  reference_id text,
  transaction_date timestamptz,
  user_id uuid,
  ledger_scope text,
  source_table text,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
BEGIN
  -- Get total count with filters
  SELECT count(*) INTO v_total
  FROM general_ledger gl
  WHERE (p_direction IS NULL OR gl.direction = p_direction)
    AND (p_category IS NULL OR gl.category = p_category)
    AND (p_search IS NULL OR (
      gl.reference_id ILIKE '%' || p_search || '%'
      OR gl.linked_party ILIKE '%' || p_search || '%'
      OR gl.description ILIKE '%' || p_search || '%'
      OR gl.category ILIKE '%' || p_search || '%'
    ));

  RETURN QUERY
  SELECT
    gl.id, gl.amount, gl.direction, gl.category, gl.description,
    gl.linked_party, gl.reference_id, gl.transaction_date,
    gl.user_id, gl.ledger_scope, gl.source_table,
    v_total
  FROM general_ledger gl
  WHERE (p_direction IS NULL OR gl.direction = p_direction)
    AND (p_category IS NULL OR gl.category = p_category)
    AND (p_search IS NULL OR (
      gl.reference_id ILIKE '%' || p_search || '%'
      OR gl.linked_party ILIKE '%' || p_search || '%'
      OR gl.description ILIKE '%' || p_search || '%'
      OR gl.category ILIKE '%' || p_search || '%'
    ))
  ORDER BY gl.transaction_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- Add index for transaction_date queries (critical for today's volume)
CREATE INDEX IF NOT EXISTS idx_general_ledger_transaction_date ON general_ledger (transaction_date DESC);
-- Add trigram index for search
CREATE INDEX IF NOT EXISTS idx_general_ledger_search ON general_ledger USING gin (
  (coalesce(reference_id, '') || ' ' || coalesce(linked_party, '') || ' ' || coalesce(description, '') || ' ' || coalesce(category, '')) gin_trgm_ops
);
