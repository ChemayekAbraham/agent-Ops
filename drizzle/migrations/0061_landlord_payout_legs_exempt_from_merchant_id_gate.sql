-- Landlord payout legs are company money paid to a landlord during the agent's
-- round, not the agent's own cash-out. The customer ID-verification gate added
-- for personal withdrawals must not hide them from merchant agents, or agents
-- can start a landlord payout that no merchant can ever pay.

CREATE OR REPLACE FUNCTION public.withdrawal_merchant_id_gate(
  p_user_id uuid,
  p_landlord_payout_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $gate$
  select p_landlord_payout_id is not null
      or coalesce(p_reason, '') like 'Landlord float payout%'
      or public.withdrawal_user_id_verified(p_user_id)
$gate$;

REVOKE ALL ON FUNCTION public.withdrawal_merchant_id_gate(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.withdrawal_merchant_id_gate(uuid, uuid, text) TO authenticated, service_role;

DROP POLICY IF EXISTS "Owners staff and assigned merchant agents can view withdrawals" ON public.withdrawal_requests;
CREATE POLICY "Owners staff and assigned merchant agents can view withdrawals"
ON public.withdrawal_requests
FOR SELECT
USING (
  user_id = auth.uid()
  OR public.is_withdrawal_staff(auth.uid())
  OR (
    public.is_active_cashout_agent(auth.uid())
    AND public.withdrawal_merchant_id_gate(user_id, landlord_payout_id, reason)
    AND (
      assigned_cashout_agent_id IS NULL
      OR assigned_cashout_agent_id = (
        SELECT ca.id FROM public.cashout_agents ca WHERE ca.agent_id = auth.uid() LIMIT 1
      )
      OR dispatch_claimed_by = auth.uid()
      OR processed_by = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS "Active merchant agents can claim or release payouts" ON public.withdrawal_requests;
CREATE POLICY "Active merchant agents can claim or release payouts"
ON public.withdrawal_requests
FOR UPDATE
TO authenticated
USING (
  public.is_active_cashout_agent(auth.uid())
  AND public.withdrawal_merchant_id_gate(user_id, landlord_payout_id, reason)
  AND status = ANY (ARRAY['pending','requested','approved','manager_approved','cfo_approved','fin_ops_approved'])
);

-- Repoint the two SECURITY DEFINER paths at the row-aware gate without
-- restating their bodies (they are long and must not drift).
DO $patch$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'claim_withdrawal_verified'
  LIMIT 1;
  IF d IS NOT NULL THEN
    d := replace(
      d,
      'public.withdrawal_user_id_verified(v_w.user_id)',
      'public.withdrawal_merchant_id_gate(v_w.user_id, v_w.landlord_payout_id, v_w.reason)'
    );
    EXECUTE d;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'auto_dispatch_withdrawals'
  LIMIT 1;
  IF d IS NOT NULL THEN
    d := replace(
      d,
      'public.withdrawal_user_id_verified(wr.user_id)',
      'public.withdrawal_merchant_id_gate(wr.user_id, wr.landlord_payout_id, wr.reason)'
    );
    EXECUTE d;
  END IF;
END
$patch$;