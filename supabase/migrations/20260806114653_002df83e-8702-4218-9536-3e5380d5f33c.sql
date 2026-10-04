-- 1. Review columns
ALTER TABLE public.partner_self_topups
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS rent_request_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes text,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

ALTER TABLE public.partner_self_topups
  DROP CONSTRAINT IF EXISTS partner_self_topups_status_check;
ALTER TABLE public.partner_self_topups
  ADD CONSTRAINT partner_self_topups_status_check
  CHECK (status IN ('pending_review','approved','rejected'));

ALTER TABLE public.partner_self_topups ALTER COLUMN status SET DEFAULT 'pending_review';

CREATE INDEX IF NOT EXISTS idx_psm_topups_status ON public.partner_self_topups (status, created_at DESC);

-- 2. Request-only self top-up
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

  v_available := public.get_user_available_balance(v_uid);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'Top-up totals UGX %. Your wallet has UGX % available. You are UGX % over.',
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

  -- keep the plans reserved for this partner while Partner Ops reviews
  UPDATE public.partner_self_plan_claims
     SET expires_at = now() + interval '14 days', updated_at = now()
   WHERE partner_id = v_uid AND status = 'held'
     AND rent_request_id = ANY(p_rent_request_ids);

  PERFORM public.psm_audit(v_uid, v_uid, 'topup_review_requested',
    'partner_self_topups', v_topup_id,
    jsonb_build_object('commitment_id', c.id, 'amount', v_total, 'lines', v_count,
                       'prorata_days', v_days_left, 'days_in_cycle', v_days_in_cycle,
                       'prorata_amount', v_prorata, 'available_before', v_available));

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
    'message', 'Top-up submitted. Capital stays in your wallet until Partner Ops confirms.',
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$function$;

-- 3. Ops gate helper
CREATE OR REPLACE FUNCTION public.psm_is_topup_reviewer(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p_uid IS NOT NULL AND (
    public.is_ops_role(p_uid)
    OR public.has_role(p_uid, 'cfo'::app_role)
    OR public.has_role(p_uid, 'coo'::app_role)
    OR public.has_role(p_uid, 'ceo'::app_role)
    OR public.has_role(p_uid, 'manager'::app_role)
    OR public.has_role(p_uid, 'super_admin'::app_role)
  );
$function$;

-- 4. Approve
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

  v_available := public.get_user_available_balance(t.partner_id);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'Partner wallet no longer covers this top-up. Needs UGX %, available UGX %.',
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

  v_entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', t.partner_id, 'amount', v_total, 'direction', 'cash_out',
      'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
      'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'partner_self_topups', 'source_id', t.id,
      'description', 'Self-managed portfolio top-up'
    ),
    jsonb_build_object(
      'amount', v_total, 'direction', 'cash_in',
      'category', 'partner_funding', 'ledger_scope', 'platform',
      'source_table', 'partner_self_topups', 'source_id', t.id,
      'linked_party', t.partner_id::text,
      'description', 'Self-managed partner top-up capital received'
    )
  );

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

  PERFORM public.psm_audit(v_uid, t.partner_id, 'topup_review_approved',
    'partner_self_topups', t.id,
    jsonb_build_object('commitment_id', c.id, 'amount', v_total, 'lines', v_count,
                       'ledger_group_id', v_group, 'notes', p_notes));

  RETURN jsonb_build_object('topup_id', t.id, 'status', 'approved',
                            'amount', v_total, 'lines', v_count, 'ledger_group_id', v_group);
END;
$function$;

-- 5. Reject
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

  UPDATE public.partner_self_topups
     SET status = 'rejected',
         reviewed_by = v_uid,
         reviewed_at = now(),
         rejection_reason = btrim(p_reason),
         updated_at = now()
   WHERE id = t.id;

  PERFORM public.psm_audit(v_uid, t.partner_id, 'topup_review_rejected',
    'partner_self_topups', t.id,
    jsonb_build_object('amount', t.amount, 'reason', btrim(p_reason), 'released_plans', v_released));

  RETURN jsonb_build_object('topup_id', t.id, 'status', 'rejected', 'released_plans', v_released);
END;
$function$;

-- 6. Review queue listing
CREATE OR REPLACE FUNCTION public.partner_ops_list_self_topup_reviews(p_status text DEFAULT 'pending_review', p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
BEGIN
  IF NOT public.psm_is_topup_reviewer(v_uid) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(r ORDER BY r->>'created_at' DESC), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
             'id', t.id,
             'partner_id', t.partner_id,
             'partner_name', COALESCE(pr.full_name, pr.email, 'Partner'),
             'partner_phone', pr.phone,
             'commitment_id', t.commitment_id,
             'portfolio_code', c.portfolio_code,
             'amount', t.amount,
             'lines_count', t.lines_count,
             'prorata_amount', t.prorata_amount,
             'prorata_days', t.prorata_days,
             'days_in_cycle', t.days_in_cycle,
             'monthly_rate', c.monthly_rate,
             'status', t.status,
             'created_at', t.created_at,
             'reviewed_at', t.reviewed_at,
             'review_notes', t.review_notes,
             'rejection_reason', t.rejection_reason,
             'partner_available_balance', public.get_user_available_balance(t.partner_id)
           ) AS r
    FROM public.partner_self_topups t
    LEFT JOIN public.partner_self_commitments c ON c.id = t.commitment_id
    LEFT JOIN public.profiles pr ON pr.id = t.partner_id
    WHERE t.status = COALESCE(NULLIF(p_status,''), 'pending_review')
    ORDER BY t.created_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit,50), 200))
  ) s;

  RETURN jsonb_build_object('rows', v_rows);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.partner_ops_approve_self_topup(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_ops_reject_self_topup(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_ops_list_self_topup_reviews(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.psm_is_topup_reviewer(uuid) TO authenticated;