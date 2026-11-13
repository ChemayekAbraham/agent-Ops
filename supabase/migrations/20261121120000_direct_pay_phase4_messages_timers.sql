-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Self-support option 2 (the partner pays the landlord directly). Phase 4: messages and timers.
-- Needs 20261121090000 .. 20261121110000.
--
-- Messages reuse the self-support notice queue: _ssd_notice queues an SMS row (sent within a minute by the existing
-- every-minute job notify-funder-release-sms) or puts an email on the transactional email queue, and a unique index
-- means a message can only ever be queued once. Option 2 adds its own events, the 'direct_payment' reference
-- type and the 'tenant' audience to that queue.
--
-- Nothing in phases 2 and 3 calls this: one trigger on funder_offplatform_rent_payments sends the message for
-- each change of state, in the same transaction (a rolled-back approval sends nothing):
--   new hold -> hold started; held -> pending (proof received); receipt attached at approval -> approved (partner,
--   agent with the WLR receipt, tenant, proxy agent); rejected; held -> expired by time -> hold ended. A partner who
--   releases their own hold gets no message.
-- The agent also gets the existing branded "landlord paid" receipt email (agent-landlord-paid-receipt), posted to
-- send-transactional-email the way funder_release_sms_dispatch calls edge functions.
--
-- Jobs: direct_pay_tick every 15 minutes (ends holds past 48 hours, marks payments waiting over 24 hours for the
-- COO); direct_pay_send_reminders at 08:00 and 18:00 Kampala time. Each is one set-based statement over the rows
-- that are due, never a job per hold.
-- Support number in partner messages: +256 748 747134.
-- REQUIRES THE OWNER'S YES before it is applied to production.

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regprocedure('public.direct_pay_approve(uuid, text, text, text)') IS NULL THEN
    RAISE EXCEPTION 'direct pay phase 4: phase 3 (20261121110000) is not applied';
  END IF;
  IF to_regclass('public.protected_functions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.protected_functions
                  WHERE func_name IN ('_direct_pay_notify', '_direct_pay_agent_receipt_email', 'trg_direct_pay_messages',
                                      'direct_pay_tick', 'direct_pay_send_reminders')) THEN
    RAISE EXCEPTION 'direct pay phase 4: a function this file creates is protected (locked)';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------- 1. the notice queue takes option 2's events
ALTER TABLE public.self_support_notices
  DROP CONSTRAINT IF EXISTS self_support_notices_ref_type_check,
  DROP CONSTRAINT IF EXISTS self_support_notices_audience_check,
  DROP CONSTRAINT IF EXISTS self_support_notices_event_check;
ALTER TABLE public.self_support_notices
  ADD CONSTRAINT self_support_notices_ref_type_check
    CHECK (ref_type IN ('landlord_payment', 'house_portfolio', 'direct_payment')),
  ADD CONSTRAINT self_support_notices_audience_check
    CHECK (audience IN ('partner', 'agent', 'landlord', 'tenant', 'proxy_agent')),
  ADD CONSTRAINT self_support_notices_event_check
    CHECK (event IN ('queued', 'paid', 'refunded', 'house_active',
                     'dp_hold_started', 'dp_reminder_1', 'dp_reminder_2', 'dp_reminder_3', 'dp_reminder_4',
                     'dp_proof_received', 'dp_approved', 'dp_rejected', 'dp_hold_ended'));

ALTER TABLE public.funder_offplatform_rent_payments ADD COLUMN IF NOT EXISTS agent_email_requested_at timestamptz;

