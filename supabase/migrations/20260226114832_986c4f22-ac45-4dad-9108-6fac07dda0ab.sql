
-- Create a function that managers can call to void a ledger entry
-- This function archives the entry and then deletes it, bypassing the trigger
CREATE OR REPLACE FUNCTION public.void_ledger_entry(
  p_ledger_id UUID,
  p_reason TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.general_ledger%ROWTYPE;
  v_user_id UUID;
  v_is_manager BOOLEAN;
BEGIN
  -- Get caller
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Check manager role
  SELECT EXISTS(
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_user_id AND role = 'manager'
  ) INTO v_is_manager;

  IF NOT v_is_manager THEN
    RAISE EXCEPTION 'Only managers can void ledger entries';
  END IF;

  -- Get the ledger row
  SELECT * INTO v_row FROM public.general_ledger WHERE id = p_ledger_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger entry not found';
  END IF;

  -- Archive it
  INSERT INTO public.voided_ledger_entries (
    original_ledger_id, transaction_date, amount, direction, category,
    description, reference_id, linked_party, running_balance, user_id,
    source_table, source_id, account, transaction_group_id,
    voided_by, void_reason
  ) VALUES (
    v_row.id, v_row.transaction_date, v_row.amount, v_row.direction, v_row.category,
    v_row.description, v_row.reference_id, v_row.linked_party, v_row.running_balance, v_row.user_id,
    v_row.source_table, v_row.source_id, v_row.account, v_row.transaction_group_id,
    v_user_id, p_reason
  );

  -- Temporarily disable the append-only trigger to allow deletion
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;
  
  DELETE FROM public.general_ledger WHERE id = p_ledger_id;
  
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
END;
$$;
