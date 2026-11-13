-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Rollback of 20261121150000_direct_pay_phase8_pilot.sql: back to the single switch (the phase 2 definition).
-- Refuses while the main switch is ON and the everyone-switch is OFF (rolling back would open option 2 to everyone).

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF public._pipeline_switch_on('self_support_direct_pay')
     AND NOT COALESCE((SELECT is_on FROM public.pipeline_switches WHERE key = 'self_support_direct_pay_everyone'), false) THEN
    RAISE EXCEPTION 'rollback refused: option 2 is ON for the pilot only; rolling back would open it to every partner';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._direct_pay_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT public._pipeline_switch_on('self_support_direct_pay') $$;
REVOKE ALL ON FUNCTION public._direct_pay_on() FROM PUBLIC, anon, authenticated;
DROP TABLE IF EXISTS public.direct_pay_pilot_partners;
DELETE FROM public.pipeline_switches WHERE key = 'self_support_direct_pay_everyone' AND is_on = false;
