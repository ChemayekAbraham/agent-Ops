-- When a rent plan is re-pointed to a different landlord, the money path
-- must follow it (doc 128 follow-up, Kalule Brian).
--
-- agent_landlord_float_allocations keeps its own landlord_id/name/phone
-- snapshot taken at CFO disbursement, and AgentFloatPayoutWizard opens the
-- payout from THAT allocation. Re-pointing rent_requests.landlord_id alone
-- left the agent's Landlord Payout Float withdrawal showing — and able to
-- OTP — the old landlord. A pending OTP already sent to the old landlord's
-- number stayed usable too.
--
-- Now, on UPDATE OF landlord_id:
--   * open allocations for that plan with nothing paid out yet move to the
--     new landlord (name + approved payout number refreshed);
--   * partially / fully paid allocations are left alone — they have money
--     already sent to the old landlord and need a human decision;
--   * pending OTP challenges for that plan addressed to the OLD landlord are
--     cancelled so a code sent to the wrong number can't complete a payout.

CREATE OR REPLACE FUNCTION public.follow_rent_request_landlord_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  l public.landlords;
BEGIN
  IF NEW.landlord_id IS NOT DISTINCT FROM OLD.landlord_id OR NEW.landlord_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO l FROM public.landlords WHERE id = NEW.landlord_id;

  UPDATE public.agent_landlord_float_allocations a
     SET landlord_id = NEW.landlord_id,
         landlord_name = l.name,
         landlord_phone = COALESCE(l.verified_mobile_money_number, l.mobile_money_number, l.phone),
         notes = COALESCE(a.notes || ' | ', '') || 'Landlord followed rent plan change ' || now()::date
                 || ' from ' || COALESCE(a.landlord_name, '?') || ' ' || COALESCE(a.landlord_phone, '?')
   WHERE a.rent_request_id = NEW.id
     AND a.landlord_id IS DISTINCT FROM NEW.landlord_id
     AND a.status = 'open'
     AND COALESCE(a.paid_out_amount, 0) = 0;

  UPDATE public.landlord_payout_otp_challenges c
     SET status = 'cancelled',
         metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object(
           'cancelled_reason', 'Rent plan re-pointed to a different landlord',
           'cancelled_at', now(),
           'new_landlord_id', NEW.landlord_id)
   WHERE c.rent_request_id = NEW.id
     AND c.status = 'pending'
     AND c.landlord_id IS DISTINCT FROM NEW.landlord_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_follow_rent_request_landlord_change ON public.rent_requests;
CREATE TRIGGER trg_follow_rent_request_landlord_change
AFTER UPDATE OF landlord_id ON public.rent_requests
FOR EACH ROW
WHEN (NEW.landlord_id IS DISTINCT FROM OLD.landlord_id)
EXECUTE FUNCTION public.follow_rent_request_landlord_change();
