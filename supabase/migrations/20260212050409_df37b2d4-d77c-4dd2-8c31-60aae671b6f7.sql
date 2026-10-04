-- Performance indexes for scalable ledger queries
CREATE INDEX IF NOT EXISTS idx_general_ledger_transaction_date ON public.general_ledger (transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_general_ledger_category ON public.general_ledger (category);
CREATE INDEX IF NOT EXISTS idx_general_ledger_direction ON public.general_ledger (direction);
CREATE INDEX IF NOT EXISTS idx_general_ledger_created_at ON public.general_ledger (created_at ASC);
CREATE INDEX IF NOT EXISTS idx_general_ledger_composite ON public.general_ledger (transaction_date DESC, created_at ASC);

-- Aggregation function for ledger summaries (avoids full table scans)
CREATE OR REPLACE FUNCTION public.get_ledger_summary(
  p_start_date timestamptz DEFAULT NULL,
  p_end_date timestamptz DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_direction text DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS TABLE(total_debits numeric, total_credits numeric, entry_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(CASE WHEN gl.direction = 'cash_out' THEN gl.amount ELSE 0 END), 0) AS total_debits,
    COALESCE(SUM(CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE 0 END), 0) AS total_credits,
    COUNT(*)::bigint AS entry_count
  FROM public.general_ledger gl
  WHERE
    (p_start_date IS NULL OR gl.transaction_date >= p_start_date)
    AND (p_end_date IS NULL OR gl.transaction_date <= p_end_date)
    AND (p_category IS NULL OR gl.category = p_category)
    AND (p_direction IS NULL OR gl.direction = p_direction)
    AND (p_search IS NULL OR (
      gl.description ILIKE '%' || p_search || '%'
      OR gl.linked_party ILIKE '%' || p_search || '%'
      OR gl.category ILIKE '%' || p_search || '%'
      OR gl.reference_id ILIKE '%' || p_search || '%'
    ));
END;
$$;