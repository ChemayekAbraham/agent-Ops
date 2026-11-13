-- ============================================================================
-- Part 1: self-support v2 objects (owner correction 2026-11-12).
-- Rent Plan: partner -> agent landlord float (no Partner Ops) -> agent informed -> agent withdraws ->
-- merchant pays the landlord -> partner told -> portfolio active, Rent Profit Share from that day.
-- 48 hours with the landlord unpaid: recall from the agent and refund the partner.
-- Empty house: active at once.
-- ============================================================================

-- The switch now means "activate on landlord paid" (it was never ON).
UPDATE public.pipeline_switches
   SET key = 'self_support_activate_on_landlord_paid',
       note = 'Partner-funded Rent Plans go to the agent landlord float with no Partner Ops step; the portfolio '
              || 'activates when the merchant pays the landlord (Rent Profit Share from that day); 48h unpaid: '
              || 'recalled from the agent and refunded. Empty houses are active at once.'
 WHERE key = 'self_support_merchant_direct';
INSERT INTO public.pipeline_switches (key, is_on, note)
SELECT 'self_support_activate_on_landlord_paid', false, 'see 20261117140000'
 WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_switches WHERE key = 'self_support_activate_on_landlord_paid');

CREATE OR REPLACE FUNCTION public._ssd_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT public._pipeline_switch_on('self_support_activate_on_landlord_paid') $$;

-- Rent Profit Share starts the day the landlord is paid; empty houses the day they are supported.
CREATE OR REPLACE FUNCTION public._ssd_earning_date() RETURNS date
LANGUAGE sql STABLE SET search_path TO 'public' AS
$$ SELECT (now() AT TIME ZONE 'Africa/Kampala')::date $$;

-- What the screens get back after a Rent Plan support.
CREATE OR REPLACE FUNCTION public._ssd_support_result(p_portfolio_id uuid, p_partner uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'funding_mode', 'float', 'status', 'awaiting_landlord_payment', 'activates_when_landlord_paid', true,
    'awaiting_ops_approval', false, 'landlord_float_released', true,
    'from_withdrawable', 0, 'from_float', (SELECT investment_amount FROM public.investor_portfolios WHERE id = p_portfolio_id),
    'earning_starts', 'the day the landlord is paid',
    'landlord_payments', COALESCE((
       SELECT jsonb_agg(public._ssd_payment_json(s.id) ORDER BY s.created_at)
         FROM public.self_support_landlord_payments s
        WHERE s.commitment_ids && ARRAY(SELECT fp.commitment_id FROM public.funder_pending_portfolios fp
                                         WHERE fp.portfolio_id = p_portfolio_id AND fp.commitment_id IS NOT NULL)), '[]'::jsonb),
    'available_balance', public.funder_float_available(p_partner)) $$;

