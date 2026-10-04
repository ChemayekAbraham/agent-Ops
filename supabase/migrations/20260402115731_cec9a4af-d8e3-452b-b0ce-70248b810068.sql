
CREATE OR REPLACE FUNCTION public.log_ledger_wallet_transfer_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.category = 'wallet_transfer' AND NEW.direction = 'cash_out' THEN
    PERFORM public.log_system_event(
      'wallet_transfer'::system_event_type,
      NEW.user_id,
      'general_ledger'::text,
      NEW.id,
      jsonb_build_object('amount', NEW.amount, 'transaction_group_id', NEW.transaction_group_id)
    );
  END IF;
  RETURN NEW;
END;
$function$;
