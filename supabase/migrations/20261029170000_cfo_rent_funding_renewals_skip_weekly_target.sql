-- CFO rent funding: a renewal Rent Plan is not held by the weekly collection target.
--
-- Why: enforce_rent_disbursement_collection_gate (trigger on agent_float_funding, source 'cfo_disbursement') blocks funding rent to an agent under the
-- weekly target. The landlord-payout gate (enforce_landlord_float_performance_gate) already lets renewals through (doc 250), but this funding gate did not,
-- so a renewal plan could not be funded to an agent such as Ian Muhwezi (renewal b308f861, UGX 6,000,000, coo_approved, agent at 38.5% against 50%).
-- Same renewal test as landlord_payout_is_renewal: registration_type = 'renewal' AND the tenant has an earlier plan that is repaying, completed or funded.
-- Everything else in the function is unchanged. A renewal let through while the agent is under target is written to audit_logs, as the payout gate does.
-- Roll back with 20261029170000_cfo_rent_funding_renewals_skip_weekly_target.rollback.sql.

CREATE OR REPLACE FUNCTION public.enforce_rent_disbursement_collection_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_status text; v_rate record; v_name text; v_renewal boolean;
BEGIN
  IF NEW.source IS DISTINCT FROM 'cfo_disbursement' OR NEW.rent_request_id IS NULL THEN RETURN NEW; END IF;
  SELECT r.status INTO v_status FROM public.rent_requests r WHERE r.id = NEW.rent_request_id;
  IF v_status IS NULL OR v_status NOT IN ('approved', 'coo_approved') THEN RETURN NEW; END IF;
  SELECT * INTO v_rate FROM public.agent_payout_weekly_performance(NEW.agent_id);
  IF v_rate.passes IS NOT FALSE THEN RETURN NEW; END IF;

  -- A renewal is not held by the weekly collection target.
  SELECT EXISTS (
    SELECT 1 FROM public.rent_requests rr
     WHERE rr.id = NEW.rent_request_id
       AND rr.registration_type = 'renewal'
       AND EXISTS (
         SELECT 1 FROM public.rent_requests prior
          WHERE prior.tenant_id = rr.tenant_id AND prior.id <> rr.id AND prior.created_at < rr.created_at
            AND prior.status IN ('repaying', 'completed', 'funded'))
  ) INTO v_renewal;
  IF v_renewal THEN
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    VALUES (NEW.agent_id, 'rent_funding_renewal_skip',
            'Renewal rent funded while the agent was under the weekly collection target',
            'rent_requests', NEW.rent_request_id::text,
            jsonb_build_object('amount', NEW.allocated_amount, 'rate_pct', v_rate.rate_pct, 'basis', v_rate.basis));
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM public.rent_disbursement_rate_exceptions x WHERE x.rent_request_id = NEW.rent_request_id) THEN RETURN NEW; END IF;
  SELECT COALESCE(p.full_name, 'The agent') INTO v_name FROM public.profiles p WHERE p.id = NEW.agent_id;
  RAISE EXCEPTION 'Rent not funded: % is under the weekly collection target. % Rent is only funded to agents who reach the weekly target. Ask the agent to collect more, or allow an exception with a reason.',
    COALESCE(v_name, 'The agent'), COALESCE(v_rate.reason, '')
    USING ERRCODE = 'P0001';
END;
$function$;
