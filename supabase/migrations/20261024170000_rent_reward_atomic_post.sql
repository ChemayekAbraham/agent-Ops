-- Rent-facilitation reward: post atomically.                                            NOT APPLIED — needs CFO approval.
--
-- Problem (process-supporter-roi, production 2026-10-24): the payment row was inserted ('paid' / 'reinvested') BEFORE
-- the portfolio change and the ledger posting, as separate requests. If the posting then failed (for example a
-- portfolio Return hold, a ledger check, a timeout), the row stayed; there is no unique (rent request, payment number)
-- constraint, the rent request's schedule was not advanced, and the reward was neither posted nor reliably retried. On the
-- reinvest path the portfolio principal was updated (error unchecked) before the ledger posting, so principal could move
-- with no ledger entry. Two overlapping runs could each insert a row and post.
--
-- Fix: post_rent_facilitation_reward does everything for ONE reward in ONE transaction, serialised on the rent request
-- row, under an idempotency key: payment row, portfolio principal (reinvest) or wallet credit, ledger, schedule. Any
-- failure rolls back all of it — nothing is marked paid or reinvested — and the next daily run retries the same payment
-- number. A held or unavailable reinvest target is NOT silently paid to the wallet instead; the reward waits.
-- rent_reward_posting_gaps() is a read-only report of recorded rewards without a matching posting (no automatic fix).
--
-- Rollback: supabase/rollbacks/20261024170000_rent_reward_atomic_post.rollback.sql. The edge function change must be
-- rolled back with it (the old function does not call this RPC).

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.supporter_roi_payments GROUP BY rent_request_id, payment_number HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'supporter_roi_payments has duplicate (rent_request_id, payment_number) rows; resolve before applying';
  END IF;
  IF to_regproc('public.post_rent_facilitation_reward') IS NOT NULL OR to_regproc('public.rent_reward_posting_gaps') IS NOT NULL THEN
    RAISE EXCEPTION 'rent reward functions already exist';
  END IF;
END $pre$;

CREATE UNIQUE INDEX IF NOT EXISTS supporter_roi_payments_rent_request_payment_uniq
  ON public.supporter_roi_payments (rent_request_id, payment_number);

