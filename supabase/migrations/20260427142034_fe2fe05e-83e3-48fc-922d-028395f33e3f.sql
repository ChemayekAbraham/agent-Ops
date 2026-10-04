CREATE OR REPLACE FUNCTION public.log_wallet_transfer_to_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.sender_id IS NOT NULL
     AND NEW.recipient_id IS NOT NULL
     AND NEW.sender_id = NEW.recipient_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.pending_wallet_operations (
    amount, direction, category, description,
    user_id, linked_party, source_table, source_id, status
  ) VALUES (
    NEW.amount,'cash_out','wallet_transfer',
    COALESCE(NEW.description,'Transfer sent'),
    NEW.sender_id,'Recipient','wallet_transactions',NEW.id,'pending'
  );
  INSERT INTO public.pending_wallet_operations (
    amount, direction, category, description,
    user_id, linked_party, source_table, source_id, status
  ) VALUES (
    NEW.amount,'cash_in','wallet_transfer',
    COALESCE(NEW.description,'Transfer received'),
    NEW.recipient_id,'Sender','wallet_transactions',NEW.id,'pending'
  );
  RETURN NEW;
END;
$function$;

UPDATE public.pending_wallet_operations
SET status = 'auto_cancelled',
    description = pending_wallet_operations.description ||
      ' [auto-cancelled: phantom card from internal self-transfer]',
    updated_at = now()
WHERE id IN (
  SELECT p.id
  FROM public.pending_wallet_operations p
  JOIN public.wallet_transactions w ON w.id = p.source_id
  WHERE p.source_table = 'wallet_transactions'
    AND p.status = 'pending'
    AND w.sender_id = w.recipient_id
);