CREATE OR REPLACE FUNCTION public.get_receivables_total()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_result jsonb;
BEGIN
  PERFORM receivables_guard();

  SELECT jsonb_build_object(
    'currency','UGX',
    'as_at', now(),
    'total', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM v_receivables_lines),0),
    'item_count', COALESCE((SELECT COUNT(*) FROM v_receivables_lines),0),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key', c.category_key,
               'label', c.category_label,
               'outstanding', c.outstanding,
               'item_count', c.item_count
             ) ORDER BY c.sort_order)
      FROM (
        SELECT f.category_key,
               f.category_label,
               f.sort_order,
               ROUND(COALESCE(SUM(l.outstanding_amount),0),2) AS outstanding,
               COUNT(l.item_id) AS item_count
        FROM receivables_category_frame() f
        LEFT JOIN v_receivables_lines l ON l.category_key = f.category_key
        GROUP BY f.category_key, f.category_label, f.sort_order
      ) c
    ), '[]'::jsonb),
    'source','v_receivables_lines'
  ) INTO v_result;

  RETURN v_result;
END;
$function$;