CREATE FUNCTION public.post_rent_facilitation_reward(
  p_rent_request_id uuid,
  p_payment_number integer,
  p_reinvest_portfolio_id uuid DEFAULT NULL,
  p_wallet_description text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  rr record;
  pf record;
  v_now timestamptz := now();
  v_amount numeric;
  v_payment_id uuid;
  v_group uuid;
  v_key text := 'rent-reward:' || p_rent_request_id::text || ':' || p_payment_number::text;
  v_rent_txt text;
  v_new_principal numeric;
BEGIN
  -- One reward at a time per rent request.
  SELECT id, supporter_id, rent_amount, funded_at, status, next_roi_due_date, coalesce(total_roi_paid, 0) total_roi_paid,
         coalesce(roi_payments_count, 0) roi_payments_count
    INTO rr FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RENT_REWARD_NO_REQUEST: rent request % not found', p_rent_request_id USING ERRCODE = '22023'; END IF;

  -- Already done (by this or an earlier run): report, change nothing.
  IF p_payment_number <= rr.roi_payments_count THEN
    RETURN jsonb_build_object('status', 'already_posted', 'payment_number', p_payment_number);
  END IF;
  IF p_payment_number <> rr.roi_payments_count + 1 THEN
    RAISE EXCEPTION 'RENT_REWARD_STALE: expected payment % for rent request %, got %', rr.roi_payments_count + 1, p_rent_request_id, p_payment_number
      USING ERRCODE = '22023';
  END IF;
  -- A row for this payment number with the schedule not advanced: recorded by the old flow, posting unknown.
  -- Never post on top of it automatically; it appears in rent_reward_posting_gaps() for a CFO decision.
  IF EXISTS (SELECT 1 FROM public.supporter_roi_payments s WHERE s.rent_request_id = p_rent_request_id AND s.payment_number = p_payment_number) THEN
    RETURN jsonb_build_object('status', 'recorded_without_schedule', 'payment_number', p_payment_number);
  END IF;

  IF rr.supporter_id IS NULL OR rr.funded_at IS NULL OR rr.status NOT IN ('funded', 'disbursed', 'completed') THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;
  IF (rr.next_roi_due_date IS NOT NULL AND rr.next_roi_due_date > v_now)
     OR (rr.next_roi_due_date IS NULL AND rr.funded_at + interval '30 days' > v_now) THEN
    RETURN jsonb_build_object('status', 'not_due', 'next_due', coalesce(rr.next_roi_due_date, rr.funded_at + interval '30 days'));
  END IF;

  v_amount := round(rr.rent_amount * 0.15);
  IF v_amount <= 0 THEN RAISE EXCEPTION 'RENT_REWARD_AMOUNT: non-positive reward' USING ERRCODE = '22023'; END IF;
  v_rent_txt := to_char(rr.rent_amount, 'FM999,999,999,990');

  IF p_reinvest_portfolio_id IS NOT NULL THEN
    SELECT id, investor_id, status, investment_amount INTO pf FROM public.investor_portfolios WHERE id = p_reinvest_portfolio_id FOR UPDATE;
    IF NOT FOUND OR pf.investor_id IS DISTINCT FROM rr.supporter_id OR pf.status <> 'active' THEN
      RAISE EXCEPTION 'RENT_REWARD_REINVEST_TARGET_UNAVAILABLE: portfolio % is not an active portfolio of the supporter', p_reinvest_portfolio_id
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.supporter_roi_payments (rent_request_id, supporter_id, rent_amount, roi_amount, payment_number, due_date, paid_at, status)
    VALUES (rr.id, rr.supporter_id, rr.rent_amount, v_amount, p_payment_number, v_now, v_now, 'reinvested')
    RETURNING id INTO v_payment_id;
    -- Raises PORTFOLIO_ON_HOLD for a held portfolio; the whole reward then rolls back.
    UPDATE public.investor_portfolios SET investment_amount = investment_amount + v_amount WHERE id = pf.id
    RETURNING investment_amount INTO v_new_principal;
    v_group := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_out', 'amount', v_amount, 'category', 'roi_expense',
        'ledger_scope', 'platform', 'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', format('ROI payout #%s auto-reinvested into portfolio', p_payment_number), 'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_in', 'amount', v_amount, 'category', 'roi_reinvestment',
        'ledger_scope', 'platform', 'source_table', 'investor_portfolios', 'source_id', pf.id, 'linked_party', 'platform',
        'description', format('Auto-reinvested ROI #%s (%s) into portfolio', p_payment_number, to_char(v_amount, 'FM999,999,999,990')),
        'currency', 'UGX', 'transaction_date', v_now)), v_key, false);
  ELSE
    INSERT INTO public.supporter_roi_payments (rent_request_id, supporter_id, rent_amount, roi_amount, payment_number, due_date, paid_at, status)
    VALUES (rr.id, rr.supporter_id, rr.rent_amount, v_amount, p_payment_number, v_now, v_now, 'paid')
    RETURNING id INTO v_payment_id;
    v_group := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_out', 'amount', v_amount, 'category', 'roi_expense',
        'ledger_scope', 'platform', 'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', format('Platform ROI payout #%s to supporter for rent facilitation of UGX %s', p_payment_number, v_rent_txt),
        'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_in', 'amount', v_amount, 'category', 'roi_wallet_credit',
        'ledger_scope', 'wallet', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', coalesce(nullif(btrim(p_wallet_description), ''),
                                format('15%% monthly reward (payment #%s) on rent facilitation of UGX %s', p_payment_number, v_rent_txt)),
        'currency', 'UGX', 'transaction_date', v_now)), v_key, false);
  END IF;

  UPDATE public.rent_requests
     SET next_roi_due_date = v_now + interval '30 days',
         total_roi_paid = rr.total_roi_paid + v_amount,
         roi_payments_count = p_payment_number
   WHERE id = rr.id;

  RETURN jsonb_build_object('status', 'posted', 'mode', CASE WHEN p_reinvest_portfolio_id IS NULL THEN 'wallet' ELSE 'reinvest' END,
    'payment_id', v_payment_id, 'payment_number', p_payment_number, 'amount', v_amount, 'transaction_group_id', v_group,
    'portfolio_id', p_reinvest_portfolio_id, 'previous_principal', CASE WHEN p_reinvest_portfolio_id IS NULL THEN NULL ELSE v_new_principal - v_amount END,
    'new_principal', v_new_principal);
END
$function$;

-- Read-only: recorded rewards per rent request versus Return expense postings for it. Used to find rows the old flow
-- recorded without posting. Reports only; any correction is a separate CFO-approved action.
CREATE FUNCTION public.rent_reward_posting_gaps()
RETURNS TABLE (rent_request_id uuid, supporter_id uuid, recorded_rows bigint, recorded_amount numeric, posted_legs bigint,
               posted_amount numeric, rows_without_posting bigint, last_recorded_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
  -- SECURITY DEFINER changes current_user to the owner, so read the API role the request runs under instead
  -- ('authenticated' / 'anon' for a browser; 'service_role' for edge functions; unset for a direct operator session).
  IF coalesce(current_setting('role', true), 'none') IN ('authenticated', 'anon')
     AND NOT coalesce(public.is_cfo_approver(auth.uid()), false) THEN
    RAISE EXCEPTION 'Only the CFO approver can read the rent reward posting report' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH rec AS (
    SELECT s.rent_request_id rid, s.supporter_id sid, count(*) n, sum(s.roi_amount) a, max(s.created_at) last_at
      FROM public.supporter_roi_payments s WHERE s.status IN ('paid', 'reinvested') GROUP BY 1, 2),
  leg AS (
    SELECT g.source_id rid, count(*) n, sum(g.amount) a FROM public.general_ledger g
     WHERE g.source_table = 'supporter_roi_payments' AND g.category = 'roi_expense' AND g.direction = 'cash_out' GROUP BY 1)
  SELECT rec.rid, rec.sid, rec.n, rec.a, coalesce(leg.n, 0), coalesce(leg.a, 0), rec.n - coalesce(leg.n, 0), rec.last_at
    FROM rec LEFT JOIN leg ON leg.rid = rec.rid
   WHERE rec.n > coalesce(leg.n, 0)
   ORDER BY rec.last_at DESC;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.post_rent_facilitation_reward(uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_rent_facilitation_reward(uuid, integer, uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.rent_reward_posting_gaps() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_reward_posting_gaps() TO authenticated, service_role;
