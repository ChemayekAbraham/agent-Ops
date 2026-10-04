ALTER TABLE public.service_centre_setups
  ADD COLUMN IF NOT EXISTS payee_user_id uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS payee_name text,
  ADD COLUMN IF NOT EXISTS payee_phone text,
  ADD COLUMN IF NOT EXISTS payee_note text,
  ADD COLUMN IF NOT EXISTS payee_set_by uuid,
  ADD COLUMN IF NOT EXISTS payee_set_at timestamptz;

CREATE OR REPLACE FUNCTION public.cfo_decide_service_centre(
  p_id uuid,
  p_decision text,
  p_comment text,
  p_amount numeric DEFAULT NULL::numeric,
  p_payee_user_id uuid DEFAULT NULL::uuid,
  p_payee_name text DEFAULT NULL::text,
  p_payee_phone text DEFAULT NULL::text,
  p_payee_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_comment text := btrim(coalesce(p_comment, ''));
  v_row public.service_centre_setups;
  v_amount numeric;
  v_payee_id uuid;
  v_payee_name text;
  v_payee_phone text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.has_role(v_actor, 'cfo') OR public.has_role(v_actor, 'manager')
          OR public.has_role(v_actor, 'super_admin')) THEN
    RAISE EXCEPTION 'Only the CFO can decide service centre spending';
  END IF;
  IF p_decision NOT IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'Decision must be approved or declined';
  END IF;
  IF length(v_comment) < 10 THEN
    RAISE EXCEPTION 'A comment of at least 10 characters is required';
  END IF;

  SELECT * INTO v_row FROM public.service_centre_setups WHERE id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Service centre not found';
  END IF;
  IF v_row.ceo_approved_at IS NULL OR v_row.status <> 'active' THEN
    RAISE EXCEPTION 'This service centre has not been vetted by the COO yet';
  END IF;
  IF v_row.cfo_decision IS NOT NULL THEN
    RAISE EXCEPTION 'The CFO has already decided this service centre';
  END IF;

  v_amount := CASE WHEN p_decision = 'approved'
                   THEN coalesce(p_amount, v_row.verified_amount)
                   ELSE NULL END;
  IF p_decision = 'approved' AND (v_amount IS NULL OR v_amount <= 0) THEN
    RAISE EXCEPTION 'Enter the amount to be spent';
  END IF;

  v_payee_id := coalesce(p_payee_user_id, v_row.payee_user_id);
  v_payee_name := btrim(coalesce(nullif(btrim(coalesce(p_payee_name, '')), ''), v_row.payee_name, ''));
  v_payee_phone := btrim(coalesce(nullif(btrim(coalesce(p_payee_phone, '')), ''), v_row.payee_phone, ''));

  IF v_payee_id IS NOT NULL AND v_payee_name = '' THEN
    SELECT coalesce(full_name, ''), coalesce(phone, '')
      INTO v_payee_name, v_payee_phone
      FROM public.profiles WHERE id = v_payee_id;
  END IF;

  IF p_decision = 'approved' AND v_payee_name = '' THEN
    RAISE EXCEPTION 'Name who will receive this money';
  END IF;

  UPDATE public.service_centre_setups
     SET cfo_decision = p_decision,
         cfo_decided_by = v_actor,
         cfo_decided_at = now(),
         cfo_approved_amount = v_amount,
         cfo_comment = v_comment,
         payee_user_id = v_payee_id,
         payee_name = nullif(v_payee_name, ''),
         payee_phone = nullif(v_payee_phone, ''),
         payee_note = nullif(btrim(coalesce(p_payee_note, v_row.payee_note, '')), ''),
         payee_set_by = CASE WHEN v_payee_name <> '' THEN v_actor ELSE v_row.payee_set_by END,
         payee_set_at = CASE WHEN v_payee_name <> '' THEN now() ELSE v_row.payee_set_at END
   WHERE id = p_id;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  VALUES (v_actor,
          'service_centre_cfo_' || p_decision,
          'service_centre_cfo_' || p_decision,
          'service_centre_setups', p_id, v_comment,
          jsonb_build_object('amount', v_amount, 'agent_id', v_row.agent_id, 'agent_name', v_row.agent_name,
                             'coo_comment', v_row.ceo_comment, 'ops_comment', v_row.verification_comment,
                             'payee_user_id', v_payee_id, 'payee_name', nullif(v_payee_name, ''),
                             'payee_phone', nullif(v_payee_phone, '')));

  RETURN jsonb_build_object('status', 'ok', 'decision', p_decision, 'amount', v_amount,
                            'payee_name', nullif(v_payee_name, ''), 'payee_user_id', v_payee_id);
END;
$function$;