CREATE OR REPLACE FUNCTION public.get_payables_by_source(p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM payables_guard();
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object('source', COALESCE(product_label,'Other'),
             'amount', ROUND(SUM(outstanding_amount),2), 'count', COUNT(*), 'due_date', MIN(due_date)) x
      FROM v_payables_lines
      WHERE due_date IS NOT NULL AND due_date BETWEEN p_from AND p_to
      GROUP BY COALESCE(product_label,'Other')
    ) s), '[]'::jsonb);
END $$;
GRANT EXECUTE ON FUNCTION public.get_payables_by_source(date,date) TO authenticated;