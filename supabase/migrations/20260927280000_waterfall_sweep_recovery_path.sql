-- Agent Advance waterfall, Stage E path 4 of 7:
-- sweep_agent_advance_recovery -- the daily 16:50 UTC cron sweep.
--
-- NOT YET APPLIED.
--
-- Only the create_ledger_transaction call changes. The funding leg is hoisted
-- into v_funding and used by BOTH branches, byte-identical to today: same
-- category, recipient_type, description, currency and metadata, for exactly
-- v_deduct. Everything else is untouched -- the prepaid decrement, the
-- not_due / ahead bookkeeping rows, the period anchor, v_room, the
-- daybook-first write order, the per-advance exception handler and its
-- system_events logging, the arrears formula, and the notify-advance-deduction
-- http_post.
--
-- Note: this function already writes its daybook row BEFORE the ledger post
-- and the advance UPDATE, so it does NOT carry the write-order defect that
-- was fixed in recover_agent_arrears_from_credit. Its 54 historical skips are
-- all ADVANCE_PERIOD_CAP_EXCEEDED, none stale-opening.
--
-- Pre-existing observation, deliberately left alone: the notify http_post
-- embeds an anon JWT inline. Not introduced here and not in scope, but worth
-- a separate look.
--
-- Production body before this change: ec6e465d6092aa8f7d3736d0c7885e59
--   (158 non-comment body lines, full definition 03e96adb11e1eb32ba94f73ef6ca415c)

CREATE OR REPLACE FUNCTION public.sweep_agent_advance_recovery()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent record; v_adv record;
  v_avail numeric; v_deduct numeric; v_closing numeric;
  v_total_payable numeric; v_total_deducted numeric;
  v_fee_ratio numeric; v_new_fee numeric; v_fee_status text; v_new_status text;
  v_recovered_total numeric := 0; v_agents_touched int := 0; v_idem text;
  v_installment numeric; v_paid_today numeric; v_room numeric;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_row_exists boolean;
  v_agent_recovered numeric;
  v_period_days int; v_anchor date; v_expected_to_date numeric; v_paid_to_date numeric;
  v_skipped int := 0;
  v_charged boolean;
  v_alloc jsonb;
  v_funding jsonb;
