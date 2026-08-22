CREATE OR REPLACE FUNCTION public.list_smartphone_orders(p_status text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, customer_id uuid, client_name text, client_phone text, brand text, model_type text, total_amount numeric, payment_projection numeric, amount_outstanding numeric, amount_paid numeric, order_status text, rejection_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.can_review_smartphone_orders(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view smartphone orders';
  END IF;

  RETURN QUERY
  SELECT s.id, s.customer_id, s.client_name, s.client_phone, s.brand, s.model_type,
         COALESCE(
           NULLIF(s.total_amount, 0),
           NULLIF(s.total_revenue, 0),
           NULLIF(s.unit_price * GREATEST(COALESCE(s.quantity, 1), 1), 0),
           0
         ) AS total_amount,
         COALESCE(
           NULLIF(s.payment_projection, 0),
           ROUND(
             COALESCE(
               NULLIF(s.total_amount, 0),
               NULLIF(s.total_revenue, 0),
               NULLIF(s.unit_price * GREATEST(COALESCE(s.quantity, 1), 1), 0),
               0
             ) * 0.33
           )
         ) AS payment_projection,
         s.amount_outstanding, s.amount_paid,
         COALESCE(s.order_status, 'submitted') AS order_status,
         s.rejection_reason, s.created_at
  FROM public.merchandise_sales s
  WHERE lower(COALESCE(s.item_name, '')) LIKE '%phone%'
    AND (p_status IS NULL OR COALESCE(s.order_status, 'submitted') = p_status)
  ORDER BY s.created_at DESC
  LIMIT 300;
END;
$function$;