-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Self-support option 2. Phase 8: a pilot list before everyone.
-- A partner may start a direct payment only when the switch self_support_direct_pay is ON and either they are on
-- direct_pay_pilot_partners or the second switch self_support_direct_pay_everyone is ON (created OFF).
-- Only direct_pay_claim reads _direct_pay_on(); holds already taken, proofs, approvals and messages are not gated
-- (a partner who already paid a landlord must always be able to finish).
-- Needs 20261121090000 .. 20261121140000. REQUIRES THE OWNER'S YES before it is applied to production.

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regprocedure('public._direct_pay_on()') IS NULL THEN
    RAISE EXCEPTION 'direct pay phase 8: phase 2 (20261121100000) is not applied';
  END IF;
END
$guard$;

INSERT INTO public.pipeline_switches (key, is_on, note)
SELECT 'self_support_direct_pay_everyone', false,
       'Option 2 for every partner. OFF: only partners on direct_pay_pilot_partners can start a direct payment. See 20261121150000.'
 WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_switches WHERE key = 'self_support_direct_pay_everyone');

CREATE TABLE IF NOT EXISTS public.direct_pay_pilot_partners (
  partner_id uuid        PRIMARY KEY,
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   uuid,
  note       text
);
ALTER TABLE public.direct_pay_pilot_partners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.direct_pay_pilot_partners;
CREATE POLICY mfa_required_for_staff ON public.direct_pay_pilot_partners AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
-- Managed by the owner / Claude with the service key; nobody edits it from the browser.
REVOKE ALL ON public.direct_pay_pilot_partners FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.direct_pay_pilot_partners TO service_role;

CREATE OR REPLACE FUNCTION public._direct_pay_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public._pipeline_switch_on('self_support_direct_pay')
     AND (public._pipeline_switch_on('self_support_direct_pay_everyone')
          OR EXISTS (SELECT 1 FROM public.direct_pay_pilot_partners WHERE partner_id = auth.uid()))
$$;
REVOKE ALL ON FUNCTION public._direct_pay_on() FROM PUBLIC, anon, authenticated;
