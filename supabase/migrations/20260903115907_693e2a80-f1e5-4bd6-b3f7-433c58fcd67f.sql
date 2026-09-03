DO $$
DECLARE
  v_line_id uuid := '8073c141-6b2f-4e80-93cf-2efbd2a95f0e';
  v_commitment uuid := '819af0b3-b2b1-435e-95f7-1d5b193cc141';
  v_rr uuid := 'fadb4b57-8176-494f-ba39-2d63c2ccec25';
  v_res jsonb;
  v_paid numeric;
BEGIN
  -- Safety: never touch a plan whose landlord was already partly paid from float.
  SELECT COALESCE(SUM(COALESCE(paid_out_amount,0)),0) INTO v_paid
    FROM public.agent_landlord_float_allocations
   WHERE rent_request_id = v_rr;

  IF v_paid > 0 THEN
    RAISE EXCEPTION 'Aborting: landlord already paid % from float for this plan', v_paid;
  END IF;

  -- Release the plan back to the company disbursement queue (no money movement:
  -- there are no open allocations, so no reversal legs are posted).
  v_res := public.psm_release_self_funding_line(
    v_line_id,
    'Self-support reservation cancelled: promissory note partner account does not exist on the platform and no principal was ever collected, so the plan was permanently fenced out of the CFO landlord float queue.'
  );

  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Release failed: %', v_res;
  END IF;

  UPDATE public.partner_self_funding_lines
     SET status = 'cancelled', updated_at = now()
   WHERE id = v_line_id;

  UPDATE public.partner_self_commitments
     SET status = 'cancelled', updated_at = now()
   WHERE id = v_commitment
     AND status = 'pending_ops_approval';

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
  VALUES ('psm_phantom_self_support_reservation_cancelled', 'rent_requests', v_rr::text,
          'Unblocked CFO landlord float disbursement: empty self-support reservation from a non-existent partner account cancelled.',
          jsonb_build_object('line_id', v_line_id, 'commitment_id', v_commitment, 'release_result', v_res));
END $$;