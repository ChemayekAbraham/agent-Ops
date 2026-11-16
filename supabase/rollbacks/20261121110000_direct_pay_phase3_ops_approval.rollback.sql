-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Rollback of 20261121110000_direct_pay_phase3_ops_approval.sql.
-- Refuses once any direct payment is confirmed: those plans are repaying on a direct payment, and the repaying gate
-- and the plan clock must keep recognising it. Restores the two edited functions from the copies phase 3 saved.
-- Re-runnable.

SET lock_timeout = '5s';

DO $guard$
DECLARE v_confirmed boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'funder_offplatform_rent_payments' AND column_name = 'flow') THEN
    EXECUTE $q$SELECT EXISTS (SELECT 1 FROM public.funder_offplatform_rent_payments
                               WHERE flow = 'direct_pay' AND status = 'confirmed')$q$ INTO v_confirmed;
    IF v_confirmed THEN
      RAISE EXCEPTION 'rollback refused: confirmed direct payments exist; their plans depend on this phase';
    END IF;
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS aa_00_direct_pay_no_second_payout ON public.landlord_payouts;
DROP POLICY IF EXISTS direct_pay_staff_read_offplatform_receipt ON storage.objects;

DO $restore$
DECLARE r record;
BEGIN
  IF to_regclass('public.direct_pay_saved_definitions') IS NULL THEN RETURN; END IF;
  FOR r IN EXECUTE $q$SELECT object_name, definition FROM public.direct_pay_saved_definitions
                       WHERE object_name IN ('function:gate_repaying_on_merchant_landlord_payout', 'function:_am_plan_clock_core')$q$ LOOP
    EXECUTE r.definition;
  END LOOP;
  EXECUTE $q$DELETE FROM public.direct_pay_saved_definitions
              WHERE object_name IN ('function:gate_repaying_on_merchant_landlord_payout', 'function:_am_plan_clock_core')$q$;
END
$restore$;

DROP FUNCTION IF EXISTS public.direct_pay_reject(uuid, text);
DROP FUNCTION IF EXISTS public.direct_pay_approve(uuid, text, text, text);
DROP FUNCTION IF EXISTS public._direct_pay_issue_receipt(uuid, uuid);
DROP FUNCTION IF EXISTS public._direct_pay_agent_pay(uuid);
DROP FUNCTION IF EXISTS public._direct_pay_cover_charge(uuid);
DROP FUNCTION IF EXISTS public.direct_pay_otp_mark(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.direct_pay_otp_issue(uuid, uuid);
DROP FUNCTION IF EXISTS public.direct_pay_otp_authorize(uuid);
DROP FUNCTION IF EXISTS public.direct_pay_ops_queue(text, boolean, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.trg_direct_pay_no_second_payout();
DROP FUNCTION IF EXISTS public._direct_pay_landlord_paid(uuid);
DROP FUNCTION IF EXISTS public._direct_pay_can_view(uuid);
DROP FUNCTION IF EXISTS public._direct_pay_can_act(uuid);
DROP TABLE IF EXISTS public.direct_pay_landlord_otps;
