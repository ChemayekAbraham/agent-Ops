CREATE OR REPLACE FUNCTION public.psm_release_self_funding_line(p_line_id uuid, p_reason text DEFAULT 'Self-support funding cancelled — plan released back to ready to fund')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_line   public.partner_self_funding_lines%ROWTYPE;
  v_rr     public.rent_requests%ROWTYPE;
  v_alloc  public.agent_landlord_float_allocations%ROWTYPE;
  v_group  uuid;
  v_reversed numeric := 0;
BEGIN
  SELECT * INTO v_line FROM public.partner_self_funding_lines WHERE id = p_line_id FOR UPDATE;
  IF v_line.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Funding line not found.');
  END IF;
  IF v_line.rent_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Funding line has no rent plan.');
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = v_line.rent_request_id FOR UPDATE;
  IF v_rr.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent plan not found.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations
     WHERE rent_request_id = v_rr.id
       AND source = 'partner_self_funding'
       AND COALESCE(paid_out_amount, 0) > 0
  ) THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_line.partner_id, 'psm_release_skipped_paid_out', 'rent_requests', v_rr.id::text,
            'Self-support release skipped: landlord already partly paid from float',
            jsonb_build_object('line_id', v_line.id, 'partner_id', v_line.partner_id));
    RETURN jsonb_build_object('success', false, 'error', 'Landlord already paid from float — release blocked.');
  END IF;

  FOR v_alloc IN
    SELECT * FROM public.agent_landlord_float_allocations
     WHERE rent_request_id = v_rr.id
       AND source = 'partner_self_funding'
       AND status IN ('open','partially_paid','return_pending')
     FOR UPDATE
  LOOP
    IF COALESCE(v_alloc.remaining_amount, 0) > 0 THEN
      SELECT public.create_ledger_transaction(entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_in',
          'category', 'rent_disbursement', 'ledger_scope', 'platform', 'classification', 'production',
          'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_rr.id,
          'linked_party', v_alloc.landlord_id,
          'description', format('Self-support cancellation — float returned for %s (float_usage=self_portfolio_funding reversal)', COALESCE(v_alloc.landlord_name,'landlord')),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_out',
          'category', 'rent_receivable_created', 'ledger_scope', 'bridge', 'classification', 'production',
          'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_rr.id,
          'linked_party', v_alloc.landlord_id,
          'description', format('Reversal — self-support funding cancelled (%s)', COALESCE(v_alloc.landlord_name,'landlord')),
          'transaction_date', now()
        )
      )) INTO v_group;

      -- balance is recomputed from allocations by the allocation trigger (sole writer);
      -- only the lifetime funded tally is adjusted here.
      UPDATE public.agent_landlord_float
         SET total_funded = GREATEST(0, COALESCE(total_funded,0) - v_alloc.remaining_amount),
             updated_at = now()
       WHERE agent_id = v_alloc.agent_id;

      v_reversed := v_reversed + v_alloc.remaining_amount;
    END IF;

    UPDATE public.agent_landlord_float_allocations
       SET status = 'cancelled',
           notes = COALESCE(notes,'') || ' | Self-support funding cancelled — released back to ready to fund',
           updated_at = now()
     WHERE id = v_alloc.id;
  END LOOP;

  UPDATE public.rent_requests
     SET status = CASE
                    WHEN status IN ('funded','disbursed')
                      THEN CASE WHEN coo_reviewed_at IS NOT NULL THEN 'coo_approved' ELSE 'approved' END
                    ELSE status
                  END,
         funded_at = NULL,
         disbursed_at = NULL,
         self_funding_partner_id = NULL,
         self_funding_line_id = NULL,
         fund_recipient_type = NULL,
         fund_recipient_id = NULL,
         fund_recipient_name = NULL,
         fund_routed_at = NULL,
         funder_visible = true,
         updated_at = now()
   WHERE id = v_rr.id;

  UPDATE public.partner_self_plan_claims
     SET status = 'released', closed_at = now(), updated_at = now()
   WHERE rent_request_id = v_rr.id
     AND status IN ('held','confirmed');

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_line.partner_id, 'psm_release_self_funding_line', 'rent_requests', v_rr.id::text,
          COALESCE(NULLIF(btrim(p_reason),''), 'Self-support funding cancelled — plan released back to ready to fund'),
          jsonb_build_object('line_id', v_line.id, 'commitment_id', v_line.commitment_id,
                             'partner_id', v_line.partner_id, 'float_returned', v_reversed));

  RETURN jsonb_build_object('success', true, 'rent_request_id', v_rr.id, 'float_returned', v_reversed);
END;
$$;

REVOKE ALL ON FUNCTION public.psm_release_self_funding_line(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_release_self_funding_line(uuid, text) TO service_role;
