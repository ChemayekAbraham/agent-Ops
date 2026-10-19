-- Bike lease catch-up SMS v5: flush same-day queued SMS at the first daytime run
-- (applied 2026-10-19 via direct SQL; the migration tool's schema_migrations
-- bookkeeping fails with 42P10, same as v4).
--
-- Gap closed: if the 2am run took catch-up money and queued the SMS, but no later
-- run that day collects more catch-up (e.g. the daily cap was already reached),
-- the queued SMS was never sent. Now, at the first daytime run (08:00-20:59
-- Kampala), any SMS queued for TODAY is sent even when that run collects nothing.
-- Rules from v4 still hold: stale queues (day < today) are deleted unsent, one
-- SMS per day, never overnight. Collection amounts, caps, timing and holds unchanged.

CREATE OR REPLACE FUNCTION public.recover_merchandise_from_wallets(p_test_agent uuid DEFAULT NULL::uuid, p_as_of date DEFAULT NULL::date)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean; v_today date; v_plan record; v_bike record; v_is_bike boolean; v_v2 boolean;
  v_daily numeric; v_today_daily numeric; v_fee_ratio numeric; v_day date; v_due numeric; v_start date; v_term_end date;
  v_avail numeric; v_amount numeric; v_closing numeric; v_entries jsonb; v_idem text; v_desc text;
  v_fee_part numeric; v_prin_part numeric; v_streak int; v_arrears numeric; v_outcome text;
  v_results jsonb := '[]'::jsonb; v_touched int := 0; v_total numeric := 0; v_fail int := 0; v_err text;
  v_agent_name text;
  v_taken_today numeric; v_cap_remaining numeric; v_today_part numeric; v_catchup_part numeric;
  v_hour int; v_daytime boolean; v_sms_payload jsonb; v_sms_sent boolean; v_sms_total numeric;