-- ---------------------------------------------------------------- 2. the words (one place)
CREATE OR REPLACE FUNCTION public._direct_pay_notify(p_payment_id uuid, p_event text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  c_support constant text := '+256 748 747134';
  p public.funder_offplatform_rent_payments%ROWTYPE;
  v_partner record; v_tenant record; v_agent record; v_proxy record;
  v_landlord text; v_tname text; v_amt text; v_until text; v_until_short text; v_msg text; v_subject text;
  v_receipt record; v_earned numeric;
BEGIN
  SELECT * INTO p FROM public.funder_offplatform_rent_payments WHERE id = p_payment_id AND flow = 'direct_pay';
  IF NOT FOUND THEN RETURN; END IF;

  SELECT pr.id, split_part(COALESCE(NULLIF(btrim(pr.full_name), ''), 'Partner'), ' ', 1) AS first, NULLIF(btrim(pr.phone), '') AS phone,
         public.resolve_owned_notification_email(pr.id) AS email
    INTO v_partner FROM public.profiles pr WHERE pr.id = p.funder_id;
  SELECT tp.id, split_part(COALESCE(NULLIF(btrim(tp.full_name), ''), 'your tenant'), ' ', 1) AS first, NULLIF(btrim(tp.phone), '') AS phone,
         public.resolve_owned_notification_email(tp.id) AS email
    INTO v_tenant FROM public.rent_requests rr JOIN public.profiles tp ON tp.id = rr.tenant_id WHERE rr.id = p.rent_request_id;
  SELECT ap.id, split_part(COALESCE(NULLIF(btrim(ap.full_name), ''), 'your agent'), ' ', 1) AS first, NULLIF(btrim(ap.phone), '') AS phone,
         public.resolve_owned_notification_email(ap.id) AS email
    INTO v_agent FROM public.profiles ap WHERE ap.id = p.agent_id;
  v_landlord := COALESCE((SELECT NULLIF(btrim(name), '') FROM public.landlords WHERE id = p.landlord_id), 'the landlord');
  v_tname := COALESCE(v_tenant.first, 'your tenant');
  v_amt := 'UGX ' || to_char(p.amount, 'FM999,999,999,999');
  v_until := to_char(p.hold_expires_at AT TIME ZONE 'Africa/Kampala', 'Dy DD Mon, HH24:MI');
  v_until_short := to_char(p.hold_expires_at AT TIME ZONE 'Africa/Kampala', 'Dy HH24:MI');

  IF p_event IN ('dp_hold_started', 'dp_reminder_1', 'dp_reminder_2', 'dp_reminder_3', 'dp_reminder_4',
                 'dp_proof_received', 'dp_approved', 'dp_rejected', 'dp_hold_ended') THEN
    v_msg := CASE p_event
      WHEN 'dp_hold_started' THEN 'WELILE: ' || v_tname || '''s Rent Plan is held for you until ' || v_until || '. Send '
        || v_amt || ' to landlord ' || v_landlord || ' on ' || p.landlord_phone || ', then upload the SMS in the app.'
      WHEN 'dp_proof_received' THEN 'WELILE: We got your proof for ' || v_tname || '''s Rent Plan. Our team will call '
        || v_landlord || ' to confirm. We''ll tell you when it''s done.'
      WHEN 'dp_approved' THEN 'WELILE: ' || v_landlord || ' confirmed ' || v_amt || ' for ' || v_tname
        || '''s Rent Plan. Your portfolio is active and your Rent Profit Share starts today.'
      WHEN 'dp_rejected' THEN 'WELILE: ' || v_landlord || ' did not confirm receiving ' || v_amt || ' for ' || v_tname
        || '''s Rent Plan, so it was not approved. Welile never held this money and can''t refund it. Call ' || c_support
        || ' and we''ll help you follow up with the landlord.'
      WHEN 'dp_hold_ended' THEN 'WELILE: The hold on ' || v_tname || '''s Rent Plan has ended and it is open to other partners. '
        || 'If you already paid, call ' || c_support || ' today.'
      ELSE   -- reminders; the last one before the hold ends says so
        CASE WHEN p.hold_expires_at <= now() + interval '13 hours'
             THEN 'WELILE: Last reminder: upload your SMS for ' || v_tname || '''s Rent Plan before ' || v_until_short
                  || ', or the plan opens to other partners.'
             ELSE 'WELILE: Reminder: ' || v_tname || '''s Rent Plan is held for you until ' || v_until_short || '. Send '
                  || v_amt || ' to ' || v_landlord || ' on ' || p.landlord_phone || ' and upload the SMS.' END
    END;
    v_subject := CASE p_event
      WHEN 'dp_hold_started' THEN 'Rent Plan held for you: pay the landlord directly'
      WHEN 'dp_proof_received' THEN 'We got your proof of payment'
      WHEN 'dp_approved' THEN 'The landlord confirmed: your portfolio is active'
      WHEN 'dp_rejected' THEN 'The landlord did not confirm your payment'
      WHEN 'dp_hold_ended' THEN 'Your Rent Plan hold has ended'
      ELSE 'Reminder: your Rent Plan hold' END;
    PERFORM public._ssd_notice('direct_payment', p.id, p_event, 'partner', p.funder_id, 'sms', v_partner.phone, v_msg);
    PERFORM public._ssd_notice('direct_payment', p.id, p_event, 'partner', p.funder_id, 'email', v_partner.email,
                               replace(v_msg, 'WELILE: ', ''), v_subject);
  END IF;

  IF p_event = 'dp_approved' THEN
    SELECT receipt_number, receipt_code INTO v_receipt FROM public.landlord_payout_receipts WHERE id = p.receipt_id;
    SELECT COALESCE(sum(amount), 0) INTO v_earned FROM public.general_ledger
     WHERE ledger_scope = 'wallet' AND direction = 'cash_in'
       AND idempotency_key IN ('direct-pay-commission-' || p.id::text, 'agent-posted-rent-bonus-' || p.rent_request_id::text);

    IF v_agent.id IS NOT NULL THEN
      v_msg := 'WELILE: Partner ' || v_partner.first || ' paid landlord ' || v_landlord || ' ' || v_amt || ' for ' || v_tname
        || '''s rent.' || CASE WHEN v_receipt.receipt_code IS NOT NULL
                               THEN ' Receipt ' || v_receipt.receipt_number || ': https://welileapp.com/r/' || v_receipt.receipt_code || '.'
                               ELSE '' END
        || CASE WHEN v_earned > 0 THEN ' You earned UGX ' || to_char(v_earned, 'FM999,999,999') || '.' ELSE '' END
        || ' Upload ' || v_landlord || '''s signed receipt in the app. Do NOT pay ' || v_landlord || ' for this Rent Plan.';
      PERFORM public._ssd_notice('direct_payment', p.id, p_event, 'agent', v_agent.id, 'sms', v_agent.phone, v_msg);
      -- Its own block: an email failure (pg_net, vault) must not take the other approval messages with it.
      BEGIN
        PERFORM public._direct_pay_agent_receipt_email(p.id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'direct pay agent receipt email % failed: %', p.id, SQLERRM;
      END;
    END IF;

    IF v_tenant.id IS NOT NULL THEN
      v_msg := 'WELILE: Your rent of ' || v_amt || ' has been paid to ' || v_landlord || '. Your Rent Plan has started. '
        || COALESCE(v_agent.first, 'Your agent') || ' will share your repayment schedule.';
      PERFORM public._ssd_notice('direct_payment', p.id, p_event, 'tenant', v_tenant.id, 'sms', v_tenant.phone, v_msg);
      PERFORM public._ssd_notice('direct_payment', p.id, p_event, 'tenant', v_tenant.id, 'email', v_tenant.email,
                                 replace(v_msg, 'WELILE: ', ''), 'Your rent has been paid');
    END IF;

    IF p.cover_fee_status = 'charged' AND p.proxy_agent_id IS NOT NULL THEN
      SELECT pr.id, NULLIF(btrim(pr.phone), '') AS phone, public.resolve_owned_notification_email(pr.id) AS email
        INTO v_proxy FROM public.profiles pr WHERE pr.id = p.proxy_agent_id;
      v_msg := 'WELILE: You earned UGX ' || to_char(p.cover_fee_amount, 'FM999,999,999') || ' Cover fee on '
        || v_partner.first || '''s Rent Plan support.';
      PERFORM public._ssd_notice('direct_payment', p.id, p_event, 'proxy_agent', v_proxy.id, 'sms', v_proxy.phone, v_msg);
      PERFORM public._ssd_notice('direct_payment', p.id, p_event, 'proxy_agent', v_proxy.id, 'email', v_proxy.email,
                                 replace(v_msg, 'WELILE: ', ''), 'You earned a Cover fee');
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- A message must never undo an approval or a hold.
  RAISE WARNING 'direct pay notify % % failed: %', p_payment_id, p_event, SQLERRM;
END $$;
REVOKE ALL ON FUNCTION public._direct_pay_notify(uuid, text) FROM PUBLIC, anon, authenticated;

-- The branded receipt email agents already get when a landlord is paid. Same template and the same fields as
-- agentPaidEmailData in rent-plan-transition-notices; queued with pg_net, so it leaves only if the approval commits.
CREATE OR REPLACE FUNCTION public._direct_pay_agent_receipt_email(p_payment_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  p public.funder_offplatform_rent_payments%ROWTYPE;
  v_key text; v_email text; v_rr public.rent_requests%ROWTYPE; v_receipt record; v_commission numeric;
BEGIN
  SELECT * INTO p FROM public.funder_offplatform_rent_payments WHERE id = p_payment_id;
  IF p.agent_id IS NULL OR p.agent_email_requested_at IS NOT NULL THEN RETURN; END IF;
  v_email := public.resolve_owned_notification_email(p.agent_id);
  IF v_email IS NULL THEN RETURN; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
  IF NULLIF(btrim(v_key), '') IS NULL THEN
    RAISE WARNING 'direct pay agent email skipped: email_queue_service_role_key is not in vault';
    RETURN;
  END IF;
  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p.rent_request_id;
  SELECT receipt_number, receipt_code INTO v_receipt FROM public.landlord_payout_receipts WHERE id = p.receipt_id;
  SELECT amount INTO v_commission FROM public.general_ledger
   WHERE idempotency_key = 'direct-pay-commission-' || p.id::text AND ledger_scope = 'wallet' LIMIT 1;

  PERFORM net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/send-transactional-email',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object(
      'templateName', 'agent-landlord-paid-receipt',
      'recipientEmail', v_email,
      'idempotencyKey', 'direct-pay-ap-email:' || p.id::text,
      'templateData', jsonb_build_object(
        'rent_request_id', p.rent_request_id,
        'agent_name', COALESCE(split_part(NULLIF(btrim((SELECT full_name FROM public.profiles WHERE id = p.agent_id)), ''), ' ', 1), 'there'),
        'landlord_name', COALESCE((SELECT name FROM public.landlords WHERE id = p.landlord_id), 'your landlord'),
        'tenant_name', COALESCE((SELECT full_name FROM public.profiles WHERE id = v_rr.tenant_id), 'your tenant'),
        'amount', p.amount, 'currency', 'UGX',
        'receipt_number', v_receipt.receipt_number, 'receipt_code', v_receipt.receipt_code,
        'receipt_url', 'https://welileapp.com/r/' || v_receipt.receipt_code,
        'paid_on', to_char(COALESCE(p.confirmed_at, now()) AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY, HH24:MI'),
        'repayment_starts_on', to_char(v_rr.repayment_starts_on, 'FMDay DD FMMonth'),
        'instalment', CASE WHEN lower(COALESCE(v_rr.repayment_frequency, 'daily')) = 'weekly'
                           THEN COALESCE(v_rr.daily_repayment, 0) * 7 ELSE COALESCE(v_rr.daily_repayment, 0) END,
        'period_label', CASE WHEN lower(COALESCE(v_rr.repayment_frequency, 'daily')) = 'weekly' THEN 'per week' ELSE 'per day' END,
        'commission', COALESCE(v_commission::text, ''),
        'rent_request_ref', upper(left(p.rent_request_id::text, 8)))));
  UPDATE public.funder_offplatform_rent_payments SET agent_email_requested_at = now() WHERE id = p.id;
END $$;
REVOKE ALL ON FUNCTION public._direct_pay_agent_receipt_email(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 3. one trigger sends what each change needs
CREATE OR REPLACE FUNCTION public.trg_direct_pay_messages() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.flow IS DISTINCT FROM 'direct_pay' THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'held' THEN PERFORM public._direct_pay_notify(NEW.id, 'dp_hold_started'); END IF;
    RETURN NULL;
  END IF;
  IF OLD.status = 'held' AND NEW.status = 'pending' THEN
    PERFORM public._direct_pay_notify(NEW.id, 'dp_proof_received');
  ELSIF OLD.receipt_id IS NULL AND NEW.receipt_id IS NOT NULL AND NEW.status = 'confirmed' THEN
    PERFORM public._direct_pay_notify(NEW.id, 'dp_approved');   -- the last step of an approval
  ELSIF OLD.status <> 'rejected' AND NEW.status = 'rejected' THEN
    PERFORM public._direct_pay_notify(NEW.id, 'dp_rejected');
  ELSIF OLD.status = 'held' AND NEW.status = 'expired' AND NEW.hold_expires_at <= now() THEN
    PERFORM public._direct_pay_notify(NEW.id, 'dp_hold_ended');  -- not when the partner released it early
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.trg_direct_pay_messages() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_direct_pay_messages ON public.funder_offplatform_rent_payments;
CREATE TRIGGER zz_direct_pay_messages AFTER INSERT OR UPDATE ON public.funder_offplatform_rent_payments
  FOR EACH ROW EXECUTE FUNCTION public.trg_direct_pay_messages();

-- ---------------------------------------------------------------- 4. jobs
-- Every 15 minutes: end holds past 48 hours (the trigger sends "hold ended") and mark payments waiting over
-- 24 hours for the COO. Returns what it did, for the job log.
CREATE OR REPLACE FUNCTION public.direct_pay_tick() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_expired int; v_marked int; v_fee_retried int := 0; r record; v_status text;
BEGIN
  -- A Cover fee left awaiting_topup at approval (float short then) is tried again until the float covers it.
  FOR r IN SELECT id FROM public.funder_offplatform_rent_payments
            WHERE flow = 'direct_pay' AND status = 'confirmed' AND cover_fee_status = 'awaiting_topup'
            ORDER BY confirmed_at LIMIT 200 FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      v_status := public._direct_pay_cover_charge(r.id);
      IF v_status IN ('charged', 'kept') THEN
        UPDATE public.funder_offplatform_rent_payments SET cover_fee_status = v_status WHERE id = r.id;
        v_fee_retried := v_fee_retried + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'direct pay cover fee retry % failed: %', r.id, SQLERRM;
    END;
  END LOOP;

  UPDATE public.funder_offplatform_rent_payments
     SET status = 'expired', expired_at = now(),
         cover_fee_status = CASE WHEN cover_fee_status = 'awaiting_confirmation' THEN 'waived' ELSE cover_fee_status END
   WHERE flow = 'direct_pay' AND status = 'held' AND hold_expires_at <= now();
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  WITH marked AS (
    UPDATE public.funder_offplatform_rent_payments
       SET coo_marked_at = now()
     WHERE flow = 'direct_pay' AND status = 'pending' AND coo_marked_at IS NULL AND created_at < now() - interval '24 hours'
    RETURNING id, amount)
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  SELECT NULL, 'direct_pay_waiting_over_24h', 'funder_offplatform_rent_payments', m.id::text, 'direct_pay_waiting_over_24h',
         'Landlord Ops have not decided this direct landlord payment in 24 hours; flagged for the COO',
         jsonb_build_object('amount', m.amount, 'severity', 'warning')
    FROM marked m;
  GET DIAGNOSTICS v_marked = ROW_COUNT;
  RETURN jsonb_build_object('expired', v_expired, 'marked_for_coo', v_marked, 'cover_fees_charged', v_fee_retried);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_tick() FROM PUBLIC, anon, authenticated;

-- 08:00 and 18:00 Kampala. A hold gets at most 4 reminders, never within 2 hours of starting, and stops as soon
-- as the proof is complete (status pending).
CREATE OR REPLACE FUNCTION public.direct_pay_send_reminders() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_sent int;
BEGIN
  WITH due AS (
    UPDATE public.funder_offplatform_rent_payments
       SET reminders_sent = reminders_sent + 1, last_reminder_at = now()
     WHERE flow = 'direct_pay' AND status = 'held' AND hold_expires_at > now()
       AND reminders_sent < 4 AND hold_started_at < now() - interval '2 hours'
       AND (last_reminder_at IS NULL OR last_reminder_at < now() - interval '6 hours')
    RETURNING id, reminders_sent)
  SELECT count(*) INTO v_sent FROM due, LATERAL (SELECT public._direct_pay_notify(due.id, 'dp_reminder_' || due.reminders_sent)) n;
  RETURN jsonb_build_object('reminders', v_sent);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_send_reminders() FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.schedule('direct-pay-tick', '*/15 * * * *', 'SELECT public.direct_pay_tick();');
    -- 05:00 and 15:00 UTC = 08:00 and 18:00 in Kampala (UTC+3, no daylight saving).
    PERFORM cron.schedule('direct-pay-reminders', '0 5,15 * * *', 'SELECT public.direct_pay_send_reminders();');
  END IF;
END
$cron$;
