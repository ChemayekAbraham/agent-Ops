CREATE OR REPLACE FUNCTION public.get_payables_by_source(p_from date, p_to date)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM payables_guard();
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object('source', COALESCE(product_label,'Other'),
             'amount', ROUND(SUM(outstanding_amount),2), 'count', COUNT(*), 'due_date', MIN(due_date)) x
      FROM v_payables_lines
      WHERE outstanding_amount > 0 AND (due_date IS NULL OR due_date <= p_to)
      GROUP BY COALESCE(product_label,'Other')
    ) s), '[]'::jsonb);
END $function$;