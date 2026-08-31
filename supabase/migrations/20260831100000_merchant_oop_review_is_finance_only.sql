-- Merchants no longer claim their own fronted money; Finance owns the decision.
--
-- Fronted own money is now recorded as owed the moment the payout is classified
-- (see 20260829140000). Attestation is no longer the gate that decides whether a
-- debt exists, so asking the merchant to confirm their own receivable serves no
-- purpose -- and letting them do it means the party being paid is the party
-- asserting the amount.
--
-- `review_merchant_out_of_pocket` previously allowed EITHER staff OR the owning
-- agent to call it, with the owner permitted to 'confirm' (and `attested_at`
-- stamped from that branch). The agent-facing UI no longer offers this anywhere,
-- but the RPC still accepted it, so a stale client or a direct API call could
-- still promote a claim. This makes the whole RPC finance-only.
--
-- Rejection was already staff-only and is unchanged: it still requires a reason
-- of 10+ characters, and the settlement dialog is the only surface that offers
-- it. `attested_at` / `attested_by` are left in place and still readable -- they
-- record who confirmed historically; they simply stop being writable by agents.

CREATE OR REPLACE FUNCTION public.review_merchant_out_of_pocket(p_id uuid, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.merchant_out_of_pocket_advances;
  v_is_staff boolean;
  v_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_decision NOT IN ('confirm', 'reject') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;

  SELECT * INTO v_row FROM public.merchant_out_of_pocket_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_not_found';
  END IF;

  v_is_staff := public.has_role(auth.uid(), 'cfo')
             OR public.has_role(auth.uid(), 'financial_ops')
             OR public.has_role(auth.uid(), 'manager')
             OR public.has_role(auth.uid(), 'super_admin');

  -- Finance only. A merchant may no longer confirm their own receivable: the
  -- claim is recorded automatically and Finance decides what is paid.
  IF NOT v_is_staff THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF v_row.status NOT IN ('needs_review', 'pending_reimbursement') THEN
    RAISE EXCEPTION 'record_already_settled';
  END IF;

  IF p_decision = 'reject' THEN
    IF p_note IS NULL OR length(btrim(p_note)) < 10 THEN
      RAISE EXCEPTION 'reason_required_min_10_chars';
    END IF;
    v_status := 'rejected';
  ELSE
    v_status := 'pending_reimbursement';
  END IF;

  UPDATE public.merchant_out_of_pocket_advances
     SET status = v_status,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         review_note = COALESCE(NULLIF(btrim(p_note), ''), review_note)
   WHERE id = p_id;

  INSERT INTO public.system_events (event_type, user_id, description, metadata)
  VALUES (
    'wallet_transfer',
    v_row.agent_id,
    format('Merchant own-money record %s by finance (UGX %s).',
           CASE WHEN p_decision = 'confirm' THEN 'confirmed' ELSE 'rejected' END,
           to_char(COALESCE(v_row.shortfall_amount, 0), 'FM999,999,999')),
    jsonb_build_object(
      'record_id', p_id,
      'withdrawal_id', v_row.withdrawal_id,
      'decision', p_decision,
      'new_status', v_status,
      'actor', auth.uid(),
      'note', p_note
    )
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'status', v_status);
END;
$function$;
