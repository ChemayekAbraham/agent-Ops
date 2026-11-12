CREATE OR REPLACE FUNCTION public.enforce_landlord_float_performance_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record;
BEGIN
  IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;

  -- Renewal payouts are not held by the weekly collection target (doc 250).
  IF public.landlord_payout_is_renewal(NEW.landlord_payout_id) THEN
    SELECT * INTO c FROM public._agent_landlord_float_check(NEW.user_id);
    IF c.passes IS FALSE THEN
      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      VALUES (NEW.user_id, 'landlord_gate_renewal_skip',
              'Renewal landlord payout let through while the agent was under the weekly collection target',
              'withdrawal_requests', NEW.id::text,
              jsonb_build_object('landlord_payout_id', NEW.landlord_payout_id, 'amount', NEW.amount,
                                 'rate_pct', c.rate_pct, 'required_pct', c.required_pct, 'basis', c.basis));
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO c FROM public._agent_landlord_float_check(NEW.user_id);
  IF c.passes IS NOT FALSE THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.landlord_float_withdrawal_exceptions e
              WHERE e.agent_id = NEW.user_id AND e.week_start = public.current_welile_week_start(now())) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%', public.landlord_float_blocked_message(NEW.user_id, NEW.amount) USING ERRCODE = 'P0001';
END;
$function$
