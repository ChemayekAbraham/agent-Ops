-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com

-- Return cycle correction for a misdated payout key (COO approval, no CFO override).
--
-- Some Returns paid before the cycle guard (20261024140000) were saved under the NEXT cycle's key: the payout was
-- approved after next_roi_date had already moved on (e.g. a contribution-date edit). The guard then reads that
-- next cycle as paid and refuses its real Return. Example: RUTH AMAA, WIP2510123914 - October's UGX 185,750 posted
-- 14 Oct as roi-cycle-...-2026-11-13, so November's UGX 213,612 could not be paid.
--
-- A correction is a normal Return request (Nearing Payout -> COO Rent profit share Return Approvals -> CFO) that
-- carries metadata.correction = 'misdated_cycle_key' and a reason. The database proves the mistake itself: every
-- legacy credit keyed to that month was posted at least 20 days before its key date, the month has no claim, and
-- the request goes to COO approval. Only then does the guard skip those misdated credits. All other blocks (already
-- claimed, not yet due, over one cycle's amount, one open request) still apply.
--
-- return_cycle_correction_eligible() tells the screen which locked cards can be corrected.

BEGIN;

CREATE OR REPLACE FUNCTION public._return_cycle_misdated_only(p_portfolio_id uuid, p_month date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH legacy AS (
    SELECT right(g.idempotency_key, 10)::date - (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date AS lead_days
      FROM public.general_ledger g
     WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id
       AND g.direction = 'cash_in' AND g.category IN ('roi_wallet_credit', 'roi_reinvestment')
       AND g.idempotency_key ~ ('^roi-cycle-' || p_portfolio_id::text || '-[0-9]{4}-[0-9]{2}-[0-9]{2}$')
       AND date_trunc('month', right(g.idempotency_key, 10)::date) = p_month
       AND NOT EXISTS (SELECT 1 FROM public.pending_wallet_operations o
                        WHERE o.reference_id = g.reference_id AND o.status = 'cancelled' AND o.metadata ? 'reversed_at'))
  SELECT EXISTS (SELECT 1 FROM legacy)
     AND NOT EXISTS (SELECT 1 FROM legacy WHERE lead_days < 20)
     AND NOT EXISTS (SELECT 1 FROM public.portfolio_return_cycle_claims c
                      WHERE c.portfolio_id = p_portfolio_id AND c.cycle_month = p_month AND c.status = 'active')
$function$;
REVOKE ALL ON FUNCTION public._return_cycle_misdated_only(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._return_cycle_misdated_only(uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public._claim_return_cycle(p_portfolio_id uuid, p_cycle_date date, p_kind text, p_source text, p_reference text, p_pending_operation_id uuid, p_override_id uuid, p_actor uuid, p_amount numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_early_days    CONSTANT integer := 7;
  c_min_spacing   CONSTANT integer := 20;
  c_reliable_from CONSTANT date := DATE '2026-08-01';
  v_today   date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_pf      record;
  v_cycle   date;
  v_month   date;
  v_claim   uuid;
  v_ovr     record;
  v_seq     integer := 0;
  v_cap     numeric;
  v_reasons text[] := ARRAY[]::text[];
  v_legacy  constant text := 'roi-cycle-' || p_portfolio_id::text || '-';
  -- Set only by _return_cycle_claim_for_operation_row after it has proved a misdated-key correction.
  v_correction boolean := coalesce(current_setting('welile.return_correction', true), '') = p_portfolio_id::text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('payout', 'split', 'compound') THEN
    RAISE EXCEPTION 'Unknown Return cycle kind' USING ERRCODE = '22023'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'A Return amount is required' USING ERRCODE = '22023'; END IF;

  -- LOCK ORDER (everywhere): the portfolio row first, then the reservation lock. A compound takes them in this order
  -- too; taking them the other way round deadlocks with it (the claim row's foreign key also locks this row).
  SELECT id, portfolio_code, next_roi_date, investment_amount, roi_percentage INTO v_pf
    FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'P0002'; END IF;

  v_cycle := coalesce(p_cycle_date, v_pf.next_roi_date, v_today);
  v_month := date_trunc('month', v_cycle)::date;
  v_cap := round(coalesce(v_pf.investment_amount, 0) * coalesce(v_pf.roi_percentage, 0) / 100);

  -- Serialise every Return reservation for this portfolio; the unique index is the second lock.
  PERFORM pg_advisory_xact_lock(hashtext('return-cycle'), hashtext(p_portfolio_id::text));

  -- A retry of the same request (same queued payout, or same reference) gets its own claim back.
  IF p_pending_operation_id IS NOT NULL THEN
    SELECT id INTO v_claim FROM public.portfolio_return_cycle_claims
     WHERE pending_operation_id = p_pending_operation_id AND status = 'active' AND portfolio_id = p_portfolio_id;
    IF FOUND THEN RETURN v_claim; END IF;
  END IF;
  IF p_reference IS NOT NULL AND p_pending_operation_id IS NULL THEN
    SELECT id INTO v_claim FROM public.portfolio_return_cycle_claims
     WHERE portfolio_id = p_portfolio_id AND status = 'active' AND reference = p_reference
       AND kind = p_kind AND cycle_month = v_month;
    IF FOUND THEN RETURN v_claim; END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.portfolio_return_cycle_claims
              WHERE portfolio_id = p_portfolio_id AND cycle_month = v_month AND status = 'active') THEN
    v_reasons := array_append(v_reasons, 'already_claimed');
  END IF;

  -- Credits under the previous key scheme count as paid for their month unless the payout was reversed.
  IF EXISTS (SELECT 1 FROM public.general_ledger g
              WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id
                AND g.direction = 'cash_in' AND g.category IN ('roi_wallet_credit', 'roi_reinvestment')
                AND g.idempotency_key ~ ('^' || v_legacy || '[0-9]{4}-[0-9]{2}-[0-9]{2}$')
                AND date_trunc('month', right(g.idempotency_key, 10)::date) = v_month
                AND NOT (v_correction AND right(g.idempotency_key, 10)::date
                         - (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date >= c_min_spacing)
                AND NOT EXISTS (SELECT 1 FROM public.pending_wallet_operations o
                                 WHERE o.reference_id = g.reference_id AND o.status = 'cancelled'
                                   AND o.metadata ? 'reversed_at')) THEN
    v_reasons := array_append(v_reasons, 'already_paid');
  END IF;

  -- Returns posted before this guard WITHOUT any cycle key (compounds, split parts, null-key credits) cannot be tied
  -- to a cycle exactly. Payments are made up to about a month late, so one posted in month M or M+1 blocks month M
  -- (errs toward refusing; resolved by an override). Historical records are only read.
  IF EXISTS (SELECT 1 FROM public.general_ledger g
              WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id AND g.direction = 'cash_in'
                AND ((g.category = 'roi_wallet_credit' AND coalesce(g.ledger_scope, 'wallet') = 'wallet')
                     OR (g.category = 'roi_reinvestment' AND coalesce(g.linked_party, '') <> 'platform'))
                AND (g.idempotency_key IS NULL OR g.idempotency_key LIKE 'portfolio-roi-ledger:%')
                AND date_trunc('month', (g.transaction_date AT TIME ZONE 'Africa/Kampala'))::date
                    IN (v_month, (v_month + interval '1 month')::date)) THEN
    v_reasons := array_append(v_reasons, 'unkeyed_return_this_or_next_month');
  END IF;

  IF EXISTS (SELECT 1 FROM public.portfolio_return_cycle_claims
              WHERE portfolio_id = p_portfolio_id AND status = 'active' AND cycle_month <> v_month
                AND abs(cycle_date - v_cycle) < c_min_spacing)
     OR EXISTS (SELECT 1 FROM public.general_ledger g
                 WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id
                   AND g.direction = 'cash_in' AND g.category IN ('roi_wallet_credit', 'roi_reinvestment')
                   AND g.idempotency_key ~ ('^' || v_legacy || '[0-9]{4}-[0-9]{2}-[0-9]{2}$')
                   AND date_trunc('month', right(g.idempotency_key, 10)::date) <> v_month
                   AND abs(right(g.idempotency_key, 10)::date - v_cycle) < c_min_spacing
                   AND NOT EXISTS (SELECT 1 FROM public.pending_wallet_operations o
                                    WHERE o.reference_id = g.reference_id AND o.status = 'cancelled'
                                      AND o.metadata ? 'reversed_at')) THEN
    v_reasons := array_append(v_reasons, 'too_close_to_another_cycle');
  END IF;

  IF v_cycle > v_today + c_early_days THEN v_reasons := array_append(v_reasons, 'not_yet_due'); END IF;
  IF v_month < c_reliable_from THEN v_reasons := array_append(v_reasons, 'before_reliable_history'); END IF;
  IF p_amount > v_cap THEN v_reasons := array_append(v_reasons, 'amount_above_cycle_return'); END IF;

  IF cardinality(v_reasons) > 0 THEN
    IF p_override_id IS NULL THEN
      RAISE EXCEPTION 'Duplicate Return blocked: portfolio % (%): % for the % cycle.',
          coalesce(v_pf.portfolio_code, p_portfolio_id::text), array_to_string(v_reasons, ', '),
          CASE WHEN 'already_claimed' = ANY (v_reasons) OR 'already_paid' = ANY (v_reasons)
               THEN 'a Return already exists' ELSE 'this Return cannot be paid without an override' END,
          to_char(v_month, 'FMMonth YYYY')
        -- 23505 = the cycle already has a Return; 23514 = refused for another reason.
        USING ERRCODE = CASE WHEN 'already_claimed' = ANY (v_reasons) OR 'already_paid' = ANY (v_reasons)
                             THEN '23505' ELSE '23514' END,
              DETAIL = array_to_string(v_reasons, ','),
              HINT = 'An exceptional extra Return needs a CFO-authorised override for this portfolio and month.';
    END IF;

    SELECT * INTO v_ovr FROM public.portfolio_return_cycle_overrides WHERE id = p_override_id FOR UPDATE;
    IF NOT FOUND OR v_ovr.portfolio_id <> p_portfolio_id OR v_ovr.cycle_month <> v_month THEN
      RAISE EXCEPTION 'Override does not match this portfolio and Return cycle' USING ERRCODE = '42501'; END IF;
    IF v_ovr.consumed_at IS NOT NULL OR v_ovr.revoked_at IS NOT NULL OR v_ovr.expires_at <= now() THEN
      RAISE EXCEPTION 'Override is used, revoked or expired' USING ERRCODE = '42501'; END IF;
    IF NOT public.is_cfo_approver(v_ovr.authorised_by) THEN
      RAISE EXCEPTION 'Override was not authorised by a current CFO approver' USING ERRCODE = '42501'; END IF;
    -- Only a real signed-in session of the named requester can use it (never service-role metadata).
    IF auth.uid() IS NULL OR p_actor IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'An override can only be used from the named requester''s own signed-in session' USING ERRCODE = '42501'; END IF;
    IF v_ovr.authorised_by = p_actor THEN
      RAISE EXCEPTION 'The person who authorised the override cannot also request the Return' USING ERRCODE = '42501'; END IF;
    IF v_ovr.requester_id <> p_actor OR NOT public._return_cycle_can_request(p_actor) THEN
      RAISE EXCEPTION 'This override was authorised for another requester' USING ERRCODE = '42501'; END IF;
    IF p_amount > v_ovr.max_amount THEN
      RAISE EXCEPTION 'Amount is above the override''s authorised maximum' USING ERRCODE = '42501'; END IF;

    SELECT coalesce(max(claim_seq), -1) + 1 INTO v_seq FROM public.portfolio_return_cycle_claims
     WHERE portfolio_id = p_portfolio_id AND cycle_month = v_month AND status = 'active';
    v_cap := v_ovr.max_amount;
  ELSIF p_override_id IS NOT NULL THEN
    RAISE EXCEPTION 'No override is needed: this Return cycle is unpaid. The override was not used.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.portfolio_return_cycle_claims
    (portfolio_id, cycle_month, cycle_date, claim_seq, kind, cycle_return_cap, source, reference, pending_operation_id,
     override_id, claimed_by)
  VALUES (p_portfolio_id, v_month, v_cycle, v_seq, p_kind, v_cap, p_source, p_reference, p_pending_operation_id,
          p_override_id, p_actor)
  RETURNING id INTO v_claim;

  IF p_override_id IS NOT NULL THEN
    UPDATE public.portfolio_return_cycle_overrides SET consumed_at = now(), consumed_claim_id = v_claim WHERE id = p_override_id;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata, reason)
    VALUES (p_actor, 'return_cycle_override_used', 'portfolio_return_cycle_claims', v_claim::text,
            jsonb_build_object('portfolio_id', p_portfolio_id, 'cycle_month', v_month, 'override_id', p_override_id,
                               'authorised_by', v_ovr.authorised_by, 'blocked_reasons', v_reasons, 'source', p_source,
                               'amount', p_amount, 'max_amount', v_ovr.max_amount),
            v_ovr.reason);
  END IF;

  RETURN v_claim;
END
$function$;

CREATE OR REPLACE FUNCTION public._return_cycle_claim_for_operation_row(p_op pending_wallet_operations, p_at_approval boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claim record;
  v_cycle date;
  v_override uuid;
  v_actor uuid;
  v_correcting boolean := false;
  v_claim_id uuid;
BEGIN
  IF coalesce(p_op.operation_type, '') LIKE 'roi_split\_%' THEN
    -- The cash portion of a split joins the claim its split posting made (same reference, same portfolio), and must
    -- fit within that claim's cap together with what was already posted.
    SELECT * INTO v_claim FROM public.portfolio_return_cycle_claims
     WHERE portfolio_id = p_op.source_id AND status = 'active' AND kind = 'split' AND reference = p_op.reference_id
       AND (pending_operation_id IS NULL OR pending_operation_id = p_op.id)
     ORDER BY created_at DESC LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Split cash portion % has no matching split Return for this portfolio', p_op.reference_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF public._return_cycle_posted_total(v_claim.id) + coalesce(p_op.amount, 0) > v_claim.cycle_return_cap THEN
      RAISE EXCEPTION 'Split total would exceed this cycle''s Return (% already posted, cap %)',
        public._return_cycle_posted_total(v_claim.id), v_claim.cycle_return_cap USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.portfolio_return_cycle_claims SET pending_operation_id = p_op.id WHERE id = v_claim.id;
    RETURN v_claim.id;
  END IF;

  IF nullif(btrim(coalesce(p_op.metadata ->> 'correction_key', '')), '') IS NOT NULL
     AND nullif(btrim(coalesce(p_op.metadata ->> 'override_id', '')), '') IS NULL THEN
    RAISE EXCEPTION 'A correction Return needs a CFO-authorised override; correction_key alone is no longer accepted'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_cycle := nullif(btrim(coalesce(p_op.metadata ->> 'cycle_anchor', '')), '')::date;
    v_override := nullif(btrim(coalesce(p_op.metadata ->> 'override_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Invalid cycle_anchor or override_id on the Return request' USING ERRCODE = '22023';
  END;
  IF v_override IS NOT NULL THEN
    -- Overrides: the signed-in session only; never at approval; metadata is never trusted for identity.
    IF p_at_approval OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'An override is used only from the named requester''s own signed-in session when the Return is requested'
        USING ERRCODE = '42501';
    END IF;
    v_actor := auth.uid();
  ELSE
    v_actor := coalesce(auth.uid(), nullif(p_op.metadata ->> 'initiated_by', '')::uuid);
  END IF;

  -- A request queued before this guard that does not name its cycle would otherwise be read against next_roi_date as
  -- it is NOW. If the portfolio received any Return after the request was made, refuse it (the 7-8 July pattern).
  IF p_at_approval AND v_cycle IS NULL AND (
       EXISTS (SELECT 1 FROM public.portfolio_return_cycle_claims c
                WHERE c.portfolio_id = p_op.source_id AND c.status = 'active' AND c.created_at >= p_op.created_at
                  AND c.pending_operation_id IS DISTINCT FROM p_op.id)
    OR EXISTS (SELECT 1 FROM public.general_ledger g
                WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_op.source_id AND g.direction = 'cash_in'
                  AND g.created_at >= p_op.created_at
                  AND (g.category = 'roi_wallet_credit'
                       OR (g.category = 'roi_reinvestment' AND coalesce(g.linked_party, '') <> 'platform')))) THEN
    RAISE EXCEPTION 'Duplicate Return blocked: portfolio % received a Return after this request was made, and the request does not name its cycle. Re-request it for the cycle it is meant to pay.', p_op.source_id
      USING ERRCODE = '23505';
  END IF;

  -- Misdated-key correction: a Return whose cycle is blocked ONLY by an earlier payout that was saved under this
  -- cycle's key although it was posted at least 20 days before the cycle date (it paid the previous cycle). The
  -- database proves that here; the request's metadata only asks. It must go to COO approval and give a reason.
  IF nullif(btrim(coalesce(p_op.metadata ->> 'correction', '')), '') IS NOT NULL AND NOT p_at_approval THEN
    IF p_op.metadata ->> 'correction' <> 'misdated_cycle_key' THEN
      RAISE EXCEPTION 'Unknown Return correction type' USING ERRCODE = '22023'; END IF;
    IF v_override IS NOT NULL THEN
      RAISE EXCEPTION 'A correction cannot also use an override' USING ERRCODE = '22023'; END IF;
    IF auth.uid() IS NULL OR NOT public._return_cycle_can_request(auth.uid()) THEN
      RAISE EXCEPTION 'Only staff who may request Partner Returns can request a correction' USING ERRCODE = '42501'; END IF;
    IF p_op.status IS DISTINCT FROM 'pending_coo_approval' THEN
      RAISE EXCEPTION 'A correction Return must go to COO approval' USING ERRCODE = '23514'; END IF;
    IF v_cycle IS NULL THEN
      RAISE EXCEPTION 'A correction Return must name its cycle (cycle_anchor)' USING ERRCODE = '22023'; END IF;
    IF length(btrim(coalesce(p_op.metadata ->> 'correction_reason', ''))) < 20 THEN
      RAISE EXCEPTION 'Give a correction reason of at least 20 characters' USING ERRCODE = '22023'; END IF;
    IF NOT public._return_cycle_misdated_only(p_op.source_id, date_trunc('month', v_cycle)::date) THEN
      RAISE EXCEPTION 'This cycle is not blocked by a misdated payout, so it cannot be corrected' USING ERRCODE = '23514'; END IF;
    v_correcting := true;
    PERFORM set_config('welile.return_correction', p_op.source_id::text, true);
  END IF;

  v_claim_id := public._claim_return_cycle(p_op.source_id, v_cycle, 'payout', 'pending_wallet_operation',
                                           p_op.reference_id, p_op.id, v_override, v_actor, p_op.amount);
  IF v_correcting THEN
    PERFORM set_config('welile.return_correction', '', true);
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata, reason)
    VALUES (v_actor, 'return_cycle_correction_requested', 'portfolio_return_cycle_claims', v_claim_id::text,
            jsonb_build_object('portfolio_id', p_op.source_id, 'cycle_date', v_cycle, 'amount', p_op.amount,
                               'reference', p_op.reference_id),
            p_op.metadata ->> 'correction_reason');
  END IF;
  RETURN v_claim_id;
END
$function$;

-- Which of these portfolios' current cycle (next_roi_date) is blocked only by a misdated payout key.
CREATE OR REPLACE FUNCTION public.return_cycle_correction_eligible(p_portfolio_ids uuid[])
 RETURNS TABLE (portfolio_id uuid, cycle_date date, cycle_return numeric, misdated_paid_on date, misdated_amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public._return_cycle_can_request((select auth.uid())) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT ip.id, ip.next_roi_date,
         round(coalesce(ip.investment_amount, 0) * coalesce(ip.roi_percentage, 0) / 100),
         (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date, g.amount
    FROM public.investor_portfolios ip
    JOIN LATERAL (
      SELECT gl.transaction_date, gl.amount FROM public.general_ledger gl
       WHERE gl.source_table = 'investor_portfolios' AND gl.source_id = ip.id AND gl.direction = 'cash_in'
         AND gl.category IN ('roi_wallet_credit', 'roi_reinvestment')
         AND gl.idempotency_key ~ ('^roi-cycle-' || ip.id::text || '-[0-9]{4}-[0-9]{2}-[0-9]{2}$')
         AND date_trunc('month', right(gl.idempotency_key, 10)::date) = date_trunc('month', ip.next_roi_date)
       ORDER BY gl.transaction_date DESC LIMIT 1) g ON true
   WHERE ip.id = ANY (p_portfolio_ids) AND ip.status = 'active' AND ip.next_roi_date IS NOT NULL
     AND public._return_cycle_misdated_only(ip.id, date_trunc('month', ip.next_roi_date)::date);
END
$function$;
REVOKE ALL ON FUNCTION public.return_cycle_correction_eligible(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_cycle_correction_eligible(uuid[]) TO authenticated, service_role;

COMMIT;
