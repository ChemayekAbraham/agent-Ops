
CREATE OR REPLACE FUNCTION public.prevent_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Trusted maturity path: SECURITY DEFINER helpers set ledger.authorized=true
  -- for the local transaction to flip maturity_met / matured_at only.
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME = 'general_ledger'
     AND current_setting('ledger.authorized', true) = 'true' THEN
    -- Only maturity fields may change; every other column must be identical.
    IF ROW(NEW.id, NEW.user_id, NEW.amount, NEW.direction, NEW.category,
           NEW.ledger_scope, NEW.wallet_bucket, NEW.classification,
           NEW.transaction_group_id, NEW.recipient_type, NEW.created_at,
           NEW.maturity_condition, NEW.maturity_subject_id,
           NEW.maturity_expired, NEW.withdrawable_after)
       IS NOT DISTINCT FROM
       ROW(OLD.id, OLD.user_id, OLD.amount, OLD.direction, OLD.category,
           OLD.ledger_scope, OLD.wallet_bucket, OLD.classification,
           OLD.transaction_group_id, OLD.recipient_type, OLD.created_at,
           OLD.maturity_condition, OLD.maturity_subject_id,
           OLD.maturity_expired, OLD.withdrawable_after) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'Ledger entries are immutable. No updates or deletes allowed.';
END;
$function$;
