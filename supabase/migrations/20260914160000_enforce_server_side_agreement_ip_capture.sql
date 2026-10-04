-- CORRECTION, item #2 of the user's four closure requirements: verify
-- agreement acceptance IP capture is genuinely server-side.
--
-- It was not. Read the actual write code for all 7 agreement/disclosure
-- hooks (useTenantAgreement, useMerchantAgreement, useLenderVouchAgreement,
-- useLendingAgentAgreement, useSupporterAgreement, useEmployeeAgreement,
-- useBorrowerVouchDisclosure) and every single one follows the exact
-- untrustworthy pattern flagged: the BROWSER calls a third-party service
-- (https://api.ipify.org) to look up its own IP, then sends that value in
-- the insert payload as ip_address. This is spoofable (a modified client
-- can send any value) and unreliable (a blocked or failed fetch to a
-- third party -- which is what the earlier "97-100% coverage, small gaps
-- look like normal flakiness" read actually was, not network noise but a
-- client-side dependency failing).
--
-- A separate 8th hook, useAgentAgreement.ts, references a table
-- (agent_agreement_acceptance) that does not exist in the database at
-- all -- dead/broken code, not a security gap, left alone here.
--
-- Fix: a BEFORE INSERT trigger on each of the 7 real tables that
-- unconditionally OVERWRITES ip_address/device_info with the server-
-- resolved value from request.headers, discarding whatever the client
-- sent -- unlike every other capture trigger in this series (which only
-- filled in a value when the column was null), because here the client
-- actively supplies a value that must never be trusted. Same edge-
-- runtime-spoofing guard as every other trigger in this series.
--
-- The frontend's api.ipify.org calls are left in place (Gemini's UI lane,
-- and harmless now that the server always overwrites whatever they send)
-- rather than edited here -- removing that dead network call is a
-- worthwhile follow-up but not a security requirement once the server
-- authoritatively overwrites the value.

CREATE OR REPLACE FUNCTION public.enforce_server_side_agreement_ip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ua := v_headers ->> 'user-agent';

  IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
    NEW.ip_address := NULL;
    NEW.device_info := NULL;
    RETURN NEW;
  END IF;

  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  IF v_ip IS NULL THEN
    v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  END IF;

  NEW.ip_address := v_ip;
  NEW.device_info := v_ua;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  NEW.ip_address := NULL;
  NEW.device_info := NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_server_side_ip ON public.tenant_agreement_acceptance;
CREATE TRIGGER trg_enforce_server_side_ip BEFORE INSERT ON public.tenant_agreement_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.enforce_server_side_agreement_ip();

DROP TRIGGER IF EXISTS trg_enforce_server_side_ip ON public.merchant_agreement_acceptance;
CREATE TRIGGER trg_enforce_server_side_ip BEFORE INSERT ON public.merchant_agreement_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.enforce_server_side_agreement_ip();

DROP TRIGGER IF EXISTS trg_enforce_server_side_ip ON public.lender_vouch_agreement_acceptance;
CREATE TRIGGER trg_enforce_server_side_ip BEFORE INSERT ON public.lender_vouch_agreement_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.enforce_server_side_agreement_ip();

DROP TRIGGER IF EXISTS trg_enforce_server_side_ip ON public.lending_agent_agreement_acceptance;
CREATE TRIGGER trg_enforce_server_side_ip BEFORE INSERT ON public.lending_agent_agreement_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.enforce_server_side_agreement_ip();

DROP TRIGGER IF EXISTS trg_enforce_server_side_ip ON public.supporter_agreement_acceptance;
CREATE TRIGGER trg_enforce_server_side_ip BEFORE INSERT ON public.supporter_agreement_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.enforce_server_side_agreement_ip();

DROP TRIGGER IF EXISTS trg_enforce_server_side_ip ON public.employee_agreement_acceptance;
CREATE TRIGGER trg_enforce_server_side_ip BEFORE INSERT ON public.employee_agreement_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.enforce_server_side_agreement_ip();

DROP TRIGGER IF EXISTS trg_enforce_server_side_ip ON public.borrower_vouch_disclosures;
CREATE TRIGGER trg_enforce_server_side_ip BEFORE INSERT ON public.borrower_vouch_disclosures
  FOR EACH ROW EXECUTE FUNCTION public.enforce_server_side_agreement_ip();
