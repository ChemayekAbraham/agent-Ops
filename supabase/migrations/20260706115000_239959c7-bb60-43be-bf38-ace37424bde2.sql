-- Approval tracking for promissory notes + verified-note bonus to the proxy agent
ALTER TABLE public.promissory_notes
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approval_reason TEXT,
  ADD COLUMN IF NOT EXISTS approval_bonus_paid BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.approve_promissory_note(
  p_note_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_note RECORD;
  v_actor UUID := auth.uid();
  v_amount NUMERIC := 1500;
  v_idempotency_key TEXT;
  v_group_id UUID;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Not authenticated');
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 20 THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'A reason of at least 20 characters is required.');
  END IF;

  SELECT * INTO v_note FROM public.promissory_notes WHERE id = p_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Promissory note not found');
  END IF;

  IF v_note.approval_bonus_paid THEN
    RETURN jsonb_build_object('status', 'already_approved');
  END IF;

  v_idempotency_key := 'promissory_note_verified:' || p_note_id::text;

  -- Pay UGX 1,500 to the proxy agent's withdrawable wallet from platform funds
  v_group_id := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_note.agent_id,
        'amount', v_amount,
        'direction', 'cash_out',
        'category', 'marketing_expense',
        'source_table', 'promissory_notes',
        'source_id', p_note_id::text,
        'description', 'Marketing expense: Verified promissory note bonus',
        'ledger_scope', 'platform'
      ),
      jsonb_build_object(
        'user_id', v_note.agent_id,
        'amount', v_amount,
        'direction', 'cash_in',
        'category', 'agent_commission',
        'source_table', 'promissory_notes',
        'source_id', p_note_id::text,
        'description', 'Bonus: Verified promissory note',
        'ledger_scope', 'wallet',
        'recipient_type', 'user'
      )
    ),
    v_idempotency_key
  );

  UPDATE public.promissory_notes
  SET approved_at = now(),
      approved_by = v_actor,
      approval_reason = btrim(p_reason),
      approval_bonus_paid = true,
      status = CASE WHEN status = 'pending' THEN 'activated' ELSE status END,
      updated_at = now()
  WHERE id = p_note_id;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (
    v_actor, 'update', 'approve_promissory_note', 'promissory_notes', p_note_id::text,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'agent_id', v_note.agent_id,
      'partner_name', v_note.partner_name,
      'bonus_amount', v_amount,
      'ledger_group_id', v_group_id
    )
  );

  BEGIN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      v_note.agent_id,
      'Reward earned: UGX 1,500',
      'Your promissory note for ' || v_note.partner_name || ' was verified — UGX 1,500 has been added to your wallet.',
      'success',
      jsonb_build_object('source_id', p_note_id, 'amount', v_amount, 'ledger_group_id', v_group_id)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'approve_promissory_note notification failed for %: %', p_note_id, SQLERRM;
  END;

  RETURN jsonb_build_object('status', 'approved', 'amount', v_amount, 'ledger_group_id', v_group_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.approve_promissory_note(UUID, TEXT) TO authenticated;