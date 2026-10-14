ALTER TABLE public.requisition_wallet_credits DROP CONSTRAINT requisition_wallet_credits_status_check;
ALTER TABLE public.requisition_wallet_credits ADD CONSTRAINT requisition_wallet_credits_status_check
  CHECK (status = ANY (ARRAY['pending','credited','failed','reversing','reversed']));
ALTER TABLE public.requisition_wallet_credits
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS reversal_reference text;

-- Read-only list of approved requisitions with their payout status.
-- pending = approved but money not yet in the receiver's wallet; paid = credited; reversed = taken back.
CREATE OR REPLACE FUNCTION public.cfo_approved_requisitions(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  source_table text, requisition_id uuid, requisition_code text, receiver_id uuid, receiver_name text,
  title text, amount numeric, approved_at timestamptz, payout_status text, credited_at timestamptz,
  wallet_transaction_id text, reversed_at timestamptz, reversal_reason text, error_message text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
    SELECT 'employee_requisitions', e.id, NULL, e.employee_id, e.employee_name::text, e.purpose::text,
           COALESCE(e.approved_amount, e.amount)::numeric, e.approved_at
      FROM employee_requisitions e WHERE e.status IN ('approved','paid') AND e.approved_at IS NOT NULL
    UNION ALL
    SELECT 'director_requisitions', d.id, d.requisition_code::text, d.requester_id, d.requester_name::text, d.title::text,
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
END $$;
REVOKE ALL ON FUNCTION public.cfo_approved_requisitions(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_approved_requisitions(timestamptz, timestamptz) TO authenticated, service_role;

-- Security: closure days visible to Food staff and coordinators only.
DROP POLICY IF EXISTS food_closures_read ON public.food_service_closures;
CREATE POLICY food_closures_read ON public.food_service_closures FOR SELECT TO authenticated
  USING (public.food_is_staff(auth.uid()) OR public.is_active_food_coordinator(auth.uid()));