BEGIN
  IF p_as_of IS NOT NULL AND p_test_agent IS NULL THEN RAISE EXCEPTION 'p_as_of is only allowed in test mode'; END IF;
  IF p_test_agent IS NOT NULL AND NOT COALESCE((SELECT is_test FROM public.profiles WHERE id = p_test_agent), false) THEN
    RAISE EXCEPTION 'Test mode requires an agent flagged is_test';
  END IF;
  SELECT enabled INTO v_enabled FROM public.treasury_controls WHERE control_key = 'merchandise_recovery_enabled';
  IF p_test_agent IS NULL AND NOT COALESCE(v_enabled, false) THEN
    RETURN jsonb_build_object('disabled', true, 'reason', 'merchandise_recovery_enabled is off');
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('recover_merchandise_from_wallets')) THEN
    RETURN jsonb_build_object('skipped', 'another run in progress');
  END IF;
  v_today := COALESCE(p_as_of, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_hour := EXTRACT(HOUR FROM now() AT TIME ZONE 'Africa/Kampala')::int;
  -- SMS never goes out overnight: only the 08:00-20:59 Kampala window may text riders.
  v_daytime := v_hour >= 8 AND v_hour <= 20;

  FOR v_plan IN
    SELECT p.*, pr.full_name AS agent_name
    FROM public.merchandise_recovery_plans p
    JOIN public.profiles pr ON pr.id = p.customer_id
    WHERE p.status = 'active' AND p.outstanding_balance > 0
      AND COALESCE(p.is_bike_lease, false) = true      -- bike leases only; merchandise/phones paused
      AND NOT COALESCE(p.recovery_hold, false)          -- plans on hold are never collected
      AND CASE WHEN p_test_agent IS NULL THEN NOT COALESCE(pr.is_test, false) ELSE p.customer_id = p_test_agent END
    ORDER BY p.customer_id, p.created_at ASC
    FOR UPDATE OF p SKIP LOCKED
  LOOP
    IF NOT public.merchandise_plan_recovery_eligible(v_plan.id) THEN
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = 'skipped_ineligible_order' WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'item', v_plan.item_name, 'day', v_today,
        'taken', 0, 'outcome', 'skipped_ineligible_order', 'reason', public.merchandise_plan_ineligible_reason(v_plan.id));
      CONTINUE;
    END IF;
    IF v_plan.starts_on IS NOT NULL AND v_plan.starts_on > v_today THEN CONTINUE; END IF;
    v_is_bike := COALESCE(v_plan.is_bike_lease, false);
    IF NOT v_is_bike THEN CONTINUE; END IF;
    v_v2 := COALESCE(v_plan.pricing_basis, '') = 'spiro_28pct_v2';

    -- Never carry a queued catch-up SMS into the next day: drop anything queued before today.
    IF v_plan.catchup_sms_pending IS NOT NULL
       AND (v_plan.catchup_sms_pending->>'day')::date < v_today THEN
      UPDATE public.merchandise_recovery_plans SET catchup_sms_pending = NULL WHERE id = v_plan.id;
      v_plan.catchup_sms_pending := NULL;
    END IF;

    -- v5: at the first DAYTIME run, send any SMS queued for TODAY even if this run
    -- collects nothing (e.g. the 2am run queued it and the daily cap is already met).
    IF v_daytime
       AND v_plan.catchup_sms_pending IS NOT NULL
       AND v_plan.catchup_sms_pending->>'day' = v_today::text
       AND COALESCE(v_plan.catchup_sms_sent_on, v_today - 1) < v_today THEN
      v_sms_sent := false;
      BEGIN
        PERFORM net.http_post(
          url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-bike-lease-catchup',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='email_queue_service_role_key' LIMIT 1),'')),
          body := v_plan.catchup_sms_pending
        );
        v_sms_sent := true;
      EXCEPTION WHEN OTHERS THEN v_sms_sent := false;
      END;
      IF v_sms_sent THEN
        UPDATE public.merchandise_recovery_plans SET catchup_sms_sent_on = v_today, catchup_sms_pending = NULL WHERE id = v_plan.id;
        v_plan.catchup_sms_sent_on := v_today; v_plan.catchup_sms_pending := NULL;
      END IF;
      -- If the send failed, the queue stays and the next daytime run retries.
    END IF;

    IF v_plan.recovery_started_on IS NULL THEN
      SELECT * INTO v_bike FROM public._merch_bike_day(v_plan.sale_id, v_v2, v_today);
      IF NOT COALESCE(v_bike.active, false) THEN CONTINUE; END IF;
      v_term_end := v_bike.term_end;
      UPDATE public.merchandise_recovery_plans
        SET recovery_started_on = v_today, due_accrued_through = v_today - 1, due_balance = 0,
            term_end_on = v_term_end, miss_alert_sent = false, updated_at = now()
        WHERE id = v_plan.id;
      v_plan.recovery_started_on := v_today; v_plan.due_accrued_through := v_today - 1;
      v_plan.due_balance := 0; v_plan.term_end_on := v_term_end;
    END IF;

    v_due := COALESCE(v_plan.due_balance, 0);
    v_day := COALESCE(v_plan.due_accrued_through, v_today - 1) + 1;
    WHILE v_day <= v_today LOOP
      IF v_day >= v_plan.term_end_on THEN v_due := v_plan.outstanding_balance; EXIT; END IF;
      SELECT b.daily INTO v_daily FROM public._merch_bike_day(v_plan.sale_id, v_v2, v_day) b;
      v_due := v_due + COALESCE(v_daily, 0);
      v_day := v_day + 1;
    END LOOP;
    v_due := LEAST(v_due, v_plan.outstanding_balance);

    v_fee_ratio := 0;
    SELECT b.daily, b.fee_ratio INTO v_today_daily, v_fee_ratio
      FROM public._merch_bike_day(v_plan.sale_id, v_v2, LEAST(v_today, v_plan.term_end_on - 1)) b;
    v_today_daily := COALESCE(v_today_daily, 0);

    UPDATE public.merchandise_recovery_plans SET due_balance = v_due, due_accrued_through = v_today, last_attempt_on = v_today
      WHERE id = v_plan.id;

    -- How much this plan has already paid today (any earlier run the same Kampala day).
    SELECT COALESCE(sum(d.amount), 0) INTO v_taken_today
      FROM public.merchandise_recovery_deductions d
      WHERE d.plan_id = v_plan.id
        AND (d.created_at AT TIME ZONE 'Africa/Kampala')::date = v_today;

    -- Daily cap: today's amount plus at most one extra day's amount of catch-up,
    -- minus whatever earlier runs already took today. A partial collection therefore
    -- never blocks later runs; the cap does.
    v_cap_remaining := GREATEST(0, 2 * v_today_daily - v_taken_today);

    v_avail := COALESCE(public.get_user_available_balance(v_plan.customer_id), 0);
    v_amount := floor(LEAST(v_due, v_cap_remaining, v_avail, v_plan.outstanding_balance));
    v_outcome := NULL;

    IF v_amount > 0 THEN
      -- Idempotency key includes what was already taken today so a second,
      -- legitimate same-day collection is not mistaken for a retry of the first.
      v_idem := 'merch_recover_v4_' || v_plan.id::text || '_' || to_char(v_today, 'YYYYMMDD') || '_' || v_taken_today::text;
      v_desc := 'Bike Lease Payment - ' || COALESCE(v_plan.item_name, 'Bike') || ' (daily instalment)';
      v_fee_part := 0; v_prin_part := v_amount;
      IF v_v2 THEN
        v_fee_part := LEAST(round(v_amount * v_fee_ratio), GREATEST(COALESCE(v_plan.fee_total,0) - COALESCE(v_plan.fee_recovered,0), 0));
        v_prin_part := v_amount - v_fee_part;
      END IF;
      v_entries := jsonb_build_array(jsonb_build_object(
        'user_id', v_plan.customer_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
        'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user',
        'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_recovery_plans',
        'source_id', v_plan.id, 'description', v_desc, 'currency', 'UGX',
        'metadata', jsonb_build_object('source', 'merchandise_daily_recovery', 'rules', 'v4_bike_only', 'plan_id', v_plan.id,
          'sale_id', v_plan.sale_id, 'kampala_day', v_today, 'principal_part', v_prin_part, 'fee_part', v_fee_part)));
      IF v_prin_part > 0 THEN
        v_entries := v_entries || jsonb_build_array(jsonb_build_object(
          'user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_prin_part, 'category', 'bike_recovery_repayment',
          'recipient_type', 'operational_wallet', 'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id,
          'description', 'Bike lease cost recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Bike'),
          'currency', 'UGX',
          'metadata', jsonb_build_object('source', 'merchandise_daily_recovery', 'plan_id', v_plan.id,
            'sale_id', v_plan.sale_id, 'from_customer', v_plan.customer_id, 'item_name', v_plan.item_name, 'part', 'principal')));
      END IF;
      IF v_fee_part > 0 THEN
        v_entries := v_entries || jsonb_build_array(jsonb_build_object(
          'user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_fee_part, 'category', 'access_fee_collected', 'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id,
          'description', 'Bike lease access fee collected: ' || COALESCE(v_plan.item_name, 'Bike'),
          'currency', 'UGX',
          'metadata', jsonb_build_object('source', 'bike_lease_access_fee', 'plan_id', v_plan.id,
            'sale_id', v_plan.sale_id, 'from_customer', v_plan.customer_id, 'item_name', v_plan.item_name, 'part', 'access_fee')));
      END IF;

      BEGIN
        PERFORM public.create_ledger_transaction(entries => v_entries, idempotency_key => v_idem);
        v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);
        v_arrears := GREATEST(0, v_due - v_amount);
        INSERT INTO public.merchandise_recovery_deductions (plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref)
          VALUES (v_plan.id, v_plan.customer_id, v_plan.item_name, v_amount, v_avail, v_closing, gen_random_uuid());
        UPDATE public.merchandise_recovery_plans
          SET outstanding_balance = v_closing, amount_recovered = amount_recovered + v_amount,
              fee_recovered = COALESCE(fee_recovered,0) + v_fee_part,
              principal_recovered = COALESCE(principal_recovered,0) + CASE WHEN v_v2 THEN v_prin_part ELSE 0 END,
              due_balance = v_arrears, last_success_on = v_today, last_attempt_result = 'collected',
              last_bike_recovery_on = v_today,
              last_recovery_at = now(), miss_alert_sent = false,
              status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
              completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END, updated_at = now()
          WHERE id = v_plan.id;
        IF v_plan.sale_id IS NOT NULL THEN
          UPDATE public.merchandise_sales SET amount_paid = COALESCE(amount_paid,0) + v_amount, amount_outstanding = v_closing,
            payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END, updated_at = now()
          WHERE id = v_plan.sale_id;
        END IF;
        INSERT INTO public.notifications (user_id, title, message, type, metadata, link_path)
        VALUES (v_plan.customer_id, 'Bike lease payment collected',
          'UGX ' || to_char(v_amount, 'FM999,999,999,990') || ' was taken from your wallet for ' || COALESCE(v_plan.item_name,'your bike')
          || '. Arrears: UGX ' || to_char(v_arrears, 'FM999,999,999,990')
          || '. Balance left: UGX ' || to_char(v_closing, 'FM999,999,999,990') || '.',
          'merchandise_recovery',
          jsonb_build_object('kind','merchandise_recovery','plan_id',v_plan.id,'amount',v_amount,'arrears',v_arrears,'balance_left',v_closing,'kampala_day',v_today),
          '/merchandise');

        -- Catch-up SMS: only when part of this take covers days missed earlier.
        v_today_part := LEAST(v_amount, GREATEST(v_today_daily - v_taken_today, 0));
        v_catchup_part := v_amount - v_today_part;
        IF v_catchup_part > 0 THEN
          -- Fold any same-day queued SMS (e.g. left by an overnight run) into this one,
          -- so the rider receives ONE message carrying the day's combined totals.
          v_sms_total := v_amount;
          IF v_plan.catchup_sms_pending IS NOT NULL AND v_plan.catchup_sms_pending->>'day' = v_today::text THEN
            v_today_part := v_today_part + COALESCE((v_plan.catchup_sms_pending->>'today_part')::numeric, 0);
            v_catchup_part := v_catchup_part + COALESCE((v_plan.catchup_sms_pending->>'catchup_part')::numeric, 0);
            v_sms_total := v_today_part + v_catchup_part;
          END IF;
          v_sms_payload := jsonb_build_object(
            'agent_id', v_plan.customer_id, 'total', v_sms_total,
            'today_part', v_today_part, 'catchup_part', v_catchup_part,
            'day', v_today, 'source', 'bike_lease_catchup');
          v_sms_sent := false;
          IF v_daytime AND COALESCE(v_plan.catchup_sms_sent_on, v_today - 1) < v_today THEN
            BEGIN
              PERFORM net.http_post(
                url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-bike-lease-catchup',
                headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='email_queue_service_role_key' LIMIT 1),'')),
                body := v_sms_payload
              );
              v_sms_sent := true;
            EXCEPTION WHEN OTHERS THEN v_sms_sent := false;
            END;
          END IF;
          IF v_sms_sent THEN
            UPDATE public.merchandise_recovery_plans SET catchup_sms_sent_on = v_today, catchup_sms_pending = NULL WHERE id = v_plan.id;
            v_plan.catchup_sms_sent_on := v_today; v_plan.catchup_sms_pending := NULL;
          ELSIF COALESCE(v_plan.catchup_sms_sent_on, v_today - 1) < v_today THEN
            -- Overnight run, SMS not sent yet today: queue the combined payload for the next daytime run.
            UPDATE public.merchandise_recovery_plans SET catchup_sms_pending = v_sms_payload WHERE id = v_plan.id;
            v_plan.catchup_sms_pending := v_sms_payload;
          ELSE
            -- Already texted today: one SMS per day, so this extra catch-up is not queued.
            UPDATE public.merchandise_recovery_plans SET catchup_sms_pending = NULL WHERE id = v_plan.id;
            v_plan.catchup_sms_pending := NULL;
          END IF;
        END IF;

        v_touched := v_touched + 1; v_total := v_total + v_amount; v_outcome := 'collected';
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1; v_err := SQLERRM; v_outcome := 'failed';
        UPDATE public.merchandise_recovery_plans SET last_attempt_result = left('failed: ' || SQLERRM, 300) WHERE id = v_plan.id;
      END;
    ELSE
      v_outcome := CASE
        WHEN v_due <= 0 THEN 'nothing_due'
        WHEN v_cap_remaining <= 0 THEN 'already_collected_today'
        ELSE 'wallet_short' END;
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = v_outcome WHERE id = v_plan.id;
    END IF;

    IF v_outcome IN ('wallet_short','failed') THEN
      v_streak := (v_today - 1) - GREATEST(COALESCE(v_plan.last_success_on, v_plan.recovery_started_on - 1), v_plan.recovery_started_on - 1);
      IF v_streak >= 3 AND NOT COALESCE(v_plan.miss_alert_sent, false) THEN
        INSERT INTO public.notifications (user_id, title, message, type, metadata, link_path)
        VALUES (v_plan.customer_id, 'Bike lease payment missed',
          'Nothing has been collected for ' || COALESCE(v_plan.item_name,'your bike') || ' for ' || v_streak
          || ' days. Arrears: UGX ' || to_char(v_due, 'FM999,999,999,990') || '. Please add money to your wallet.',
          'merchandise_recovery', jsonb_build_object('kind','merchandise_recovery_missed','plan_id',v_plan.id,'days',v_streak,'arrears',v_due), '/merchandise');
        INSERT INTO public.notifications (user_id, title, message, type, metadata)
        SELECT DISTINCT ur.user_id, 'Agent bike lease payments missed',
          COALESCE(v_plan.agent_name,'An agent') || ': nothing collected for ' || COALESCE(v_plan.item_name,'bike') || ' for ' || v_streak
          || ' days. Arrears UGX ' || to_char(v_due, 'FM999,999,999,990') || '.',
          'merchandise_recovery', jsonb_build_object('kind','merchandise_recovery_missed_ops','plan_id',v_plan.id,'agent_id',v_plan.customer_id,'days',v_streak,'arrears',v_due)
        FROM public.user_roles ur WHERE ur.role = 'agent_ops' AND COALESCE(ur.enabled, true);
        UPDATE public.merchandise_recovery_plans SET miss_alert_sent = true WHERE id = v_plan.id;
        v_outcome := v_outcome || '+alert';
      END IF;
    END IF;

    v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'item', v_plan.item_name, 'day', v_today,
      'today_daily', v_today_daily, 'due', v_due, 'wallet', v_avail, 'taken_today_before', v_taken_today,
      'taken', CASE WHEN v_outcome LIKE 'collected%' THEN v_amount ELSE 0 END,
      'outcome', v_outcome);
  END LOOP;

  RETURN jsonb_build_object('day', v_today, 'plans_collected', v_touched, 'recovered_total', v_total,
    'failures', v_fail, 'last_error', v_err, 'plans', v_results);
END
$function$;
