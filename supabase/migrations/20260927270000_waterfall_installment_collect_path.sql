-- Agent Advance waterfall, Stage E path 6 of 7:
-- collect_due_agent_advance_installment -- the withdrawal-time collection
-- called from submit_withdrawal_request.
--
-- NOT YET APPLIED.
--
-- Only the create_ledger_transaction call changes. The funding leg is hoisted
-- into v_funding and used by BOTH branches, byte-identical to today: same
-- category, recipient_type, description, currency and metadata, for exactly
-- v_deduct. Everything else -- the day-0 grace, the prepaid skip, the period
-- anchor, v_cap / v_room, the reverse-and-reapply arrears formula, the
-- daybook-first write order and the per-advance exception handler -- is
-- unchanged.
--
-- NOTE ON THE EXCEPTION HANDLER: the per-advance `EXCEPTION WHEN OTHERS` is
-- RETAINED exactly as-is, and so is its rollback behaviour. It is load-bearing
-- twice over: it keeps a guard rejection on one advance from discarding an
-- earlier advance's successful collection in the same call, and it keeps any
-- failure from reaching submit_withdrawal_request. It is NOT narrowed and NOT
-- removed -- narrowing it would let an unanticipated error unwind the loop and
-- throw away work already done, which is a behaviour regression, not a fix.
--
-- What IS added is observability. Until now this was the only repayment path
-- where a failure left no record anywhere: paths 1, 2 and 7 propagate to their
-- caller, and paths 3 and 4 log to system_events, but this one discarded the
-- error silently. ADVANCE_ALLOCATION_OVER_COLLECTION from the waterfall helper
-- would have been swallowed indistinguishably from a routine period cap -- and
-- that error means the ledger-derived components disagree with the operational
-- balance, which is exactly the divergence the waterfall exists to catch.
--
-- The handler now writes a best-effort system_events row, mirroring
-- sweep_agent_advance_recovery (same event_type, so existing queries pick it
-- up). Statements in an exception handler run in the ENCLOSING transaction --
-- the failed subtransaction is already rolled back -- so the log persists
-- whenever the withdrawal call itself commits. The insert is wrapped in its
-- own nested handler so a logging failure can never defeat the isolation above
-- or alter repayment/withdrawal behaviour.
--
-- SEVERITY is evidence-based, not assumed. Across every attributed failure
-- logged by the structurally identical sibling path (sweep_agent_advance_
-- recovery, 54 events, 2026-08-15 to 2026-09-10), 100% were
-- ADVANCE_PERIOD_CAP_EXCEEDED -- a genuine concurrency condition where the
-- cron already collected today. There is NO observed instance of
-- 'Insufficient ledger balance' or LEDGER_BACKING_REQUIRED on this family, so
-- neither is treated as routine; both classify as 'integrity' until evidence
-- says otherwise. Only the period cap is classified 'expected'.
--
-- Production body before this change: 4faf6d4428c5b3620af2ca612bf439b5
--   (137 non-comment body lines, full definition 72e22fda8ac05ce12af2279f11929cb2)

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
  v_alloc jsonb;
  v_funding jsonb;
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

      v_funding := jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
            'amount', v_deduct, 'category', 'agent_repayment', 'recipient_type', 'user',
            'source_table', 'agent_advances', 'source_id', v_adv.id,
            'description', 'Advance installment collected before withdrawal', 'currency', 'UGX',
            'metadata', jsonb_build_object('source','withdrawal_time_collect','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
          ));

      v_alloc := public.agent_advance_allocation_entries(
                   v_adv.id, p_agent_id, v_deduct, now(), false);

      IF v_alloc IS NULL THEN
        PERFORM public.create_ledger_transaction(
          entries => v_funding || jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', v_deduct, 'category', 'agent_advance_repayment', 'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', v_adv.id,
            'description', 'Advance repayment received from agent (withdrawal-time collect)', 'currency', 'UGX',
            'metadata', jsonb_build_object('source','withdrawal_time_collect','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
          )),
          idempotency_key => v_idem
        );
      ELSE
        PERFORM public.create_ledger_transaction(
          entries => v_funding || v_alloc,
          idempotency_key => v_idem
        );
      END IF;

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
      --
      -- The rollback to this savepoint is complete -- daybook row, both money
      -- legs, the advance UPDATE and every AFTER-trigger effect are all undone
      -- together -- so nothing partial survives and there is no state to
      -- repair. Record the attempt so that an accounting-integrity failure is
      -- distinguishable from a routine operational skip.
      --
      -- Nested best-effort handler: logging must never escape, and must never
      -- change repayment or withdrawal behaviour. If the insert fails we fall
      -- back to the original silent skip rather than propagating.
      BEGIN
        INSERT INTO public.system_events
          (event_type, user_id, related_entity_type, related_entity_id, metadata)
        VALUES (
          'repayment_skipped_insufficient_balance', p_agent_id,
          'agent_advances', v_adv.id,
          jsonb_build_object(
            'source',           'collect_due_agent_advance_installment',
            'reason',           'recovery_failed',
            'advance_id',       v_adv.id,
            'agent_id',         p_agent_id,
            'attempted_amount', v_deduct,
            'error',            SQLERRM,
            'sqlstate',         SQLSTATE,
            -- 'expected' is reserved for conditions PROVEN routine by the
            -- observed failure population. Everything else -- allocation
            -- over-collection, unbalanced groups, mapped-balance failures,
            -- category/allowlist and routing configuration errors, stale
            -- opening, over-collection, principal/fee-status violations and
            -- anything unanticipated -- is an integrity signal.
            'severity',         CASE
                                  WHEN SQLERRM LIKE 'ADVANCE_PERIOD_CAP_EXCEEDED%'
                                    THEN 'expected'
                                  ELSE 'integrity'
                                END
          ));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END;
  END LOOP;

  RETURN v_recovered_total;
END;
$function$;
