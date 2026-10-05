-- Pay the promissory partner commission when a note is linked to an account
-- AFTER the partner's money was already recorded (manual fuzzy-match confirmation).
-- Idempotency keys are identical to the trigger paths, so nothing can pay twice.

CREATE OR REPLACE FUNCTION public.promissory_catch_up_partner_commission(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_paid int := 0;
BEGIN
  IF p_partner_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_partner');
  END IF;

  FOR r IN
    SELECT id, investment_amount
      FROM public.investor_portfolios
     WHERE investor_id = p_partner_id
       AND status = 'active'
       AND coalesce(investment_amount,0) > 0
     ORDER BY created_at
  LOOP
    PERFORM public.try_credit_promissory_agent_commission(
      p_partner_id, r.investment_amount, 'portfolio_creation',
      'investor_portfolios', r.id, r.id::text);
    v_paid := v_paid + 1;
  END LOOP;

  FOR r IN
    SELECT id, amount
      FROM public.partner_self_topups
     WHERE partner_id = p_partner_id
       AND status IN ('approved','active','applied')
       AND coalesce(amount,0) > 0
     ORDER BY created_at
  LOOP
    PERFORM public.try_credit_promissory_agent_commission(
      p_partner_id, r.amount, 'portfolio_topup',
      'partner_self_topups', r.id, r.id::text);
    v_paid := v_paid + 1;
  END LOOP;

  RETURN jsonb_build_object('status','ok','sources_considered', v_paid);
END;
$function$;

REVOKE ALL ON FUNCTION public.promissory_catch_up_partner_commission(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promissory_catch_up_partner_commission(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.promissory_confirm_arrival_match(p_note_id uuid, p_user_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_note public.promissory_notes;
  v_name text;
  v_catch_up jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'ceo') OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'partner_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: give a written reason of at least 10 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = p_user_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_ACCOUNT: that account no longer exists.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.promissory_notes
     SET partner_user_id = p_user_id
   WHERE id = p_note_id
     AND (
       partner_user_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = promissory_notes.partner_user_id)
     )
  RETURNING * INTO v_note;

  IF v_note.id IS NULL THEN
    RAISE EXCEPTION 'NOTE_ALREADY_LINKED: this note is already linked to an account.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  VALUES ('promissory_arrival_match_confirmed', 'promissory_notes', v_note.id::text, v_uid,
          btrim(p_reason),
          jsonb_build_object('partner_user_id', p_user_id, 'matched_name', v_name,
                             'note_partner_name', v_note.partner_name, 'basis', 'fuzzy_name_confirmed'));

  -- money already recorded before the link: pay the commission now (idempotent)
  v_catch_up := public.promissory_catch_up_partner_commission(p_user_id);

  RETURN jsonb_build_object('note_id', v_note.id, 'partner_user_id', p_user_id,
                            'matched_name', v_name, 'commission_catch_up', v_catch_up);
END;
$function$;

-- one-off: the note linked manually today for Nteemu Brian Johnmary
DO $$
BEGIN
  PERFORM public.promissory_catch_up_partner_commission('22d19b72-4f42-46e5-9713-942fa7821bd2'::uuid);
END $$;