CREATE OR REPLACE FUNCTION public._ssd_plan_result(p_rent_request_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((
    SELECT jsonb_build_object('activates_when_landlord_paid', true, 'status', 'awaiting_landlord_payment',
                              'landlord_payment', public._ssd_payment_json(s.id),
                              'earning_starts', 'the day the landlord is paid')
      FROM public.self_support_landlord_payments s
     WHERE s.rent_request_id = p_rent_request_id AND s.status = 'queued'), '{}'::jsonb) $$;

-- ---------------------------------------------------------------- messages
-- Release messages (agent, landlord, tenant, partner) are the existing ones sent when the float reaches
-- the agent. This adds only what changed: the partner is told when the landlord is paid, and both the
-- partner and the agent are told about a 48-hour recall.
CREATE OR REPLACE FUNCTION public._ssd_notify(p_payment_id uuid, p_event text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  s public.self_support_landlord_payments%ROWTYPE;
  v_tenant text; v_landlord text; v_agent record; v_partner record; v_msg text; v_amt text;
BEGIN
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT public._ssd_first(tp.full_name) INTO v_tenant
    FROM public.rent_requests rr LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id WHERE rr.id = s.rent_request_id;
  v_tenant := COALESCE(v_tenant, 'your tenant');
  v_landlord := COALESCE(NULLIF(btrim(s.landlord_name), ''), 'the landlord');
  v_amt := 'UGX ' || public._co_support_fmt(s.amount);

  FOR v_partner IN
    SELECT p.id, NULLIF(btrim(p.phone), '') AS phone, NULLIF(btrim(p.email), '') AS email, SUM(l.principal) AS mine
      FROM public.partner_self_funding_lines l JOIN public.profiles p ON p.id = l.partner_id
     WHERE l.id = ANY (s.line_ids)
     GROUP BY p.id, p.phone, p.email
  LOOP
    v_msg := CASE p_event
      WHEN 'paid' THEN 'WELILE: Landlord ' || v_landlord || ' has been paid ' || v_amt || ' for ' || v_tenant
        || '''s Rent Plan. Your portfolio is active and your Rent Profit Share starts today.'
      WHEN 'refunded' THEN 'WELILE: The landlord for ' || v_tenant || '''s Rent Plan was not paid within 48 hours, '
        || 'so we took the money back from the agent. UGX ' || public._co_support_fmt(v_partner.mine)
        || ' is back in your Welile float.'
    END;
    CONTINUE WHEN v_msg IS NULL;
    PERFORM public._ssd_notice('landlord_payment', s.id, p_event, 'partner', v_partner.id, 'sms', v_partner.phone, v_msg);
    PERFORM public._ssd_notice('landlord_payment', s.id, p_event, 'partner', v_partner.id, 'email', v_partner.email,
      replace(v_msg, 'WELILE: ', ''),
      CASE p_event WHEN 'paid' THEN 'The landlord is paid: your portfolio is active'
                   ELSE 'Your rent support is back in your float' END);
  END LOOP;

  IF p_event = 'refunded' THEN
    SELECT p.id, NULLIF(btrim(p.phone), '') AS phone INTO v_agent FROM public.profiles p WHERE p.id = s.agent_id;
    PERFORM public._ssd_notice('landlord_payment', s.id, 'refunded', 'agent', v_agent.id, 'sms', v_agent.phone,
      'WELILE: The ' || v_amt || ' rent for ' || v_tenant || ' has been RECALLED from your landlord float because '
      || 'the landlord was not paid within 48 hours. Do NOT pay the landlord now.');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'self-support notify % % failed: %', p_payment_id, p_event, SQLERRM;
END $$;

-- ---------------------------------------------------------------- release, held until the landlord is paid
-- Called by the core at the end of a self_managed Rent Plan release (switch ON). The core has debited the
-- partner, paid Agent Care, reserved the pool and put the rent on the agent's landlord float as today;
-- this keeps the portfolio from earning until the landlord is paid.
CREATE OR REPLACE FUNCTION public._ssd_hold_until_landlord_paid(p_portfolio_id uuid, p_commitment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_rr uuid;
BEGIN
  PERFORM set_config('welile.portfolio_trusted', 'on', true);
  UPDATE public.investor_portfolios SET status = 'awaiting_landlord_payment'
   WHERE id = p_portfolio_id AND status = 'active';
  PERFORM set_config('welile.portfolio_trusted', '', true);

  PERFORM set_config('app.ss_system_release', 'on', true);
  UPDATE public.partner_self_commitments
     SET status = 'awaiting_landlord', payout_anchor_at = NULL, payout_day = NULL, next_payout_at = NULL,
         term_end_at = NULL, updated_at = now()
   WHERE id = p_commitment_id AND status = 'active';
  PERFORM set_config('app.ss_system_release', '', true);

  -- The release made the lines live (and, for a co-supported plan, the second half's release re-activates
  -- the first half through psm_activate_line_on_disbursement). Nothing on these plans earns until the
  -- landlord is paid: every line held for the landlord goes back to idle, its commitment unanchored.
  FOR v_rr IN SELECT DISTINCT rent_request_id FROM public.partner_self_funding_lines
               WHERE commitment_id = p_commitment_id AND status <> 'cancelled' LOOP
    UPDATE public.partner_self_funding_lines l
       SET status = 'idle', live_at = NULL, term_end_at = NULL, updated_at = now()
      FROM public.partner_self_commitments c
     WHERE l.rent_request_id = v_rr AND l.status = 'active' AND c.id = l.commitment_id AND c.status = 'awaiting_landlord';
    UPDATE public.partner_self_commitments c
       SET payout_anchor_at = NULL, payout_day = NULL, next_payout_at = NULL, term_end_at = NULL, updated_at = now()
     WHERE c.status = 'awaiting_landlord' AND c.payout_anchor_at IS NOT NULL
       AND c.id IN (SELECT l.commitment_id FROM public.partner_self_funding_lines l WHERE l.rent_request_id = v_rr);
    PERFORM public._ssd_track_plan(v_rr);
  END LOOP;
END $$;

-- One tracking row per plan once its float is on the agent (co-support: after the second half).
CREATE OR REPLACE FUNCTION public._ssd_track_plan(p_rent_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_alloc record; v_lines uuid[]; v_commitments uuid[]; v_partners uuid[]; v_id uuid; v_ld record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ssd-plan-' || p_rent_request_id::text));
  IF EXISTS (SELECT 1 FROM public.self_support_landlord_payments
              WHERE rent_request_id = p_rent_request_id AND status IN ('queued', 'paid')) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_self_funding_lines l
               JOIN public.partner_self_commitments c ON c.id = l.commitment_id
              WHERE l.rent_request_id = p_rent_request_id AND l.status <> 'cancelled'
                AND c.status <> 'awaiting_landlord') THEN
    RETURN NULL;   -- the other half is not released yet
  END IF;
  SELECT a.id, a.agent_id, a.landlord_id, a.landlord_name, a.landlord_phone, a.allocated_amount INTO v_alloc
    FROM public.agent_landlord_float_allocations a
   WHERE a.rent_request_id = p_rent_request_id AND a.source = 'partner_self_funding'
     AND a.status IN ('open', 'partially_paid')
   ORDER BY a.created_at DESC LIMIT 1;
  IF v_alloc.id IS NULL THEN RETURN NULL; END IF;

  SELECT array_agg(l.id ORDER BY l.created_at), array_agg(DISTINCT l.commitment_id), array_agg(DISTINCT l.partner_id)
    INTO v_lines, v_commitments, v_partners
    FROM public.partner_self_funding_lines l
   WHERE l.rent_request_id = p_rent_request_id AND l.status = 'idle';
  IF v_lines IS NULL THEN RETURN NULL; END IF;
  SELECT ld.name, COALESCE(NULLIF(btrim(ld.verified_mobile_money_number), ''), ld.phone) AS phone INTO v_ld
    FROM public.landlords ld WHERE ld.id = v_alloc.landlord_id;

  INSERT INTO public.self_support_landlord_payments (
    rent_request_id, agent_id, landlord_id, landlord_name, landlord_phone, amount,
    line_ids, commitment_ids, partner_ids, expires_at)
  VALUES (p_rent_request_id, v_alloc.agent_id, v_alloc.landlord_id,
          COALESCE(NULLIF(btrim(v_alloc.landlord_name), ''), v_ld.name),
          COALESCE(NULLIF(btrim(v_alloc.landlord_phone), ''), v_ld.phone, ''), v_alloc.allocated_amount,
          v_lines, v_commitments, v_partners, now() + interval '48 hours')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------- landlord paid: active, earning today
CREATE OR REPLACE FUNCTION public._ssd_activate(p_payment_id uuid, p_landlord_payout_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  s public.self_support_landlord_payments%ROWTYPE;
  v_now timestamptz := now(); v_day date := public._ssd_earning_date(); v_c record; v_pid uuid;
BEGIN
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'queued' THEN RETURN; END IF;

  UPDATE public.self_support_landlord_payments
     SET status = 'paid', paid_at = v_now, earning_from = v_day, landlord_payout_id = p_landlord_payout_id, updated_at = now()
   WHERE id = s.id;

  UPDATE public.partner_self_funding_lines
     SET status = 'active', live_at = v_now,
         term_end_at = v_now + (GREATEST(1, COALESCE(term_months, 1)) || ' months')::interval, updated_at = now()
   WHERE id = ANY (s.line_ids) AND status = 'idle';

  PERFORM set_config('welile.portfolio_trusted', 'on', true);
  FOR v_c IN SELECT * FROM public.partner_self_commitments WHERE id = ANY (s.commitment_ids) ORDER BY id FOR UPDATE LOOP
    IF v_c.status = 'awaiting_landlord' THEN
      UPDATE public.partner_self_commitments
         SET status = 'active', payout_anchor_at = v_now, payout_day = EXTRACT(DAY FROM v_now)::smallint,
             next_payout_at = v_now + interval '1 month',
             term_end_at = v_now + (GREATEST(1, COALESCE(v_c.term_months, public.psm_contract_term_months())) || ' months')::interval,
             updated_at = now()
       WHERE id = v_c.id;
      FOR v_pid IN SELECT fp.portfolio_id FROM public.funder_pending_portfolios fp
                    WHERE fp.commitment_id = v_c.id AND fp.status = 'approved' LOOP
        UPDATE public.investor_portfolios
           SET status = 'active', next_roi_date = v_day + 30,
               maturity_date = (v_day + (GREATEST(1, COALESCE(v_c.term_months, 12)) || ' months')::interval)::date
         WHERE id = v_pid AND status = 'awaiting_landlord_payment';
      END LOOP;
    END IF;
  END LOOP;
  PERFORM set_config('welile.portfolio_trusted', '', true);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (auth.uid(), 'self_support_landlord_paid', 'self_support_landlord_payments', s.id::text,
          'self_support_landlord_paid', 'Merchant paid the landlord; partner portfolio active, earning from ' || v_day,
          jsonb_build_object('landlord_payout_id', p_landlord_payout_id, 'earning_from', v_day, 'amount', s.amount));
  PERFORM public._ssd_notify(s.id, 'paid');
END $$;

-- The agent's own landlord payout for the plan: paid by the merchant -> activate.
CREATE OR REPLACE FUNCTION public.trg_ssd_landlord_payout_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_payment uuid; v_late uuid;
BEGIN
  IF NEW.rent_request_id IS NULL THEN RETURN NEW; END IF;
  SELECT id INTO v_payment FROM public.self_support_landlord_payments
   WHERE rent_request_id = NEW.rent_request_id AND status = 'queued';
  IF v_payment IS NOT NULL THEN
    PERFORM public._ssd_activate(v_payment, NEW.id);
    RETURN NEW;
  END IF;
  -- paid after a 48-hour recall: money left twice; Financial Ops must see it at once
  SELECT id INTO v_late FROM public.self_support_landlord_payments
   WHERE rent_request_id = NEW.rent_request_id AND status = 'refunded' AND refunded_at > now() - interval '30 days'
   ORDER BY refunded_at DESC LIMIT 1;
  IF v_late IS NOT NULL THEN
    UPDATE public.self_support_landlord_payments SET stuck_flagged_at = COALESCE(stuck_flagged_at, now()), updated_at = now()
     WHERE id = v_late;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (auth.uid(), 'self_support_paid_after_recall', 'self_support_landlord_payments', v_late::text,
            'self_support_paid_after_recall', 'A landlord payout was paid for a Rent Plan already recalled and refunded',
            jsonb_build_object('landlord_payout_id', NEW.id, 'amount', NEW.amount));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_a0_ssd_landlord_payout_status ON public.landlord_payouts;
CREATE TRIGGER trg_a0_ssd_landlord_payout_status
  AFTER UPDATE OF status ON public.landlord_payouts FOR EACH ROW
  WHEN (NEW.status IN ('awaiting_agent_receipt', 'completed') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_ssd_landlord_payout_status();
DROP TRIGGER IF EXISTS zzzz_ssd_landlord_paid_notify ON public.landlord_payouts;

-- ---------------------------------------------------------------- freeze exemption (owner decision)
-- The agent's payout for a partner-funded plan still waiting for its landlord is let through the landlord-payout
-- freeze (landlord_payouts_blocked); the 06:00-22:00 window and every other check stay. Only the agent's own
-- payout row, made by landlord-payout-disburse after the landlord OTP, can carry this.
CREATE OR REPLACE FUNCTION public.trg_ssd_freeze_exempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.landlord_payout_id IS NOT NULL AND NEW.landlord_block_exempt_at IS NULL
     AND COALESCE(NEW.reason, '') LIKE 'Landlord float payout%'
     AND EXISTS (SELECT 1 FROM public.landlord_payouts lp
                   JOIN public.self_support_landlord_payments s ON s.rent_request_id = lp.rent_request_id AND s.status = 'queued'
                  WHERE lp.id = NEW.landlord_payout_id AND lp.agent_id = NEW.user_id) THEN
    NEW.landlord_block_exempt_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS aaa_01_ssd_freeze_exempt ON public.withdrawal_requests;
CREATE TRIGGER aaa_01_ssd_freeze_exempt BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.trg_ssd_freeze_exempt();

-- An agent payout for a partner-funded plan and a 48-hour recall of that plan must not overlap: both take the
-- agent's landlord float row first, so one waits for the other. A payout that arrives after the recall is refused.
-- (The production payout checks read the float without a lock; they are protected, so the lock lives here.)
CREATE OR REPLACE FUNCTION public.trg_ssd_payout_recall_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.rent_request_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.self_support_landlord_payments WHERE rent_request_id = NEW.rent_request_id) THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.self_support_landlord_payments
                  WHERE rent_request_id = NEW.rent_request_id AND status IN ('queued', 'paid'))
     AND NOT EXISTS (SELECT 1 FROM public.agent_landlord_float_allocations
                      WHERE rent_request_id = NEW.rent_request_id AND status IN ('open', 'partially_paid')) THEN
    RAISE EXCEPTION 'RENT_RECALLED: the rent for this tenant was recalled from your landlord float because the landlord was not paid within 48 hours. Do not pay the landlord.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS aa_00_ssd_payout_recall_lock ON public.landlord_payouts;
CREATE TRIGGER aa_00_ssd_payout_recall_lock BEFORE INSERT ON public.landlord_payouts
  FOR EACH ROW EXECUTE FUNCTION public.trg_ssd_payout_recall_lock();

-- ---------------------------------------------------------------- 48-hour recall
-- Same steps as the COO recall (funded_recall, E86), for every half of the plan:
-- cancel the lines (the release trigger takes the float back off the agent and frees the plan), return the
-- money to the pool, reverse fee recognition, close the commitments and portfolios, refund each partner what
-- their wallet paid. Refuses while an agent payout for the plan is in flight or the landlord was partly paid.
CREATE OR REPLACE FUNCTION public._ssd_recall(p_payment_id uuid, p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  s public.self_support_landlord_payments%ROWTYPE; v_float numeric; v_l record; v_refund numeric; v_c uuid;
  v_pid uuid; v_first uuid; v_why text;
BEGIN
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'queued' THEN RETURN false; END IF;
  PERFORM 1 FROM public.agent_landlord_float WHERE agent_id = s.agent_id FOR UPDATE;

  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM public.landlord_payouts lp WHERE lp.rent_request_id = s.rent_request_id
                          AND lp.status IN ('otp_verified', 'pending_merchant_payout', 'pending_finops_disbursement',
                                            'disbursing', 'awaiting_agent_receipt', 'completed'))
             THEN 'an agent landlord payout for this plan is in progress or paid'
           WHEN EXISTS (SELECT 1 FROM public.agent_landlord_float_allocations a WHERE a.rent_request_id = s.rent_request_id
                          AND a.source = 'partner_self_funding' AND a.status <> 'cancelled' AND COALESCE(a.paid_out_amount, 0) > 0)
             THEN 'the landlord was partly paid'
         END INTO v_why;
  IF v_why IS NOT NULL THEN
    IF s.stuck_flagged_at IS NULL THEN
      UPDATE public.self_support_landlord_payments SET stuck_flagged_at = now(), updated_at = now() WHERE id = s.id;
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
      VALUES (auth.uid(), 'self_support_recall_held', 'self_support_landlord_payments', s.id::text,
              'self_support_recall_held', 'Not recalled: ' || v_why, jsonb_build_object('reason', p_reason));
    END IF;
    RETURN false;
  END IF;

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_float FROM public.agent_landlord_float_allocations
   WHERE rent_request_id = s.rent_request_id AND source = 'partner_self_funding' AND status IN ('open', 'return_pending');

  UPDATE public.self_support_landlord_payments
     SET status = 'refunded', refunded_at = now(), refund_reason = left(COALESCE(p_reason, 'not paid'), 300), updated_at = now()
   WHERE id = s.id;

  -- refund what each partner's wallet paid for their line (as funded_recall), before the lines close
  FOR v_l IN SELECT l.id, l.partner_id FROM public.partner_self_funding_lines l WHERE l.id = ANY (s.line_ids) ORDER BY l.id LOOP
    SELECT COALESCE(SUM(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END), 0) INTO v_refund
      FROM public.general_ledger g
     WHERE g.ledger_scope = 'wallet' AND g.user_id = v_l.partner_id
       AND g.source_table = 'partner_self_funding_lines' AND g.source_id = v_l.id;
    IF v_refund > 0 THEN
      PERFORM public.create_ledger_transaction(
        entries := jsonb_build_array(
          jsonb_build_object('user_id', v_l.partner_id, 'amount', v_refund, 'direction', 'cash_in', 'category', 'partner_funding',
            'ledger_scope', 'wallet', 'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
            'source_table', 'partner_self_funding_lines', 'source_id', v_l.id,
            'description', 'Landlord not paid within 48 hours: partner''s money returned to wallet'),
          jsonb_build_object('amount', v_refund, 'direction', 'cash_out', 'category', 'partner_funding', 'ledger_scope', 'platform',
            'source_table', 'partner_self_funding_lines', 'source_id', v_l.id, 'linked_party', v_l.partner_id::text,
            'description', 'Landlord not paid within 48 hours: partner capital returned to wallet')),
        idempotency_key := 'ssd-recall-refund-' || v_l.id::text);
    END IF;
  END LOOP;

  -- one line at a time: the release trigger cancels a co-support half itself
  SELECT l.id INTO v_first FROM public.partner_self_funding_lines l
   WHERE l.id = ANY (s.line_ids) AND l.status <> 'cancelled' ORDER BY l.created_at LIMIT 1;
  IF v_first IS NOT NULL THEN
    UPDATE public.partner_self_funding_lines
       SET status = 'cancelled', end_reason = 'landlord_not_paid_48h', plan_closed_at = now(), updated_at = now()
     WHERE id = v_first;
  END IF;
  UPDATE public.partner_self_funding_lines
     SET status = 'cancelled', end_reason = COALESCE(end_reason, 'landlord_not_paid_48h'), plan_closed_at = COALESCE(plan_closed_at, now()),
         updated_at = now()
   WHERE id = ANY (s.line_ids) AND status <> 'cancelled';
  UPDATE public.partner_self_funding_lines SET end_reason = 'landlord_not_paid_48h'
   WHERE id = ANY (s.line_ids) AND end_reason = 'co_support_pair_cancelled';

  IF v_float > 0 THEN
    PERFORM public.landlord_pool_cancel_return(s.rent_request_id, v_float, 'ssd_48h_recall');
  END IF;
  BEGIN
    PERFORM public.reverse_funding_treasury(s.rent_request_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'self-support recall: fee reversal for % failed: %', s.rent_request_id, SQLERRM;
  END;

  FOREACH v_c IN ARRAY s.commitment_ids LOOP
    PERFORM public._ssd_settle_commitment(v_c);
    FOR v_pid IN SELECT fp.portfolio_id FROM public.funder_pending_portfolios fp WHERE fp.commitment_id = v_c LOOP
      PERFORM public.landlord_pool_rebalance(v_pid, 'ssd_48h_recall');
    END LOOP;
  END LOOP;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (auth.uid(), 'self_support_recalled', 'self_support_landlord_payments', s.id::text,
          'self_support_recalled', left(COALESCE(p_reason, 'not paid'), 300),
          jsonb_build_object('rent_request_id', s.rent_request_id, 'float_recalled', v_float, 'partners', to_jsonb(s.partner_ids)));
  PERFORM public._ssd_notify(s.id, 'refunded');
  RETURN true;
END $$;

-- A commitment with nothing left waiting and nothing live is closed (portfolio too); its replay keys are freed.
CREATE OR REPLACE FUNCTION public._ssd_settle_commitment(p_commitment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_idle int; v_live int;
BEGIN
  SELECT COUNT(*) FILTER (WHERE status = 'idle'), COUNT(*) FILTER (WHERE status IN ('active', 'completed'))
    INTO v_idle, v_live FROM public.partner_self_funding_lines WHERE commitment_id = p_commitment_id;
  IF v_idle > 0 OR v_live > 0 THEN RETURN; END IF;
  UPDATE public.partner_self_commitments SET status = 'cancelled', updated_at = now()
   WHERE id = p_commitment_id AND status IN ('awaiting_landlord', 'active');
  PERFORM public.psm_release_cancelled_idempotency(c.partner_id, c.idempotency_key)
     FROM public.partner_self_commitments c WHERE c.id = p_commitment_id AND c.idempotency_key IS NOT NULL;
  UPDATE public.partner_self_plan_claims k
     SET idempotency_key = k.idempotency_key || '-void-' || left(k.id::text, 8), updated_at = now()
    FROM public.partner_self_commitments c
   WHERE c.id = p_commitment_id AND k.partner_id = c.partner_id
     AND k.idempotency_key = split_part(c.idempotency_key, '-void-', 1)
     AND k.status NOT IN ('held', 'confirmed');
  PERFORM set_config('welile.portfolio_trusted', 'on', true);
  UPDATE public.investor_portfolios ip SET status = 'cancelled'
    FROM public.funder_pending_portfolios fp
   WHERE fp.commitment_id = p_commitment_id AND ip.id = fp.portfolio_id
     AND ip.status IN ('awaiting_landlord_payment', 'active');
  PERFORM set_config('welile.portfolio_trusted', '', true);
END $$;

CREATE OR REPLACE FUNCTION public.ssd_expire_unpaid(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE s record; v_recalled int := 0; v_held int := 0;
BEGIN
  FOR s IN SELECT id FROM public.self_support_landlord_payments
            WHERE status = 'queued' AND expires_at < now() ORDER BY expires_at LIMIT p_limit LOOP
    IF public._ssd_recall(s.id, 'SELF_SUPPORT_48H: landlord not paid within 48 hours') THEN
      v_recalled := v_recalled + 1;
    ELSE
      v_held := v_held + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('recalled', v_recalled, 'held', v_held);
END $$;

-- ---------------------------------------------------------------- houses: active at once, earning today
CREATE OR REPLACE FUNCTION public._ssd_house_instant(p_portfolio_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_partner uuid; v_msg text; v_p record;
BEGIN
  SELECT fp.funder_id INTO v_partner
    FROM public.funder_pending_portfolios fp WHERE fp.portfolio_id = p_portfolio_id ORDER BY fp.created_at DESC LIMIT 1;
  IF v_partner IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;
  PERFORM set_config('app.ss_system_release', 'on', true);
  PERFORM set_config('welile.portfolio_trusted', 'on', true);
  PERFORM public._approve_pending_portfolio_core(p_portfolio_id, v_partner);
  PERFORM set_config('welile.portfolio_trusted', '', true);
  PERFORM set_config('app.ss_system_release', '', true);

  SELECT p.id, NULLIF(btrim(p.phone), '') AS phone, NULLIF(btrim(p.email), '') AS email, ip.investment_amount
    INTO v_p FROM public.profiles p JOIN public.investor_portfolios ip ON ip.id = p_portfolio_id WHERE p.id = v_partner;
  v_msg := 'WELILE: Your support of UGX ' || public._co_support_fmt(v_p.investment_amount)
        || ' for a verified empty house is active. Your Rent Profit Share starts today.';
  PERFORM public._ssd_notice('house_portfolio', p_portfolio_id, 'house_active', 'partner', v_partner, 'sms', v_p.phone, v_msg);
  PERFORM public._ssd_notice('house_portfolio', p_portfolio_id, 'house_active', 'partner', v_partner, 'email', v_p.email,
    replace(v_msg, 'WELILE: ', ''), 'Your house support is active');
END $$;

-- ---------------------------------------------------------------- Financial Ops
CREATE OR REPLACE FUNCTION public._ssd_is_finance_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(auth.role(), '') = 'service_role'
      OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()
                  AND ur.role::text = ANY (ARRAY['super_admin','ceo','coo','cfo','financial_ops']))
      OR EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = auth.uid() AND sp.revoked_at IS NULL
                  AND sp.permitted_dashboard = 'financial-ops');
$$;

-- Settle a held plan: 'refund' recalls it now (refuses while an agent payout is in flight: fail that first);
-- 'paid' activates it when the agent's landlord payout for the plan is paid.
CREATE OR REPLACE FUNCTION public.self_support_staff_resolve(p_payment_id uuid, p_outcome text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); s public.self_support_landlord_payments%ROWTYPE; v_paid uuid; v_ok boolean;
BEGIN
  IF NOT public._ssd_is_finance_staff() THEN
    RAISE EXCEPTION 'only Financial Ops can resolve a self-support landlord payment' USING ERRCODE = '42501';
  END IF;
  IF p_outcome NOT IN ('refund', 'paid') THEN RAISE EXCEPTION 'outcome must be refund or paid'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;
  IF s.status <> 'queued' THEN RETURN jsonb_build_object('ok', true, 'noop', true, 'status', s.status); END IF;

  IF p_outcome = 'refund' THEN
    v_ok := public._ssd_recall(s.id, 'Financial Ops: ' || btrim(p_reason));
    IF NOT v_ok THEN
      RAISE EXCEPTION 'Cannot recall: an agent landlord payout for this Rent Plan is in progress or paid, or the landlord was partly paid. Settle that payout first.';
    END IF;
  ELSE
    SELECT lp.id INTO v_paid FROM public.landlord_payouts lp
     WHERE lp.rent_request_id = s.rent_request_id AND lp.status IN ('awaiting_agent_receipt', 'completed')
     ORDER BY lp.updated_at DESC LIMIT 1;
    IF v_paid IS NULL THEN
      RAISE EXCEPTION 'No paid landlord payout for this Rent Plan yet: the landlord was not paid.';
    END IF;
    PERFORM public._ssd_activate(s.id, v_paid);
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'self_support_staff_resolve', 'self_support_landlord_payments', s.id::text,
          'self_support_staff_resolve', btrim(p_reason), jsonb_build_object('outcome', p_outcome));
  RETURN jsonb_build_object('ok', true, 'outcome', p_outcome,
                            'status', (SELECT status FROM public.self_support_landlord_payments WHERE id = s.id));
END $$;

-- Plans for the Financial Ops screen, one query.
--   'attention' (default): flagged, or past 48 hours and still waiting; 'queued': all waiting; 'all': the latest.
CREATE OR REPLACE FUNCTION public.self_support_staff_landlord_payments(p_filter text DEFAULT 'attention', p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rows jsonb;
BEGIN
  IF NOT public._ssd_is_finance_staff() THEN
    RAISE EXCEPTION 'only Financial Ops can see self-support landlord payments' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_filter, 'attention') NOT IN ('attention', 'queued', 'all') THEN
    RAISE EXCEPTION 'filter must be attention, queued or all';
  END IF;
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object(
      'id', s.id, 'status', s.status, 'rent_request_id', s.rent_request_id, 'amount', s.amount,
      'landlord_name', s.landlord_name, 'landlord_phone', s.landlord_phone,
      'created_at', s.created_at, 'expires_at', s.expires_at, 'paid_at', s.paid_at,
      'refunded_at', s.refunded_at, 'refund_reason', s.refund_reason, 'earning_from', s.earning_from,
      'stuck_flagged_at', s.stuck_flagged_at,
      'overdue', s.status = 'queued' AND s.expires_at < now(),
      'agent_id', s.agent_id, 'agent_name', ap.full_name, 'tenant_name', tp.full_name,
      'float_remaining', al.remaining, 'float_paid_out', al.paid_out,
      'payout_id', lp.id, 'payout_status', lp.status, 'payout_error', lp.last_error,
      'partners', pn.partners,
      'can_refund', s.status = 'queued' AND COALESCE(al.paid_out, 0) = 0
                    AND COALESCE(lp.status, 'failed') IN ('failed', 'escalated'),
      'can_mark_paid', s.status = 'queued' AND lp.status IN ('awaiting_agent_receipt', 'completed')
    ) AS x
    FROM public.self_support_landlord_payments s
    LEFT JOIN public.profiles ap ON ap.id = s.agent_id
    LEFT JOIN public.rent_requests rr ON rr.id = s.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN LATERAL (
      SELECT SUM(a.remaining_amount) AS remaining, SUM(COALESCE(a.paid_out_amount, 0)) AS paid_out
        FROM public.agent_landlord_float_allocations a
       WHERE a.rent_request_id = s.rent_request_id AND a.source = 'partner_self_funding' AND a.status <> 'cancelled'
    ) al ON true
    LEFT JOIN LATERAL (
      SELECT p.id, p.status, p.last_error FROM public.landlord_payouts p
       WHERE p.rent_request_id = s.rent_request_id ORDER BY p.created_at DESC LIMIT 1
    ) lp ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('partner_id', p.id, 'name', p.full_name,
                                          'share', (SELECT SUM(l.principal) FROM public.partner_self_funding_lines l
                                                     WHERE l.id = ANY (s.line_ids) AND l.partner_id = p.id))) AS partners
        FROM public.profiles p WHERE p.id = ANY (s.partner_ids)
    ) pn ON true
    WHERE CASE COALESCE(p_filter, 'attention')
            WHEN 'attention' THEN s.status = 'queued' AND (s.stuck_flagged_at IS NOT NULL OR s.expires_at < now())
            WHEN 'queued' THEN s.status = 'queued'
            ELSE true END
    ORDER BY s.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  ) q;
  RETURN v_rows;
END $$;

-- ---------------------------------------------------------------- merchant-direct leftovers
DROP FUNCTION IF EXISTS public._ssd_queue_commitment(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._ssd_queue_plan(uuid);
DROP FUNCTION IF EXISTS public._ssd_refund(uuid, text);
DROP FUNCTION IF EXISTS public._ssd_activate(uuid);
DROP FUNCTION IF EXISTS public.trg_ssd_landlord_paid_notify();
-- _ssd_debit_ref stays: the core's partner debit uses it (re-support after a recall)
DROP FUNCTION IF EXISTS public._ssd_momo_provider(text, boolean);
DROP FUNCTION IF EXISTS public._ssd_day_start(date);
-- (_ssd_inserting, _ssd_wr_insert_is_direct, _ssd_payout_is_direct are dropped after Part 2 restores
--  the production functions that referenced them)

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._ssd_on()', 'public._ssd_support_result(uuid, uuid)', 'public._ssd_plan_result(uuid)',
    'public._ssd_notify(uuid, text)', 'public._ssd_hold_until_landlord_paid(uuid, uuid)', 'public._ssd_track_plan(uuid)',
    'public._ssd_activate(uuid, uuid)', 'public.trg_ssd_landlord_payout_status()', 'public.trg_ssd_freeze_exempt()',
    'public.trg_ssd_payout_recall_lock()',
    'public._ssd_recall(uuid, text)', 'public._ssd_settle_commitment(uuid)', 'public.ssd_expire_unpaid(integer)',
    'public._ssd_house_instant(uuid)', 'public._ssd_is_finance_staff()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.self_support_staff_landlord_payments(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.self_support_staff_landlord_payments(text, integer) TO authenticated, service_role;
