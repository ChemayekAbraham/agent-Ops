-- Self-managed top-ups park the money at request time.
--
-- partner_self_top_up only checked funder_float_available and left the money
-- spendable ("Capital stays in your wallet until Partner Ops confirms"), so by
-- approval the float could already be gone. It now posts the same hold as
-- portfolio-topup (wallet partner_funding cash_out, float bucket / operational
-- wallet + platform pending_portfolio_topup cash_in), key psm-topup-hold-<id>.
-- Approve releases the parked platform leg into partner_funding (as
-- merge_paidout_topups applies) and no longer touches the wallet for a held
-- request; reject returns the hold to float (key psm-topup-release-<id>).
-- Requests without a hold (none exist: partner_self_topups had 0 rows on
-- 2026-10-27) keep the old approve path. All three are CREATE OR REPLACE, so
-- existing EXECUTE grants stay.

CREATE OR REPLACE FUNCTION public.partner_self_top_up(p_commitment_id uuid, p_rent_request_ids uuid[], p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := COALESCE(NULLIF(p_idempotency_key, ''), gen_random_uuid()::text);
  c public.partner_self_commitments%ROWTYPE;
  v_existing public.partner_self_topups%ROWTYPE;
  v_elig jsonb;
  v_total numeric;
  v_count integer;
  v_available numeric;
  v_topup_id uuid;
  v_days_left integer;
  v_days_in_cycle integer;
  v_prorata numeric;
  v_hold_group uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-topup-' || v_uid::text));

  SELECT * INTO v_existing FROM public.partner_self_topups WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('topup_id', v_existing.id, 'idempotent_replay', true,
                              'status', v_existing.status,
                              'amount', v_existing.amount, 'lines', v_existing.lines_count);
  END IF;

  SELECT * INTO c FROM public.partner_self_commitments
   WHERE id = p_commitment_id AND partner_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'no_data_found';
  END IF;

  v_elig := public.partner_self_topup_eligibility(p_commitment_id);
  IF NOT (v_elig->>'allow_topup')::boolean THEN
    RAISE EXCEPTION 'PSM_TOPUP_WINDOW_CLOSED: %', COALESCE(v_elig->>'block_reason', 'Top-up not allowed')
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_count, v_total
  FROM public.partner_self_plan_claims
  WHERE partner_id = v_uid AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some selections are no longer held by you. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_uid);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'Top-up totals UGX %. Your operational float has UGX % available. You are UGX % over.',
      round(v_total), round(v_available), round(v_total - v_available)
      USING ERRCODE = 'check_violation';
  END IF;

  v_days_in_cycle := GREATEST(1, (v_elig->>'days_in_cycle')::integer);
  v_days_left     := GREATEST(0, LEAST((v_elig->>'days_left_in_cycle')::integer, v_days_in_cycle));
  v_prorata       := round(v_total * c.monthly_rate / 100 * v_days_left::numeric / v_days_in_cycle);

  INSERT INTO public.partner_self_topups (
    partner_id, commitment_id, amount, lines_count, prorata_days,
    days_in_cycle, prorata_amount, inherits_term_end_at, idempotency_key,
    status, rent_request_ids
  ) VALUES (
    v_uid, c.id, v_total, v_count, v_days_left,
    v_days_in_cycle, v_prorata, c.term_end_at, v_key,
    'pending_review', p_rent_request_ids
  ) RETURNING id INTO v_topup_id;

  -- Park the capital now: it leaves the spendable operational float and waits
  -- as pending capital, so it is still there when Partner Ops approves.
  -- Same legs as portfolio-topup's float hold. The funder_float_available
  -- check above (under the advisory lock) is the gate; float debits get no
  -- balance check inside create_ledger_transaction.
  v_hold_group := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_total, 'direction', 'cash_out',
        'category', 'partner_funding', 'ledger_scope', 'wallet',
        'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
        'source_table', 'partner_self_topups', 'source_id', v_topup_id,
        'linked_party', 'platform', 'currency', 'UGX',
        'description', 'Operational float held for self-managed top-up awaiting Partner Ops review'
      ),
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_total, 'direction', 'cash_in',
        'category', 'pending_portfolio_topup', 'ledger_scope', 'platform',
        'source_table', 'partner_self_topups', 'source_id', v_topup_id,
        'linked_party', v_uid::text, 'currency', 'UGX',
        'description', 'Self-managed top-up capital parked pending Partner Ops review'
      )
    ),
    idempotency_key := 'psm-topup-hold-' || v_topup_id::text
  );

  -- keep the plans reserved for this partner while Partner Ops reviews
  UPDATE public.partner_self_plan_claims
     SET expires_at = now() + interval '14 days', updated_at = now()
   WHERE partner_id = v_uid AND status = 'held'
     AND rent_request_id = ANY(p_rent_request_ids);

  PERFORM public.psm_audit(v_uid, v_uid, 'topup_review_requested',
    'partner_self_topups', v_topup_id,
    jsonb_build_object('commitment_id', c.id, 'amount', v_total, 'lines', v_count,
                       'prorata_days', v_days_left, 'days_in_cycle', v_days_in_cycle,
                       'prorata_amount', v_prorata, 'available_before', v_available,
                       'hold_group_id', v_hold_group));

  RETURN jsonb_build_object(
    'topup_id', v_topup_id,
    'commitment_id', c.id,
    'status', 'pending_review',
    'requires_review', true,
    'amount', v_total,
    'lines', v_count,
    'prorata_days', v_days_left,
    'days_in_cycle', v_days_in_cycle,
    'prorata_amount', v_prorata,
    'full_monthly_return', round(v_total * c.monthly_rate / 100),
    'term_end_at', c.term_end_at,
    'message', 'Top-up submitted. The amount is held from your operational float until Partner Ops confirms.',
    'available_balance', public.funder_float_available(v_uid)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_ops_approve_self_topup(p_topup_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  t public.partner_self_topups%ROWTYPE;
  c public.partner_self_commitments%ROWTYPE;
  v_count integer;
  v_total numeric;
  v_available numeric;
  v_entries jsonb;
  v_group uuid;
  v_float jsonb;
  v_held boolean;
BEGIN
  IF NOT public.psm_is_topup_reviewer(v_uid) THEN
    RAISE EXCEPTION 'Not authorised to review self-managed top-ups' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO t FROM public.partner_self_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status <> 'pending_review' THEN
    RAISE EXCEPTION 'This top-up is already %', t.status USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO c FROM public.partner_self_commitments WHERE id = t.commitment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_count, v_total
  FROM public.partner_self_plan_claims
  WHERE partner_id = t.partner_id AND status = 'held'
    AND rent_request_id = ANY(t.rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(t.rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some of the selected plans are no longer reserved for this partner. Reject this request and ask them to reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_held := EXISTS (SELECT 1 FROM public.general_ledger
                     WHERE idempotency_key = 'psm-topup-hold-' || t.id::text);
  IF v_held AND v_total <> t.amount THEN
    RAISE EXCEPTION 'The reserved plans now total UGX %, but UGX % was held. Reject this request and ask the partner to resubmit.',
      round(v_total), round(t.amount) USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(t.partner_id);
  IF NOT v_held AND v_total > v_available THEN
    RAISE EXCEPTION 'Partner operational float no longer covers this top-up. Needs UGX %, available UGX %.',
      round(v_total), round(v_available) USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT c.id, t.partner_id, cl.rent_request_id, cl.amount, c.monthly_rate, c.term_months
  FROM public.partner_self_plan_claims cl
  WHERE cl.partner_id = t.partner_id AND cl.status = 'held'
    AND cl.rent_request_id = ANY(t.rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=c.id, updated_at=now()
   WHERE partner_id = t.partner_id AND status='held' AND rent_request_id = ANY(t.rent_request_ids);

  UPDATE public.rent_requests rr
     SET self_funding_partner_id = t.partner_id,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = c.id
    AND l.rent_request_id = ANY(t.rent_request_ids)
    AND rr.id = l.rent_request_id
    AND rr.self_funding_partner_id IS NULL;

  IF v_held THEN
    -- The money left the partner's float at request time; release the parked
    -- platform leg into partner_funding (as merge_paidout_topups applies).
    v_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', t.partner_id, 'amount', v_total, 'direction', 'cash_out',
        'category', 'pending_portfolio_topup', 'ledger_scope', 'platform',
        'source_table', 'partner_self_topups', 'source_id', t.id,
        'linked_party', t.partner_id::text,
        'description', 'Parked self-managed top-up capital applied on Partner Ops approval'
      ),
      jsonb_build_object(
        'amount', v_total, 'direction', 'cash_in',
        'category', 'partner_funding', 'ledger_scope', 'platform',
        'source_table', 'partner_self_topups', 'source_id', t.id,
        'linked_party', t.partner_id::text,
        'description', 'Self-managed partner top-up capital received (self_managed_partner; float_usage=self_portfolio_funding)'
      )
    );
  ELSE
  -- Legacy request submitted before holds existed: debit the float now.
  v_entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', t.partner_id, 'amount', v_total, 'direction', 'cash_out',
      'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
      'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
      'source_table', 'partner_self_topups', 'source_id', t.id,
      'description', 'Self-managed portfolio top-up (float_usage=self_portfolio_funding)'
    ),
    jsonb_build_object(
      'amount', v_total, 'direction', 'cash_in',
      'category', 'partner_funding', 'ledger_scope', 'platform',
      'source_table', 'partner_self_topups', 'source_id', t.id,
      'linked_party', t.partner_id::text,
      'description', 'Self-managed partner top-up capital received (self_managed_partner; float_usage=self_portfolio_funding)'
    )
  );
  END IF;

  v_group := public.create_ledger_transaction(
    entries := v_entries,
    idempotency_key := 'psm-topup-' || t.id::text
  );

  UPDATE public.partner_self_topups
     SET ledger_group_id = v_group,
         status = 'approved',
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_notes = NULLIF(btrim(COALESCE(p_notes,'')), ''),
         effective_at = now(),
         updated_at = now()
   WHERE id = t.id;

  UPDATE public.partner_self_commitments
     SET committed_amount = committed_amount + v_total,
         lines_count = lines_count + v_count,
         updated_at = now()
   WHERE id = c.id;

  -- Release the principal straight to the relevant agents' landlord float.
  v_float := public.psm_disburse_landlord_float(c.id, t.id, t.rent_request_ids);

  PERFORM public.psm_audit(v_uid, t.partner_id, 'topup_review_approved',
    'partner_self_topups', t.id,
    jsonb_build_object('commitment_id', c.id, 'amount', v_total, 'lines', v_count,
                       'ledger_group_id', v_group, 'notes', p_notes, 'was_held', v_held,
                       'landlord_float', v_float));

  RETURN jsonb_build_object('topup_id', t.id, 'status', 'approved',
                            'amount', v_total, 'lines', v_count, 'ledger_group_id', v_group,
                            'landlord_float', v_float);
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_ops_reject_self_topup(p_topup_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  t public.partner_self_topups%ROWTYPE;
  v_released integer;
  v_release_group uuid;
BEGIN
  IF NOT public.psm_is_topup_reviewer(v_uid) THEN
    RAISE EXCEPTION 'Not authorised to review self-managed top-ups' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason,''))) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO t FROM public.partner_self_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status <> 'pending_review' THEN
    RAISE EXCEPTION 'This top-up is already %', t.status USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.partner_self_plan_claims
     SET status='released', closed_at=now(), updated_at=now()
   WHERE partner_id = t.partner_id AND status='held'
     AND rent_request_id = ANY(t.rent_request_ids);
  GET DIAGNOSTICS v_released = ROW_COUNT;

  IF EXISTS (SELECT 1 FROM public.general_ledger
              WHERE idempotency_key = 'psm-topup-hold-' || t.id::text) THEN
    v_release_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', t.partner_id, 'amount', t.amount, 'direction', 'cash_out',
          'category', 'pending_portfolio_topup', 'ledger_scope', 'platform',
          'source_table', 'partner_self_topups', 'source_id', t.id,
          'linked_party', t.partner_id::text, 'currency', 'UGX',
          'description', 'Self-managed top-up rejected: parked capital released'
        ),
        jsonb_build_object(
          'user_id', t.partner_id, 'amount', t.amount, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'partner_self_topups', 'source_id', t.id,
          'linked_party', 'platform', 'currency', 'UGX',
          'description', 'Held self-managed top-up returned to operational float'
        )
      ),
      idempotency_key := 'psm-topup-release-' || t.id::text
    );
  END IF;

  UPDATE public.partner_self_topups
     SET status = 'rejected',
         reviewed_by = v_uid,
         reviewed_at = now(),
         rejection_reason = btrim(p_reason),
         updated_at = now()
   WHERE id = t.id;

  PERFORM public.psm_audit(v_uid, t.partner_id, 'topup_review_rejected',
    'partner_self_topups', t.id,
    jsonb_build_object('amount', t.amount, 'reason', btrim(p_reason), 'released_plans', v_released,
                       'release_group_id', v_release_group));

  RETURN jsonb_build_object('topup_id', t.id, 'status', 'rejected', 'released_plans', v_released);
END;
$function$;
