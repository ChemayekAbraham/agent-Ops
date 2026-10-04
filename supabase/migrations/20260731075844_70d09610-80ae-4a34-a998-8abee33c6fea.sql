CREATE OR REPLACE FUNCTION public.enforce_ledger_group_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_net numeric;
  v_cutoff timestamptz;
  v_first_at timestamptz;
  v_is_correction boolean;
  v_has_production boolean;
  v_has_correction_class boolean;
BEGIN
  IF NEW.transaction_group_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT enforce_from INTO v_cutoff FROM public.ledger_integrity_config WHERE id = true;
  IF v_cutoff IS NULL THEN v_cutoff := now(); END IF;

  SELECT MIN(created_at) INTO v_first_at
    FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id;

  IF v_first_at IS NULL OR v_first_at < v_cutoff THEN
    RETURN NEW;
  END IF;

  -- Is this group a system balance correction group?
  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger
     WHERE transaction_group_id = NEW.transaction_group_id
       AND category = 'system_balance_correction'
  ) INTO v_is_correction;

  IF v_is_correction THEN
    -- Correction groups may legitimately mix 'production' and 'admin_correction'
    -- (the correction leg is force-classified by enforce_correction_classification).
    -- Nothing else is allowed, and the group must still net to zero across both.
    IF EXISTS (
      SELECT 1 FROM public.general_ledger
       WHERE transaction_group_id = NEW.transaction_group_id
         AND classification NOT IN ('production','admin_correction')
    ) THEN
      RAISE EXCEPTION 'System balance correction group % contains disallowed classifications.',
        NEW.transaction_group_id
        USING HINT = 'Correction groups may only contain production or admin_correction legs.';
    END IF;

    SELECT SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END)
      INTO v_net
      FROM public.general_ledger
     WHERE transaction_group_id = NEW.transaction_group_id
       AND classification IN ('production','admin_correction');

    IF v_net IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Ledger group % is unbalanced (net=%). Every wallet activity must post balanced double-entry legs.',
        NEW.transaction_group_id, v_net
        USING HINT = 'Use create_ledger_transaction with matching credit/debit legs.';
    END IF;

    RETURN NEW;
  END IF;

  -- Non-correction groups: no mixing of production and admin_correction allowed.
  SELECT
    bool_or(classification = 'production'),
    bool_or(classification = 'admin_correction')
    INTO v_has_production, v_has_correction_class
    FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id;

  IF COALESCE(v_has_production, false) AND COALESCE(v_has_correction_class, false) THEN
    RAISE EXCEPTION 'Ledger group % mixes production and admin_correction classifications.',
      NEW.transaction_group_id
      USING HINT = 'Mixed classifications are only permitted for system_balance_correction groups.';
  END IF;

  IF NEW.classification IS DISTINCT FROM 'production' THEN
    RETURN NEW;
  END IF;

  SELECT SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END)
    INTO v_net
    FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id
     AND classification = 'production';

  IF v_net IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Ledger group % is unbalanced (net=%). Every wallet activity must post balanced double-entry legs.',
      NEW.transaction_group_id, v_net
      USING HINT = 'Use create_ledger_transaction with matching credit/debit legs.';
  END IF;

  RETURN NEW;
END;
$function$;