BEGIN
  FOR v_agent IN
    SELECT DISTINCT agent_id FROM public.agent_advances
    WHERE status IN ('active','overdue') AND COALESCE(deduction_paused, false) = false AND outstanding_balance > 0
      AND COALESCE(recovery_source, 'wallet_daily') <> 'roi'
  LOOP
    v_avail := COALESCE(public.get_agent_sweepable_withdrawable(v_agent.agent_id), 0);
    v_agent_recovered := 0;

    FOR v_adv IN
      SELECT * FROM public.agent_advances
      WHERE agent_id = v_agent.agent_id
        AND status IN ('active','overdue') AND COALESCE(deduction_paused, false) = false AND outstanding_balance > 0
        AND COALESCE(recovery_source, 'wallet_daily') <> 'roi'
      ORDER BY issued_at ASC
    LOOP
      SELECT EXISTS (
        SELECT 1 FROM public.agent_advance_ledger
        WHERE advance_id = v_adv.id AND date = v_today
      ) INTO v_row_exists;
      IF v_row_exists THEN CONTINUE; END IF;

      IF COALESCE(v_adv.prepaid_installments_remaining, 0) > 0 THEN
        UPDATE public.agent_advances
        SET prepaid_installments_remaining = prepaid_installments_remaining - 1, updated_at = now()
        WHERE id = v_adv.id;
        INSERT INTO public.agent_advance_ledger
          (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
        VALUES
          (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'prepaid');
        CONTINUE;
      END IF;

      v_period_days := public.advance_period_days(v_adv.repayment_frequency);

      IF v_period_days > 1 THEN
        SELECT max(date) INTO v_anchor
          FROM public.agent_advance_ledger
         WHERE advance_id = v_adv.id AND amount_deducted > 0;
        v_anchor := COALESCE(v_anchor, (v_adv.issued_at AT TIME ZONE 'Africa/Kampala')::date);
        IF (v_today - v_anchor) < v_period_days THEN
          INSERT INTO public.agent_advance_ledger
            (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
          VALUES
            (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'not_due');
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
        INSERT INTO public.agent_advance_ledger
          (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
        VALUES
          (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'ahead');
        CONTINUE;
      END IF;

      EXIT WHEN v_avail <= 0;

      SELECT COALESCE(SUM(amount_deducted), 0) INTO v_paid_today
        FROM public.agent_advance_ledger
       WHERE advance_id = v_adv.id AND date = v_today;

      v_room := GREATEST(0, (v_expected_to_date - v_paid_to_date) - v_paid_today);
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
      v_idem := 'adv_recover_' || v_adv.id::text || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
      v_charged := false;

      -- Per-advance isolation: a guard rejection on one advance must not
      -- discard every other agent's recovery for the day.
      BEGIN
        -- Ordering matters: the day's ledger row is written against the
        -- pre-deduction state the double-charge guard validates against,
        -- BEFORE the money legs and the advance row are updated.
        INSERT INTO public.agent_advance_ledger
          (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
        VALUES
          (v_adv.id, v_today, v_adv.outstanding_balance, 0, v_deduct, GREATEST(0, v_closing),
           CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

        v_funding := jsonb_build_array(
            jsonb_build_object(
              'user_id', v_agent.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
              'amount', v_deduct, 'category', 'agent_repayment', 'recipient_type', 'user',
              'source_table', 'agent_advances', 'source_id', v_adv.id,
              'description', 'Automatic advance recovery from withdrawable balance', 'currency', 'UGX',
              'metadata', jsonb_build_object('source','auto_withdrawable_sweep','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
            ));

        v_alloc := public.agent_advance_allocation_entries(
                     v_adv.id, v_agent.agent_id, v_deduct, now(), false);

        IF v_alloc IS NULL THEN
          PERFORM public.create_ledger_transaction(
            entries => v_funding || jsonb_build_array(
            jsonb_build_object(
              'user_id', v_agent.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
              'amount', v_deduct, 'category', 'agent_advance_repayment', 'recipient_type', 'operational_wallet',
              'source_table', 'agent_advances', 'source_id', v_adv.id,
              'description', 'Advance repayment received from agent (auto-sweep)', 'currency', 'UGX',
              'metadata', jsonb_build_object('source','auto_withdrawable_sweep','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
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
            arrears_balance = GREATEST(0, LEAST(
              GREATEST(0, v_closing),
              COALESCE(v_adv.arrears_balance, 0) + (v_installment - v_deduct)
            )),
            updated_at = now()
        WHERE id = v_adv.id;

        v_charged := true;
      EXCEPTION WHEN OTHERS THEN
        v_skipped := v_skipped + 1;
        BEGIN
          INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
          VALUES ('repayment_skipped_insufficient_balance', v_agent.agent_id, 'agent_advances', v_adv.id,
            jsonb_build_object('source','sweep_agent_advance_recovery','reason','recovery_failed',
                               'attempted_amount', v_deduct, 'error', SQLERRM));
        EXCEPTION WHEN OTHERS THEN NULL; END;
      END;

      IF v_charged THEN
        v_avail := v_avail - v_deduct;
        v_recovered_total := v_recovered_total + v_deduct;
        v_agent_recovered := v_agent_recovered + v_deduct;
      END IF;
    END LOOP;

    IF v_agent_recovered > 0 THEN
      BEGIN
        PERFORM net.http_post(
          url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/notify-advance-deduction',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
          body := jsonb_build_object('agent_id', v_agent.agent_id, 'amount', v_agent_recovered, 'source', 'auto_withdrawable_sweep')
        );
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;

    v_agents_touched := v_agents_touched + 1;
  END LOOP;

  RETURN jsonb_build_object('agents_touched', v_agents_touched, 'recovered_total', v_recovered_total,
                            'skipped', v_skipped, 'ran_at', now());
END;
$function$;
