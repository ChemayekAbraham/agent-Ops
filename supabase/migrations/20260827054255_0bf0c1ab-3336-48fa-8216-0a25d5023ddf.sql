CREATE OR REPLACE FUNCTION public.get_payables_due_range(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Nairobi')::date;
  v_result jsonb;
BEGIN
  PERFORM payables_guard();

  SELECT jsonb_build_object(
    'currency','UGX',
    'from', p_from,
    'to', p_to,
    'business_date', v_today,
    'due_in_range', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM v_payables_lines
                              WHERE due_date IS NOT NULL AND due_date BETWEEN p_from AND p_to),0),
    'overdue', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM v_payables_lines
                          WHERE due_date IS NOT NULL AND due_date < p_from),0),
    'outstanding', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM v_payables_lines),0),
    'paid_in_range', COALESCE((SELECT ROUND(SUM(amount),2) FROM v_payables_payment_history
                               WHERE (paid_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN p_from AND p_to),0),
    'rows', COALESCE((
      SELECT jsonb_agg(r) FROM (
        SELECT item_id AS id, counterparty_id AS user_id, counterparty_name AS name,
               ROUND(outstanding_amount,2) AS amount, status, due_date,
               product_label, category_label
        FROM v_payables_lines
        WHERE due_date IS NOT NULL AND due_date BETWEEN p_from AND p_to
        ORDER BY outstanding_amount DESC
        LIMIT 300
      ) r
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payables_due_range(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payables_due_range(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_payables_due_range(date, date) TO authenticated, service_role;