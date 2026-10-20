-- tg_credit_tid_backed_float(): also recognise finance-verified manual TIDs.
--
-- Same function as before with ONE addition inside the deposit_requests branch.
-- A cash_in with no gmail_transactions row now still counts as TID-backed when
-- manual_verified_tids holds that exact TID for the same user with an amount at
-- least as large as the credit, and it has not been used yet. The row is marked
-- consumed in the same step, so one verified TID can back float only once. The
-- cash_out, cfo_direct_credit and bucket_reclass_in branches are unchanged.
--
-- Depends on 20261018040000 (table), 20261018040001 (RLS) and 20261018040002 (revoke).

CREATE OR REPLACE FUNCTION public.tg_credit_tid_backed_float()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.ledger_scope <> 'wallet' OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.category = 'agent_float_deposit' AND NEW.source_table = 'deposit_requests' THEN
    IF NEW.direction = 'cash_in' THEN
      IF EXISTS (
        SELECT 1 FROM public.deposit_requests dr
          JOIN public.gmail_transactions gt ON gt.transaction_id = dr.transaction_id
         WHERE dr.id = NEW.source_id
      ) THEN
        PERFORM public.credit_agent_tid_backed_float(NEW.user_id, NEW.amount);
      ELSE
        -- No ingested message. Honour a TID that Financial Ops verified on the
        -- telco statement, once, for the same user and no more than the amount.
        UPDATE public.manual_verified_tids mv
           SET consumed_at = now()
          FROM public.deposit_requests dr
         WHERE dr.id = NEW.source_id
           AND mv.tid_normalized = regexp_replace(lower(btrim(dr.transaction_id)), '^tid', '')
           AND mv.user_id = NEW.user_id
           AND mv.amount >= NEW.amount
           AND mv.consumed_at IS NULL;
        IF FOUND THEN
          PERFORM public.credit_agent_tid_backed_float(NEW.user_id, NEW.amount);
        END IF;
      END IF;
    ELSIF NEW.direction = 'cash_out' THEN
      PERFORM public.credit_agent_tid_backed_float(NEW.user_id, -NEW.amount);
    END IF;
  ELSIF NEW.category = 'agent_float_deposit' AND NEW.source_table = 'cfo_direct_credit' THEN
    -- Financial Ops manually routing an unmatched inbound deposit email or SMS
    -- (Email Transactions panel to cfo-direct-credit) to an agent float. The
    -- routing function stamps the gmail TID into sub_category. Verify it against
    -- gmail_transactions rather than trusting the label.
    IF NEW.direction = 'cash_in' AND NEW.sub_category IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.gmail_transactions gt WHERE gt.transaction_id = NEW.sub_category
    ) THEN
      PERFORM public.credit_agent_tid_backed_float(NEW.user_id, NEW.amount);
    ELSIF NEW.direction = 'cash_out' THEN
      PERFORM public.credit_agent_tid_backed_float(NEW.user_id, -NEW.amount);
    END IF;
  ELSIF NEW.category = 'bucket_reclass_in' AND NEW.direction = 'cash_in'
        AND NEW.source_table = 'agent_withdrawable_to_float' THEN
    PERFORM public.credit_agent_tid_backed_float(NEW.user_id, NEW.amount);
  END IF;

  RETURN NEW;
END;
$function$;
