-- Puts the CFO rent funding gate back to holding renewals too.
CREATE OR REPLACE FUNCTION public.enforce_rent_disbursement_collection_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_status text; v_rate record; v_name text;
BEGIN
  IF NEW.source IS DISTINCT FROM 'cfo_disbursement' OR NEW.rent_request_id IS NULL THEN RETURN NEW; END IF;
  SELECT r.status INTO v_status FROM public.rent_requests r WHERE r.id = NEW.rent_request_id;
  IF v_status IS NULL OR v_status NOT IN ('approved', 'coo_approved') THEN RETURN NEW; END IF;
  SELECT * INTO v_rate FROM public.agent_payout_weekly_performance(NEW.agent_id);
  IF v_rate.passes IS NOT FALSE THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.rent_disbursement_rate_exceptions x WHERE x.rent_request_id = NEW.rent_request_id) THEN RETURN NEW; END IF;
  SELECT COALESCE(p.full_name, 'The agent') INTO v_name FROM public.profiles p WHERE p.id = NEW.agent_id;
  RAISE EXCEPTION 'Rent not funded: % is under the weekly collection target. % Rent is only funded to agents who reach the weekly target. Ask the agent to collect more, or allow an exception with a reason.',
    COALESCE(v_name, 'The agent'), COALESCE(v_rate.reason, '')
    USING ERRCODE = 'P0001';
END;
$function$;
