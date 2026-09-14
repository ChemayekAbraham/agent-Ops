CREATE OR REPLACE FUNCTION public.tenant_payment_history(p_limit integer DEFAULT 20)
RETURNS TABLE(
  id uuid,
  amount numeric,
  paid_at timestamptz,
  method text,
  rent_request_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT r.id,
         COALESCE(r.amount, 0) AS amount,
         r.created_at AS paid_at,
         CASE
           WHEN r.payment_method IS NULL THEN 'Rent payment'
           WHEN r.payment_method ILIKE '%agent%' THEN 'Rent payment (agent collection)'
           WHEN r.payment_method ILIKE '%momo%' OR r.payment_method ILIKE '%mobile%' THEN 'Rent payment (Mobile Money)'
           WHEN r.payment_method ILIKE '%wallet%' THEN 'Rent payment (wallet)'
           WHEN r.payment_method ILIKE '%cash%' THEN 'Rent payment (cash)'
           ELSE 'Rent payment (' || lower(replace(r.payment_method, '_', ' ')) || ')'
         END AS method,
         r.rent_request_id
    FROM public.repayments r
   WHERE auth.uid() IS NOT NULL
     AND r.tenant_id = auth.uid()
   ORDER BY r.created_at DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
$function$;

REVOKE ALL ON FUNCTION public.tenant_payment_history(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_payment_history(integer) TO authenticated;