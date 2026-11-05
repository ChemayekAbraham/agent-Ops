-- CTO > Platform Controls > Allow selected landlord payouts: tell the CTO which held payouts are for a renewal.
--
-- A landlord payout is for a renewal when the Rent Plan it pays (landlord_payouts.rent_request_id) was registered as a renewal
-- (rent_requests.registration_type = 'renewal'). The CTO pardons an agent who is under the weekly money-collected target when the payout is a renewal,
-- and needs to see that on each row. Read only: it changes no payout and no rule, and get_landlord_payout_block_queue is left exactly as it is.
-- Access: the owner only (Joshua Wanda, id cb798acb-68bc-4b4e-a414-a3d374e030b6, joshwanda17@gmail.com). No other role, CTO, CFO or super admin, can call it.
-- It only reads. It approves, allows and changes nothing; allowing a payout is still done by the existing owner-only controls.
-- Roll back with 20261029130000_landlord_payout_queue_renewal_flag.rollback.sql.

CREATE OR REPLACE FUNCTION public.get_landlord_payout_renewals()
 RETURNS TABLE(withdrawal_id uuid, is_renewal boolean, tenant_name text, new_rent numeric, previous_rent numeric, previous_days integer, new_days integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users u
                  WHERE u.id = auth.uid()
                    AND u.id = 'cb798acb-68bc-4b4e-a414-a3d374e030b6'::uuid
                    AND lower(u.email) = 'joshwanda17@gmail.com') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT w.id,
         COALESCE(rr.registration_type = 'renewal', false),
         t.full_name,
         rr.rent_amount,
         rr.renewal_previous_rent,
         rr.renewal_previous_days,
         rr.duration_days
    FROM public.withdrawal_requests w
    JOIN public.landlord_payouts lp ON lp.id = w.landlord_payout_id
    LEFT JOIN public.rent_requests rr ON rr.id = lp.rent_request_id
    LEFT JOIN public.profiles t ON t.id = COALESCE(lp.tenant_id, rr.tenant_id)
   WHERE w.assigned_cashout_agent_id IS NULL
     AND w.processed_at IS NULL
     AND w.fin_ops_reference IS NULL
     AND w.hidden_from_merchant_queue IS NOT TRUE
     AND w.status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved');
END;
$function$;

REVOKE ALL ON FUNCTION public.get_landlord_payout_renewals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_payout_renewals() TO authenticated, service_role;
