
CREATE OR REPLACE FUNCTION public.create_ledger_transaction(entries jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  group_id UUID := gen_random_uuid();
  total_cash_in NUMERIC := 0;
  total_cash_out NUMERIC := 0;
  entry JSONB;
BEGIN
  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    IF entry->>'direction' = 'cash_in' THEN
      total_cash_in := total_cash_in + (entry->>'amount')::NUMERIC;
    ELSIF entry->>'direction' = 'cash_out' THEN
      total_cash_out := total_cash_out + (entry->>'amount')::NUMERIC;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in or cash_out', entry->>'direction';
    END IF;
  END LOOP;

  IF total_cash_in != total_cash_out THEN
    RAISE EXCEPTION 'UNBALANCED TRANSACTION: cash_in=% cash_out=%', total_cash_in, total_cash_out;
  END IF;

  IF total_cash_in = 0 THEN
    RAISE EXCEPTION 'EMPTY TRANSACTION: no amounts provided';
  END IF;

  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    INSERT INTO public.general_ledger (
      transaction_group_id,
      user_id,
      ledger_scope,
      direction,
      amount,
      category,
      description,
      reference_id,
      created_at
    ) VALUES (
      group_id,
      NULLIF(entry->>'user_id', '')::UUID,
      COALESCE(entry->>'ledger_scope', 'wallet'),
      entry->>'direction',
      (entry->>'amount')::NUMERIC,
      COALESCE(entry->>'category', 'general'),
      entry->>'description',
      entry->>'reference_id',
      NOW()
    );
  END LOOP;

  RETURN group_id;
END;
$function$;
