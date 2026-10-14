CREATE OR REPLACE FUNCTION public.cfo_approved_requisitions(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(source_table text, requisition_id uuid, requisition_code text, receiver_id uuid, receiver_name text, title text, amount numeric, approved_at timestamp with time zone, payout_status text, credited_at timestamp with time zone, wallet_transaction_id text, reversed_at timestamp with time zone, reversal_reason text, error_message text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = auth.uid()
     AND ur.role IN ('cfo','super_admin','financial_ops','ceo','coo') AND COALESCE(ur.enabled, true)) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH reqs AS (
    SELECT 'staff_requisitions'::text st, s.id, s.requisition_code::text code, s.requester_id uid, s.requester_name::text nm,
           s.title::text tt, COALESCE(s.approved_amount, s.amount)::numeric amt,
           COALESCE(s.cfo_decided_at, s.ceo_decided_at, s.decided_at) apr
      FROM staff_requisitions s WHERE s.stage = 'approved'
    UNION ALL
    SELECT 'employee_requisitions'::text, e.id, NULL::text,
           (CASE WHEN e.employee_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN e.employee_id::uuid ELSE NULL END),
           e.employee_name::text, e.purpose::text,
           COALESCE(e.approved_amount, e.amount)::numeric, e.approved_at
      FROM employee_requisitions e WHERE e.status IN ('approved','paid') AND e.approved_at IS NOT NULL
    UNION ALL
    SELECT 'director_requisitions'::text, d.id, d.requisition_code::text, d.requester_id, d.requester_name::text, d.title::text,
           d.amount::numeric, COALESCE(d.decided_at, d.updated_at)
      FROM director_requisitions d WHERE d.status = 'approved'
  )
  SELECT r.st, r.id, COALESCE(r.code, c.requisition_code, upper(left(r.id::text, 8))), r.uid,
         COALESCE(r.nm, p.full_name), r.tt, r.amt, r.apr,
         CASE WHEN c.status = 'credited' THEN 'paid'
              WHEN c.status = 'reversed' THEN 'reversed'
              WHEN c.status = 'reversing' THEN 'reversing'
              WHEN c.status = 'failed' THEN 'failed'
              ELSE 'pending' END,
         c.credited_at, c.wallet_transaction_id, c.reversed_at, c.reversal_reason, c.error_message
    FROM reqs r
    LEFT JOIN requisition_wallet_credits c ON c.source_table = r.st AND c.requisition_id = r.id
    LEFT JOIN profiles p ON p.id = r.uid
   WHERE r.apr >= p_from AND r.apr < p_to
   ORDER BY r.apr DESC
   LIMIT 3000;
END $function$;