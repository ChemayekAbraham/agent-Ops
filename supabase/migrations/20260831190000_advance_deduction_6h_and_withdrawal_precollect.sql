-- ============================================================================
-- Agent advance repayment: two changes requested by ops.
--
-- 1. process-agent-advance-deductions moves from once-daily (18:00 EAT) to
--    every 6 hours, so an agent who tops up their wallet later in the day
--    still gets swept the same day instead of waiting until tomorrow.
--    (The edge function itself is patched separately to make the same-day
--    idempotency check retry-aware -- see supabase/functions/
--    process-agent-advance-deductions/index.ts. Rescheduling the cron alone,
--    without that fix, would have been a no-op 3 runs out of 4: the function
--    wrote a ledger row for "today" on its first run and every later run
--    that day saw the row and skipped the advance entirely.)
--
-- 2. submit_withdrawal_request now makes a best-effort attempt to collect a
--    due-but-uncollected advance installment from the SAME wallet balance
--    before computing what's available to withdraw, so an agent can't cash
--    out the exact money today's advance repayment is owed against. Reuses
--    the room/cap math already established in sweep_agent_advance_recovery
--    (20260815104339) so this new path and the cron can never double-charge
--    -- both funnel through zz_guard_agent_advance_double_charge.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Reschedule process-agent-advance-deductions to every 6 hours.
-- Job was registered directly against the live database (not via a tracked
-- migration -- see CLAUDE.md's migrations-vs-prod-drift note), so unschedule
-- defensively by matching on the function URL in cron.job.command rather than
-- guessing the job name.
DO $cron$
DECLARE
  v_jobid bigint;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job
    WHERE command ILIKE '%process-agent-advance-deductions%'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$cron$;

SELECT cron.schedule(
  'process-agent-advance-deductions-6h',
  '0 */6 * * *',
  $$
  SELECT net.http_post(
      url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/process-agent-advance-deductions',
      headers:='{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
      body:='{}'::jsonb
  );
  $$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. collect_due_agent_advance_installment: withdrawal-time best-effort
-- advance collection. Deliberately does NOT touch penalty interest -- that
-- stays exclusively on process-agent-advance-deductions (same convention as
-- sweep_agent_advance_recovery). Skips grace day, prepaid, not-due, and
-- ahead-of-schedule advances exactly like the cron paths; only ever takes
-- room = (installment + arrears) - already collected today, so a cron run
-- earlier the same day and this call can never together over-collect.
CREATE OR REPLACE FUNCTION public.collect_due_agent_advance_installment(p_agent_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_adv record;
  v_avail numeric;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_period_days int;
  v_anchor date;
  v_installment numeric;
  v_expected_to_date numeric;
  v_paid_to_date numeric;
  v_total_payable numeric;
  v_paid_today numeric;
  v_cap numeric;
  v_room numeric;
  v_deduct numeric;
  v_closing numeric;
  v_total_deducted numeric;
  v_fee_ratio numeric;
  v_new_fee numeric;
  v_fee_status text;
  v_new_status text;
  v_new_arrears numeric;
  v_recovered_total numeric := 0;
  v_idem text;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN 0;
  END IF;

  v_avail := COALESCE(public.get_agent_sweepable_withdrawable(p_agent_id), 0);
  IF v_avail <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_adv IN
    SELECT * FROM public.agent_advances
    WHERE agent_id = p_agent_id
      AND status IN ('active','overdue')
      AND COALESCE(deduction_paused, false) = false
      AND outstanding_balance > 0
      AND COALESCE(recovery_source, 'wallet_daily') <> 'roi'
    ORDER BY issued_at ASC
  LOOP
    EXIT WHEN v_avail <= 0;

    -- Day-0 grace: never collect the day an advance is issued.
    IF (v_adv.issued_at AT TIME ZONE 'Africa/Kampala')::date = v_today THEN
      CONTINUE;
    END IF;

    -- Voluntary prepayment already covers today -- leave recording/decrement
    -- of the prepaid marker to the scheduled job so it isn't split across
    -- two code paths.
    IF COALESCE(v_adv.prepaid_installments_remaining, 0) > 0 THEN
      CONTINUE;
    END IF;

    v_period_days := public.advance_period_days(v_adv.repayment_frequency);
    IF v_period_days > 1 THEN
      SELECT max(date) INTO v_anchor
        FROM public.agent_advance_ledger
       WHERE advance_id = v_adv.id AND amount_deducted > 0;
      v_anchor := COALESCE(v_anchor, (v_adv.issued_at AT TIME ZONE 'Africa/Kampala')::date);
      IF (v_today - v_anchor) < v_period_days THEN
        CONTINUE;
      END IF;
    END IF;

    v_total_payable := COALESCE(v_adv.principal,0) + COALESCE(v_adv.access_fee,0);
    v_installment := public.advance_installment_amount(
      v_adv.principal, v_adv.access_fee, v_adv.cycle_days,
      v_adv.repayment_frequency, v_adv.installment_amount
    );
    IF v_installment <= 0 THEN CONTINUE; END IF;

    v_expected_to_date := public.advance_expected_repaid_to_date(
      v_adv.issued_at, v_adv.principal, v_adv.access_fee, v_adv.cycle_days,
      v_adv.repayment_frequency, v_adv.installment_amount
    );
    v_paid_to_date := GREATEST(0, v_total_payable - COALESCE(v_adv.outstanding_balance, 0));
    IF v_paid_to_date >= v_expected_to_date THEN
      CONTINUE; -- already ahead of schedule
    END IF;

    SELECT COALESCE(SUM(amount_deducted), 0) INTO v_paid_today
      FROM public.agent_advance_ledger
     WHERE advance_id = v_adv.id AND date = v_today;

    -- `agent_advances.arrears_balance` may already carry an earlier same-day
    -- collection's provisional adjustment (from an earlier cron run today).
    -- Back that out before using it in the cap, exactly mirroring the
    -- reverse-and-reapply the arrears UPDATE below performs -- otherwise a
    -- withdrawal-time top-up after a partial cron collection would compute a
    -- cap inflated by today's own not-yet-final shortfall.
    v_cap := v_installment + GREATEST(0, CASE WHEN v_paid_today <= 0
      THEN COALESCE(v_adv.arrears_balance, 0)
      ELSE COALESCE(v_adv.arrears_balance, 0) - v_installment + v_paid_today
    END);
    v_room := GREATEST(0, v_cap - v_paid_today);
    IF v_room <= 0 THEN CONTINUE; END IF;

    v_deduct := LEAST(v_avail, v_adv.outstanding_balance, v_room);
    IF v_deduct <= 0 THEN CONTINUE; END IF;

    v_closing := v_adv.outstanding_balance - v_deduct;
    v_new_status := CASE WHEN v_closing <= 0 THEN 'completed'
                         WHEN v_adv.expires_at < now() THEN 'overdue' ELSE 'active' END;
    v_total_deducted := v_total_payable - GREATEST(0, v_closing);
    v_fee_ratio := CASE WHEN v_total_payable > 0 THEN LEAST(1, v_total_deducted / v_total_payable) ELSE 0 END;
    v_new_fee := round(COALESCE(v_adv.access_fee, 0) * v_fee_ratio);
    v_fee_status := CASE WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
                         WHEN v_new_fee > 0 THEN 'partial' ELSE 'unpaid' END;

    -- Arrears: reverse-and-reapply so repeated same-day collections (an
    -- earlier cron run plus this withdrawal-time top-up) never double count.
    -- When v_paid_today = 0 this is the day's first touch and behaves exactly
    -- like the original single-run formula; otherwise it only nets off this
    -- call's own v_deduct against whatever an earlier run already applied.
    v_new_arrears := GREATEST(0, LEAST(
      GREATEST(0, v_closing),
      CASE WHEN v_paid_today <= 0
           THEN COALESCE(v_adv.arrears_balance, 0) + (v_installment - v_deduct)
           ELSE COALESCE(v_adv.arrears_balance, 0) - v_deduct
      END
    ));

    v_idem := 'adv_withdraw_collect_' || v_adv.id::text || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;

    BEGIN
      -- Ordering matters: the day's ledger row is written against the
      -- pre-deduction state zz_guard_agent_advance_double_charge validates
      -- against, BEFORE the money legs and the advance row are updated.
      INSERT INTO public.agent_advance_ledger
        (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
      VALUES
        (v_adv.id, v_today, v_adv.outstanding_balance, 0, v_deduct, GREATEST(0, v_closing),
         CASE WHEN (v_paid_today + v_deduct) >= v_cap OR v_closing <= 0 THEN 'full' ELSE 'partial' END);

      PERFORM public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
            'amount', v_deduct, 'category', 'agent_repayment', 'recipient_type', 'user',
            'source_table', 'agent_advances', 'source_id', v_adv.id,
            'description', 'Advance installment collected before withdrawal', 'currency', 'UGX',
            'metadata', jsonb_build_object('source','withdrawal_time_collect','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
          ),
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', v_deduct, 'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', v_adv.id,
            'description', 'Advance repayment received from agent (withdrawal-time collect)', 'currency', 'UGX',
            'metadata', jsonb_build_object('source','withdrawal_time_collect','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
          )
        ),
        idempotency_key => v_idem
      );

      UPDATE public.agent_advances
      SET outstanding_balance = GREATEST(0, v_closing), status = v_new_status,
          access_fee_collected = v_new_fee, access_fee_status = v_fee_status,
          arrears_balance = v_new_arrears,
          updated_at = now()
      WHERE id = v_adv.id;

      v_avail := v_avail - v_deduct;
      v_recovered_total := v_recovered_total + v_deduct;
    EXCEPTION WHEN OTHERS THEN
      -- Guard rejection (e.g. a concurrent cron run already collected today's
      -- installment) or any other failure: never raise out of here. The
      -- caller (submit_withdrawal_request) must never be blocked by this,
      -- and the scheduled sweep/cron will retry regardless.
      NULL;
    END;
  END LOOP;

  RETURN v_recovered_total;
END;
$function$;

REVOKE ALL ON FUNCTION public.collect_due_agent_advance_installment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collect_due_agent_advance_installment(uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. submit_withdrawal_request: unchanged from 20260826120000 except for one
-- addition -- a best-effort advance collection attempt right before the
-- balance check, so v_available reflects the wallet AFTER today's due
-- installment (if any) has been taken out of it.
CREATE OR REPLACE FUNCTION public.submit_withdrawal_request(
  p_amount numeric,
  p_payout_method text,
  p_mobile_money_number text DEFAULT NULL::text,
  p_mobile_money_name text DEFAULT NULL::text,
  p_mobile_money_provider text DEFAULT NULL::text,
  p_bank_name text DEFAULT NULL::text,
  p_bank_account_number text DEFAULT NULL::text,
  p_bank_account_name text DEFAULT NULL::text,
  p_client_request_id uuid DEFAULT NULL::uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_available      numeric;
  v_method         text  := lower(coalesce(p_payout_method, ''));
  v_provider       text;
  v_new_id         uuid;
  v_client_req_id  uuid := coalesce(p_client_request_id, gen_random_uuid());
  v_existing_id    uuid;
  v_existing_code  text;
  v_payout_code    text;
  v_qr_data        text;
  v_reason         text := nullif(btrim(left(coalesce(p_reason, ''), 200)), '');
  v_is_commission  boolean := lower(coalesce(v_reason, '')) IN (
    'commission payout',
    'cash-out commission',
    'cashout commission',
    'cash-out commission payout',
    'cashout commission payout'
  );
  v_commission_earned    numeric := 0;
  v_commission_withdrawn numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized',
      'message', 'You must be signed in to submit a withdrawal.');
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_amount',
      'message', 'Amount must be a positive whole number of UGX.');
  END IF;

  IF p_amount < 1000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'amount_below_min',
      'message', 'Minimum withdrawal is UGX 1,000.');
  END IF;

  IF p_amount > 50000000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'amount_above_max',
      'message', 'Maximum withdrawal per request is UGX 50,000,000.');
  END IF;

  IF v_method NOT IN ('mobile_money', 'bank_transfer', 'cash') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_method',
      'message', 'Payout method must be mobile_money, bank_transfer, or cash.');
  END IF;

  IF v_method = 'mobile_money' THEN
    v_provider := lower(coalesce(p_mobile_money_provider, ''));
    IF v_provider NOT IN ('mtn', 'airtel') THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_provider',
        'message', 'Mobile money provider must be MTN or Airtel.');
    END IF;
    IF coalesce(btrim(p_mobile_money_number), '') = ''
       OR coalesce(btrim(p_mobile_money_name), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'missing_momo_details',
        'message', 'Mobile money number and account name are required.');
    END IF;
    IF p_mobile_money_number !~ '^\+?[0-9 ]{9,15}$' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_momo_number',
        'message', 'Mobile money number must be 9-15 digits.');
    END IF;
  ELSIF v_method = 'bank_transfer' THEN
    IF coalesce(btrim(p_bank_name), '') = ''
       OR coalesce(btrim(p_bank_account_number), '') = ''
       OR coalesce(btrim(p_bank_account_name), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'missing_bank_details',
        'message', 'Bank name, account number, and account holder name are required.');
    END IF;
  END IF;

  -- Best-effort: collect any due-but-uncollected advance installment from
  -- THIS wallet before computing what's available, so the agent can't cash
  -- out the exact money today's repayment is owed against. A failure here
  -- must never block a legitimate withdrawal -- the scheduled cron/sweep
  -- retries this on its own cadence regardless.
  BEGIN
    PERFORM public.collect_due_agent_advance_installment(v_uid);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF v_is_commission THEN
    v_available := public.commission_withdrawal_available(v_uid);
  ELSE
    v_available := public.get_user_available_balance(v_uid);
  END IF;

  IF v_available IS NULL OR v_available < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'code', 'insufficient_funds',
      'message', format(
        'Insufficient funds. Available: UGX %s, requested: UGX %s.',
        to_char(coalesce(v_available, 0), 'FM999,999,999'),
        to_char(p_amount, 'FM999,999,999')
      ),
      'available', coalesce(v_available, 0)
    );
  END IF;

  SELECT id, payout_code
    INTO v_existing_id, v_existing_code
  FROM public.withdrawal_requests
  WHERE client_request_id = v_client_req_id
    AND user_id = v_uid
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'already_submitted',
      'request_id', v_existing_id,
      'payout_code', v_existing_code,
      'available_after', v_available - p_amount
    );
  END IF;

  IF v_method = 'cash' THEN
    LOOP
      v_payout_code := lpad((floor(random() * 10000))::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.payout_codes
        WHERE code = v_payout_code
          AND status IN ('pending', 'claimed')
      );
    END LOOP;
  END IF;

  INSERT INTO public.withdrawal_requests (
    user_id, amount, status, payout_method,
    mobile_money_number, mobile_money_name, mobile_money_provider,
    bank_name, bank_account_number, bank_account_name,
    client_request_id, initiated_by, payout_code, reason
  ) VALUES (
    v_uid, p_amount, 'pending', v_method,
    CASE WHEN v_method = 'mobile_money' THEN btrim(p_mobile_money_number) END,
    CASE
      WHEN v_method = 'mobile_money' THEN btrim(p_mobile_money_name)
      WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_name)
      ELSE 'Cash Pickup'
    END,
    CASE
      WHEN v_method = 'mobile_money' THEN v_provider
      WHEN v_method = 'bank_transfer' THEN 'bank'
      ELSE 'cash'
    END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_name) END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_number) END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_name) END,
    v_client_req_id, v_uid,
    v_payout_code, v_reason
  )
  RETURNING id INTO v_new_id;

  IF v_method = 'cash' THEN
    v_qr_data := jsonb_build_object(
      'code', v_payout_code,
      'amount', p_amount,
      'userId', v_uid,
      'withdrawalId', v_new_id
    )::text;

    INSERT INTO public.payout_codes (
      withdrawal_request_id, user_id, code, qr_data, amount, status
    ) VALUES (
      v_new_id, v_uid, v_payout_code, v_qr_data, p_amount, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'submitted',
    'request_id', v_new_id,
    'payout_code', v_payout_code,
    'available_after', v_available - p_amount
  );

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'duplicate_pending',
      'message', 'You already have a pending withdrawal with these details. Wait for it to be approved or rejected.');
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden',
      'message', 'Withdrawals from this account must be routed through your assigned agent.');
  WHEN raise_exception THEN
    RETURN jsonb_build_object('success', false, 'code', 'rejected', 'message', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_withdrawal_request(numeric, text, text, text, text, text, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_withdrawal_request(numeric, text, text, text, text, text, text, text, uuid, text) TO authenticated;
