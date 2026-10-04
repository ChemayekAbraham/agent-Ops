CREATE OR REPLACE FUNCTION public.verify_advance_disbursement_matches_principal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_advance RECORD;
  v_credited numeric;
BEGIN
  IF NEW.ledger_scope <> 'wallet'
     OR NEW.direction <> 'cash_in'
     OR COALESCE(NEW.amount,0) <= 0
     OR NEW.category <> 'agent_advance'
     OR COALESCE(NEW.recipient_type,'') <> 'user' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_advance
  FROM public.agent_advances
  WHERE agent_id = NEW.user_id
    AND status = 'active'
    AND issued_at > now() - interval '10 minutes'
  ORDER BY issued_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_credited
  FROM public.general_ledger
  WHERE user_id = NEW.user_id
    AND ledger_scope = 'wallet'
    AND direction = 'cash_in'
    AND category = 'agent_advance'
    AND recipient_type = 'user'
    AND created_at >= v_advance.issued_at - interval '1 minute'
    AND created_at <= v_advance.issued_at + interval '10 minutes';

  v_credited := v_credited + NEW.amount;

  IF v_credited > v_advance.principal THEN
    RAISE EXCEPTION 'ADVANCE_DISBURSEMENT_EXCEEDS_PRINCIPAL: attempted to credit % UGX which exceeds recorded principal % UGX for advance %',
      v_credited, v_advance.principal, v_advance.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;