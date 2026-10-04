ALTER TABLE public.partner_self_commitments ALTER COLUMN term_months SET DEFAULT 1;
ALTER TABLE public.partner_self_funding_lines ALTER COLUMN term_months SET DEFAULT 1;
CREATE OR REPLACE FUNCTION public.partner_self_confirm_commitment(p_rent_request_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := COALESCE(NULLIF(p_idempotency_key,''), 'psm-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids,',')));
  v_existing public.partner_self_commitments%ROWTYPE;
  v_commitment_id uuid;
  v_total numeric;
  v_count integer;
  v_min numeric;
  v_available numeric;
  v_rate numeric := 15;
  v_entries jsonb;
  v_group uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || v_uid::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
                              'committed_amount', v_existing.committed_amount,
                              'lines', v_existing.lines_count);
  END IF;

  SELECT COUNT(*), COALESCE(SUM(amount),0), COALESCE(MIN(amount),0)
  INTO v_count, v_total, v_min
  FROM public.partner_self_plan_claims
  WHERE partner_id = v_uid AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some selections are no longer held by you. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_min < 50000 THEN
    RAISE EXCEPTION 'Each plan you fund must be at least UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. Your selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.get_user_available_balance(v_uid);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'Selected plans total UGX %. Your wallet has UGX % available. You are UGX % over.',
      round(v_total), round(v_available), round(v_total - v_available)
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key
  ) VALUES (
    v_uid, v_total, GREATEST(1, LEAST(COALESCE(p_term_months,1), 12)), v_rate, v_count, v_key
  ) RETURNING id INTO v_commitment_id;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT v_commitment_id, v_uid, c.rent_request_id, c.amount, v_rate,
         GREATEST(1, LEAST(COALESCE(p_term_months,1), 12))
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = v_uid AND c.status='held' AND c.rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=v_commitment_id, updated_at=now()
   WHERE partner_id = v_uid AND status='held' AND rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.rent_requests rr
     SET self_funding_partner_id = v_uid,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = v_commitment_id AND rr.id = l.rent_request_id;

  SELECT jsonb_agg(e) INTO v_entries FROM (
    SELECT jsonb_build_object(
      'user_id', v_uid, 'amount', l.principal, 'direction', 'cash_out',
      'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
      'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'partner_self_funding_lines', 'source_id', l.id,
      'reference_id', l.rent_request_id::text,
      'description', 'Self-managed partner funding committed (self_managed_partner)'
    ) AS e
    FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_commitment_id
    UNION ALL
    SELECT jsonb_build_object(
      'amount', l.principal, 'direction', 'cash_in',
      'category', 'partner_funding', 'ledger_scope', 'platform',
      'source_table', 'partner_self_funding_lines', 'source_id', l.id,
      'reference_id', l.rent_request_id::text,
      'linked_party', v_uid::text,
      'description', 'Self-managed partner capital received (self_managed_partner)'
    )
    FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_commitment_id
  ) s;

  v_group := public.create_ledger_transaction(
    entries := v_entries,
    idempotency_key := 'psm-commit-' || v_commitment_id::text
  );

  UPDATE public.partner_self_commitments
     SET ledger_group_id = v_group, updated_at = now()
   WHERE id = v_commitment_id;

  PERFORM public.psm_audit(v_uid, v_uid, 'commitment_confirmed', 'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'lines', v_count, 'term_months', p_term_months,
                       'linked_party', 'self_managed_partner',
                       'ledger_group_id', v_group, 'available_before', v_available));

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'committed_amount', v_total, 'lines', v_count,
    'monthly_return', round(v_total * v_rate / 100), 'ledger_group_id', v_group,
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.psm_anchor_commitment_on_first_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.partner_self_commitments c
     SET payout_anchor_at = NEW.live_at,
         payout_day       = EXTRACT(DAY FROM NEW.live_at)::smallint,
         next_payout_at   = NEW.live_at + interval '1 month',
         term_end_at      = NEW.live_at + (GREATEST(1, COALESCE(c.term_months, 1)) || ' months')::interval,
         updated_at       = now()
   WHERE c.id = NEW.commitment_id
     AND c.payout_anchor_at IS NULL;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.partner_self_topup_eligibility(p_commitment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  c public.partner_self_commitments%ROWTYPE;
  v_days_remaining integer;
  v_cycles_remaining integer;
  v_cycle_start date;
  v_cycle_end date;
  v_days_in_cycle integer;
  v_days_left_in_cycle integer;
  v_allow boolean;
  v_reason text;
  v_lockout_days integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM public.partner_self_commitments
   WHERE id = p_commitment_id AND partner_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'no_data_found';
  END IF;

  v_lockout_days := CASE WHEN COALESCE(c.term_months,1) <= 3 THEN 5 ELSE 90 END;
  v_days_remaining   := GREATEST(0, COALESCE(c.term_end_at::date, CURRENT_DATE) - CURRENT_DATE);
  v_cycles_remaining := GREATEST(0, floor(v_days_remaining::numeric / 30)::integer);

  v_cycle_end   := COALESCE(c.next_payout_at::date, CURRENT_DATE + 30);
  v_cycle_start := (COALESCE(c.next_payout_at, now() + interval '1 month') - interval '1 month')::date;
  v_days_in_cycle      := GREATEST(1, v_cycle_end - v_cycle_start);
  v_days_left_in_cycle := GREATEST(0, v_cycle_end - CURRENT_DATE);

  IF c.status <> 'active' THEN
    v_allow := false;
    v_reason := 'This portfolio is ' || c.status || '. New capital starts a fresh monthly portfolio.';
  ELSIF c.term_end_at IS NOT NULL AND v_days_remaining <= v_lockout_days THEN
    v_allow := false;
    v_reason := 'This portfolio matures in ' || v_days_remaining
             || ' days. The final ' || v_lockout_days || ' days are reserved for returning principal, so new capital starts a fresh monthly portfolio.';
  ELSE
    v_allow := true;
    v_reason := NULL;
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', c.id,
    'status', c.status,
    'committed_amount', c.committed_amount,
    'monthly_rate', c.monthly_rate,
    'term_end_at', c.term_end_at,
    'next_payout_at', c.next_payout_at,
    'days_remaining', v_days_remaining,
    'cycles_remaining', v_cycles_remaining,
    'days_in_cycle', v_days_in_cycle,
    'days_left_in_cycle', v_days_left_in_cycle,
    'allow_topup', v_allow,
    'block_reason', v_reason,
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$function$;