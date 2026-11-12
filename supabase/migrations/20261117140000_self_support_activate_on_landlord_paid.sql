-- Self-support v2: activate on landlord paid (owner correction 2026-11-12).
--
-- Replaces the merchant-direct Rent Plan path of 20261117120000 (switch never ON):
--   partner supports a Rent Plan -> rent goes to the agent's landlord float with no Partner Ops step ->
--   agent informed (existing release notices) -> agent withdraws as today (landlord OTP, 06:00-22:00,
--   1% + UGX 5,000) -> merchant pays the landlord -> partner told -> portfolio active, Rent Profit Share
--   from that day. 48 hours unpaid: recalled from the agent and the partner refunded (as funded_recall).
--   The agent's payout for such a plan is let through the landlord-payout freeze.
--   Empty houses: active at once.
-- Also: a partner's own direct release no longer trips PORTFOLIO_FIELD_LOCKED (this part is live
-- whatever the switch says: it is what funder_direct_release needs).
-- Built by supabase/tests/self_support_direct/build_v2.cjs.

-- Fail fast instead of queueing behind live traffic.
SET LOCAL lock_timeout = '5s';

-- Refuse unless production holds exactly the v1 (20261117120000) bodies of what this replaces,
-- and never replace a protected function (protected_functions_guard would silently revert it).
DO $guard$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('apply_landlord_payout_to_allocation', 0, '52f242b3b588848ed8046d03b5f48795'),
    ('deduct_agent_float_for_payout', 1, '0e676658fd0b772128b25ce8c281fcb5'),
    ('enforce_landlord_float_performance_gate', 0, '69ec7dab18cb171bf38acf7ea41dec60'),
    ('get_agent_lp_float_available', 1, 'c72aac93531ec497fc63ceb02695b313'),
    ('post_landlord_payout_finops_commission', 0, 'a894e6a688f514d9337d3ff1912a99b2'),
    ('prevent_duplicate_pending_withdrawal', 0, 'a35773076c7ff2a428c0b7f38a5d467f'),
    ('refund_agent_float_for_payout', 2, '483a8bc263b754ab297d7b828c38037b'),
    ('require_withdrawal_pin_proof', 0, '76696d891d96e7a1d1ef4bba06d90400'),
    ('trg_bike_sweep_block_withdrawal_fn', 0, '41d4e1c23e58326ff8802b4453073526'),
    ('_approve_pending_portfolio_core', 2, '06210247b2b0c9c4cdacac5832bd2b5d'),
    ('co_support_accept', 1, '3b52134d70dfa268e2815319805aca7b'),
    ('_co_support_disburse_landlord_float', 1, '4b56231e1632a7787657563acef4bb9d')
  ) AS t(proname, nargs, expected) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.proname AND p.pronargs = r.nargs;
    IF v_md5 IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION 'self_support v2: %(% args) is not the v1 body on production (md5 % <> %). Re-export and rebuild.',
        r.proname, r.nargs, v_md5, r.expected;
    END IF;
    IF to_regclass('public.protected_functions') IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.protected_functions f WHERE f.schema_name = 'public' AND f.func_name = r.proname) THEN
      RAISE EXCEPTION 'self_support v2: % is a protected function; this migration must not change it', r.proname;
    END IF;
  END LOOP;
END $guard$;

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

-- ============================================================================
-- Part 2: production functions
-- ============================================================================

-- apply_landlord_payout_to_allocation (production original)
CREATE OR REPLACE FUNCTION public.apply_landlord_payout_to_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_alloc_id uuid;
BEGIN
  -- Only act once the agent's float is actually committed to this payout.
  IF NEW.status NOT IN ('pending_finops_disbursement','awaiting_agent_receipt','disbursed','completed') THEN
    RETURN NEW;
  END IF;

  -- Idempotency: never apply the same payout twice as it moves through states.
  IF NEW.allocation_applied_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.rent_request_id IS NULL AND NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Prefer the allocation tied to the exact rent request.
  SELECT id INTO v_alloc_id
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = NEW.agent_id
    AND rent_request_id = NEW.rent_request_id
    AND status IN ('open','partially_paid')
  ORDER BY created_at ASC LIMIT 1;

  -- Fallback: match by tenant.
  IF v_alloc_id IS NULL THEN
    SELECT id INTO v_alloc_id
    FROM public.agent_landlord_float_allocations
    WHERE agent_id = NEW.agent_id
      AND tenant_id IS NOT DISTINCT FROM NEW.tenant_id
      AND status IN ('open','partially_paid')
    ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_alloc_id IS NOT NULL THEN
    UPDATE public.agent_landlord_float_allocations
    SET paid_out_amount = paid_out_amount + NEW.amount
    WHERE id = v_alloc_id;

    -- Lock this payout so later status changes can't re-apply it.
    UPDATE public.landlord_payouts
    SET allocation_applied_id = v_alloc_id
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$function$;

-- deduct_agent_float_for_payout (production original)
CREATE OR REPLACE FUNCTION public.deduct_agent_float_for_payout(p_payout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payout public.landlord_payouts%ROWTYPE;
  v_float_balance numeric;
  v_new_balance numeric;
BEGIN
  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;

  IF v_payout.allocation_applied_id IS NOT NULL
     OR v_payout.status IN ('awaiting_agent_receipt','completed')
     OR v_payout.last_attempt_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'already_accounted', 'status', v_payout.status);
  END IF;

  IF v_payout.status NOT IN ('otp_verified','pending_merchant_payout','pending_finops_disbursement','disbursing') THEN
    RAISE EXCEPTION 'Payout % not in deductible status (%)', p_payout_id, v_payout.status;
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float
  WHERE agent_id = v_payout.agent_id
  FOR UPDATE;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent % has no float account', v_payout.agent_id;
  END IF;

  IF v_float_balance < v_payout.amount THEN
    RAISE EXCEPTION 'Insufficient float (balance %, requested %)', v_float_balance, v_payout.amount;
  END IF;

  v_new_balance := v_float_balance - v_payout.amount;

  UPDATE public.agent_landlord_float
  SET balance = v_new_balance,
      total_paid_out = COALESCE(total_paid_out, 0) + v_payout.amount,
      updated_at = now()
  WHERE agent_id = v_payout.agent_id;

  UPDATE public.landlord_payouts
  SET attempts = attempts + 1,
      last_attempt_at = now()
  WHERE id = p_payout_id;

  RETURN jsonb_build_object('ok', true, 'previous_balance', v_float_balance, 'new_balance', v_new_balance, 'deducted', v_payout.amount);
END;
$function$;

-- enforce_landlord_float_performance_gate (production original)
CREATE OR REPLACE FUNCTION public.enforce_landlord_float_performance_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record;
BEGIN
  IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;

  -- Renewal payouts are not held by the weekly collection target (doc 250).
  IF public.landlord_payout_is_renewal(NEW.landlord_payout_id) THEN
    SELECT * INTO c FROM public._agent_landlord_float_check(NEW.user_id);
    IF c.passes IS FALSE THEN
      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      VALUES (NEW.user_id, 'landlord_gate_renewal_skip',
              'Renewal landlord payout let through while the agent was under the weekly collection target',
              'withdrawal_requests', NEW.id::text,
              jsonb_build_object('landlord_payout_id', NEW.landlord_payout_id, 'amount', NEW.amount,
                                 'rate_pct', c.rate_pct, 'required_pct', c.required_pct, 'basis', c.basis));
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO c FROM public._agent_landlord_float_check(NEW.user_id);
  IF c.passes IS NOT FALSE THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.landlord_float_withdrawal_exceptions e
              WHERE e.agent_id = NEW.user_id AND e.week_start = public.current_welile_week_start(now())) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%', public.landlord_float_blocked_message(NEW.user_id, NEW.amount) USING ERRCODE = 'P0001';
END;
$function$;

-- get_agent_lp_float_available (production original)
CREATE OR REPLACE FUNCTION public.get_agent_lp_float_available(p_agent_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_agent_id IS NOT NULL AND NOT public.agent_float_read_allowed(p_agent_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN GREATEST(
    0,
    COALESCE((SELECT balance FROM public.agent_landlord_float WHERE agent_id = p_agent_id), 0)
    - COALESCE((
        SELECT SUM(amount)
        FROM public.landlord_payouts
        WHERE agent_id = p_agent_id
          AND status IN ('otp_verified','pending_merchant_payout')
      ), 0)
    - COALESCE((
        SELECT SUM(remaining_amount)
        FROM public.agent_landlord_float_allocations
        WHERE agent_id = p_agent_id
          AND status = 'return_pending'
      ), 0)
  );
END;
$function$;

-- post_landlord_payout_finops_commission (production original)
CREATE OR REPLACE FUNCTION public.post_landlord_payout_finops_commission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_commission numeric;
  v_txn_group uuid;
  v_reference text;
BEGIN
  IF NEW.status NOT IN ('awaiting_agent_receipt', 'completed') THEN
    RETURN NEW;
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.finops_disbursed_at IS NOT DISTINCT FROM NEW.finops_disbursed_at THEN
    RETURN NEW;
  END IF;

  IF NEW.agent_id IS NULL OR COALESCE(NEW.amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.general_ledger
    WHERE source_table = 'landlord_payouts'
      AND source_id = NEW.id
      AND category = 'agent_commission_earned'
      AND ledger_scope = 'wallet'
  ) THEN
    RETURN NEW;
  END IF;

  v_commission := ROUND(NEW.amount * 0.01);
  IF v_commission <= 0 THEN
    RETURN NEW;
  END IF;

  v_reference := COALESCE(NULLIF(NEW.finops_momo_reference, ''), NULLIF(NEW.external_reference, ''), NEW.id::text);

  SELECT public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', NEW.agent_id,
        'amount', v_commission,
        'direction', 'cash_in',
        'category', 'agent_commission_earned',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'source_table', 'landlord_payouts',
        'source_id', NEW.id,
        'description', '1% commission on FinOps-approved landlord payout to ' || COALESCE(NEW.landlord_name, 'landlord') || ' (Ref: ' || v_reference || ')',
        'currency', 'UGX',
        'reference_id', NEW.id::text || '-landlord-payout-commission',
        'transaction_date', COALESCE(NEW.finops_disbursed_at, NEW.disbursed_at, now())
      ),
      jsonb_build_object(
        'amount', v_commission,
        'direction', 'cash_out',
        'category', 'marketing_expense',
        'ledger_scope', 'platform',
        'source_table', 'landlord_payouts',
        'source_id', NEW.id,
        'description', 'Platform expense: 1% agent commission for landlord payout ' || NEW.id::text,
        'currency', 'UGX',
        'reference_id', NEW.id::text || '-landlord-payout-commission',
        'transaction_date', COALESCE(NEW.finops_disbursed_at, NEW.disbursed_at, now())
      )
    ),
    'landlord-payout-commission-' || NEW.id::text,
    true
  ) INTO v_txn_group;

  INSERT INTO public.system_events (
    event_type,
    user_id,
    related_entity_type,
    related_entity_id,
    metadata
  ) VALUES (
    'funds_added'::public.system_event_type,
    NEW.agent_id,
    'landlord_payout',
    NEW.id,
    jsonb_build_object(
      'amount', v_commission,
      'currency', 'UGX',
      'source', 'finops_landlord_payout_commission',
      'payout_amount', NEW.amount,
      'commission_rate', 0.01,
      'transaction_group_id', v_txn_group
    )
  );

  INSERT INTO public.welile_trust_score_cache (
    user_id,
    ai_id,
    score,
    tier,
    data_points,
    borrowing_limit_ugx,
    breakdown,
    is_agent_managed,
    last_calculated_at
  ) VALUES (
    NEW.agent_id,
    'WELILE-' || left(replace(NEW.agent_id::text, '-', ''), 10),
    1,
    'new',
    1,
    0,
    jsonb_build_object('landlord_payout_commissions', 1),
    true,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET data_points = public.welile_trust_score_cache.data_points + 1,
      breakdown = COALESCE(public.welile_trust_score_cache.breakdown, '{}'::jsonb) || jsonb_build_object(
        'last_landlord_payout_commission_at', now(),
        'last_landlord_payout_commission_ugx', v_commission
      ),
      last_calculated_at = now();

  RETURN NEW;
END;
$function$;

-- prevent_duplicate_pending_withdrawal (production original)
CREATE OR REPLACE FUNCTION public.prevent_duplicate_pending_withdrawal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  duplicate_id uuid;
  window_minutes int := 15;
  -- Proxy partner payouts are manually keyed by an agent who may re-submit
  -- after doubting whether the first attempt landed. 15 minutes was too short.
  proxy_window_minutes int := 60;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending'
     AND NEW.status IS DISTINCT FROM 'manager_approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.payout_method = 'mobile_money'
     AND NEW.mobile_money_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'mobile_money'
      AND mobile_money_provider IS NOT DISTINCT FROM NEW.mobile_money_provider
      AND regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g')
          = regexp_replace(coalesce(NEW.mobile_money_number, ''), '\D', '', 'g')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  ELSIF NEW.payout_method = 'bank_transfer'
        AND NEW.bank_account_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'bank_transfer'
      AND bank_name IS NOT DISTINCT FROM NEW.bank_name
      AND bank_account_number = NEW.bank_account_number
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  ELSIF NEW.payout_method = 'cash' THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'cash'
      AND coalesce(agent_location, '') = coalesce(NEW.agent_location, '')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;
  END IF;

  -- Proxy fallback: one partner can hold several portfolios, each with its own
  -- payout route and recipient. Two portfolios paying the SAME amount within
  -- the window are legitimately different payouts, so the proxy guard must
  -- compare the destination (route ref + recipient), not only partner+amount.
  IF duplicate_id IS NULL
     AND NEW.proxy_partner_id IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND proxy_partner_id = NEW.proxy_partner_id
      AND amount = NEW.amount
      AND coalesce(payout_route_ref, '') = coalesce(NEW.payout_route_ref, '')
      AND coalesce(payout_method, '') = coalesce(NEW.payout_method, '')
      AND regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g')
          = regexp_replace(coalesce(NEW.mobile_money_number, ''), '\D', '', 'g')
      AND coalesce(bank_account_number, '') = coalesce(NEW.bank_account_number, '')
      AND created_at > now() - make_interval(mins => proxy_window_minutes)
    LIMIT 1;
  END IF;

  IF duplicate_id IS NOT NULL THEN
    RAISE EXCEPTION
      'DUPLICATE_PENDING_WITHDRAWAL: identical request submitted recently (id=%)',
      duplicate_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

-- refund_agent_float_for_payout (production original)
CREATE OR REPLACE FUNCTION public.refund_agent_float_for_payout(p_payout_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_payout public.landlord_payouts%rowtype;
begin
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if not (
         exists (select 1 from public.user_roles ur where ur.user_id = v_uid
                  and ur.role::text = any (array['manager','super_admin','ceo','coo','cfo','financial_ops','admin']))
      or exists (select 1 from public.staff_permissions sp where sp.user_id = v_uid and sp.revoked_at is null
                  and sp.permitted_dashboard = any (array['financial-ops','company-ops']))
    ) then
      raise exception 'only finance staff can refund a landlord payout' using errcode = '42501';
    end if;
  end if;

  if p_reason is null or length(p_reason) < 10 then
    raise exception 'Refund reason must be at least 10 characters';
  end if;

  select * into v_payout from public.landlord_payouts where id = p_payout_id for update;
  if not found then raise exception 'Payout % not found', p_payout_id; end if;

  if v_payout.status in ('failed', 'refunded', 'escalated') then
    return jsonb_build_object('ok', true, 'noop', true, 'status', v_payout.status);
  end if;

  if v_payout.status not in ('otp_verified', 'pending_finops_disbursement', 'pending_merchant_payout', 'disbursing') then
    raise exception 'Cannot refund a payout in status % (the landlord has already been paid)', v_payout.status using errcode = 'P0001';
  end if;

  perform 1 from public.agent_landlord_float where agent_id = v_payout.agent_id for update;

  update public.agent_landlord_float
     set balance = coalesce(balance, 0) + v_payout.amount,
         total_paid_out = greatest(coalesce(total_paid_out, 0) - v_payout.amount, 0),
         updated_at = now()
   where agent_id = v_payout.agent_id;

  if v_payout.allocation_applied_id is not null then
    update public.agent_landlord_float_allocations
       set paid_out_amount = greatest(coalesce(paid_out_amount, 0) - v_payout.amount, 0),
           status = case
             when greatest(coalesce(paid_out_amount, 0) - v_payout.amount, 0) <= 0 then 'open'
             else 'partially_paid'
           end,
           updated_at = now()
     where id = v_payout.allocation_applied_id;
  end if;

  update public.landlord_payouts
     set status = 'failed',
         last_error = p_reason,
         escalated_at = now(),
         escalated_reason = p_reason,
         updated_at = now()
   where id = p_payout_id;

  return jsonb_build_object('ok', true, 'refunded', v_payout.amount, 'reason', p_reason, 'status', 'failed',
                            'allocation_reopened', v_payout.allocation_applied_id is not null);
end;
$function$;

-- require_withdrawal_pin_proof (production original)
CREATE OR REPLACE FUNCTION public.require_withdrawal_pin_proof()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_has boolean;
  v_purpose text;
  v_proof jsonb;
begin
  if v_uid is null or v_uid is distinct from NEW.user_id then
    return NEW;
  end if;

  if TG_TABLE_NAME = 'withdrawal_requests' then
    v_purpose := 'withdrawal';
  else
    v_purpose := 'payout_number_change';
  end if;

  select enforce_mode into v_mode from public.withdrawal_pin_config where id;
  if v_mode is null or v_mode = 'off' then
    return NEW;
  end if;

  select exists (select 1 from public.user_withdrawal_pins where user_id = v_uid) into v_has;
  if not v_has then
    if v_mode = 'all' then
      raise exception using errcode = '28000', message = 'withdrawal_pin_required',
        detail = 'Set your withdrawal PIN before withdrawing or changing your payout number.';
    end if;
    return NEW;
  end if;

  v_proof := public.consume_withdrawal_pin_proof(v_uid, v_purpose);
  if v_proof is null then
    raise exception using errcode = '28000', message = 'withdrawal_pin_proof_required',
      detail = 'Enter your withdrawal PIN to continue.';
  end if;

  if TG_TABLE_NAME = 'payout_number_change_requests' then
    NEW.pin_verified := true;
    NEW.device_fp := v_proof ->> 'device_fp';
    NEW.device_trusted := (v_proof ->> 'device_trusted')::boolean;
  end if;
  return NEW;
end;
$function$;

-- trg_bike_sweep_block_withdrawal_fn (production original)
CREATE OR REPLACE FUNCTION public.trg_bike_sweep_block_withdrawal_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public._bike_sweep_blocks_outflow(NEW.user_id) THEN
    RAISE EXCEPTION 'BIKE_LEASE_FIRST: withdrawals are paused until the bike lease is fully paid' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $function$;

-- _approve_pending_portfolio_core
CREATE OR REPLACE FUNCTION public._approve_pending_portfolio_core(p_portfolio_id uuid, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := p_actor;
  v_status text;
  v_pending public.funder_pending_portfolios%ROWTYPE;
  v_entries jsonb;
  v_group uuid;
  v_ref text;
  v_already boolean := false;
  v_float jsonb;
  v_pool jsonb;
  v_fee jsonb;
  v_direct boolean := coalesce(current_setting('app.funder_direct_release', true), '') = 'on';
  v_prev_owner text := current_setting('psm.owner_release', true);
  v_line record;
BEGIN
  -- Busy stops the float-credit trigger from calling this again while the
  -- ledger rows of this same release are being inserted.
  PERFORM set_config('app.funder_direct_release_busy', 'on', true);
  -- psm_disburse_landlord_float allows the caller when psm.owner_release is on.
  -- Direct release runs as the funder, who is not a Partner Ops reviewer.
  IF v_direct THEN
    PERFORM set_config('psm.owner_release', 'on', true);
    -- A direct release runs as the partner; activating their own portfolio is not an owner edit
    -- (guard_investor_portfolio_self_edit otherwise refuses it with PORTFOLIO_FIELD_LOCKED).
    PERFORM set_config('welile.portfolio_trusted', 'on', true);
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('approve-pending-portfolio-' || p_portfolio_id::text));

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;

  IF v_status = 'active' AND EXISTS (
      SELECT 1 FROM public.funder_pending_portfolios
       WHERE portfolio_id = p_portfolio_id AND status = 'approved'
  ) THEN
    IF v_direct THEN
      PERFORM set_config('psm.owner_release', coalesce(v_prev_owner, ''), true);
    END IF;
    PERFORM set_config('app.funder_direct_release_busy', '', true);
    RETURN p_portfolio_id;
  END IF;

  -- awaiting_funder_deposit is a direct-release promise. It is not an approval queue.
  IF v_status NOT IN ('pending_ops_approval','awaiting_partner_details','awaiting_funder_deposit') THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  SELECT * INTO v_pending FROM public.funder_pending_portfolios
   WHERE portfolio_id = p_portfolio_id AND status = 'pending' FOR UPDATE;

  -- Direct release never funds a Rent Plan that has no assigned agent.
  -- The debit has not happened yet, so this raise leaves no money moved.
  IF v_direct
     AND v_pending.id IS NOT NULL
     AND v_pending.source = 'self_managed'
     AND v_pending.commitment_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.partner_self_funding_lines l
         JOIN public.rent_requests rr ON rr.id = l.rent_request_id
        WHERE l.commitment_id = v_pending.commitment_id
          AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NULL
     ) THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.investor_portfolios
     SET status = 'active',
         next_roi_date = COALESCE(next_roi_date, (now() + interval '30 days')::date),
         maturity_date = COALESCE(maturity_date, (now() + interval '12 months')::date)
   WHERE id = p_portfolio_id;

  IF v_pending.id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.ledger_scope = 'wallet'
         AND g.direction = 'cash_out'
         AND g.category IN ('partner_funding','supporter_rent_fund','portfolio_topup')
         AND (
              g.idempotency_key = 'portfolio-funding-' || p_portfolio_id::text
           OR g.idempotency_key = 'funder-pending-' || v_pending.id::text
           OR (v_pending.commitment_id IS NOT NULL
               AND g.idempotency_key = 'psm-commit-' || v_pending.commitment_id::text)
           OR (v_pending.commitment_id IS NOT NULL
               AND g.idempotency_key = 'psh-commit-' || v_pending.commitment_id::text)
           OR (g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id)
           OR (v_pending.commitment_id IS NOT NULL
               AND g.source_table = 'partner_self_funding_lines'
               AND g.source_id IN (
                    SELECT l.id FROM public.partner_self_funding_lines l
                     WHERE l.commitment_id = v_pending.commitment_id))
           OR (v_pending.commitment_id IS NOT NULL
               AND g.source_table = 'partner_supported_houses'
               AND g.source_id IN (
                    SELECT s.id FROM public.partner_supported_houses s
                     WHERE s.commitment_id = v_pending.commitment_id))
         )
    ) INTO v_already;

    IF v_already THEN
      IF v_pending.source IN ('self_managed','self_managed_house')
         AND v_pending.commitment_id IS NOT NULL THEN
        UPDATE public.partner_self_commitments
           SET status = 'active', updated_at = now()
         WHERE id = v_pending.commitment_id;
      END IF;
    ELSIF v_pending.source = 'self_managed_house' THEN
      SELECT jsonb_agg(e) INTO v_entries FROM (
        SELECT jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', s.principal, 'direction', 'cash_out',
          'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'partner_supported_houses', 'source_id', s.id,
          'reference_id', s.house_id::text,
          'description', 'Partner self-support operational funding for verified house (self_support_operational_house; float_usage=house_support_funding)'
        ) AS e
        FROM public.partner_supported_houses s WHERE s.commitment_id = v_pending.commitment_id
        UNION ALL
        SELECT jsonb_build_object(
          'amount', s.principal, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'partner_supported_houses', 'source_id', s.id,
          'reference_id', s.house_id::text,
          'linked_party', v_pending.funder_id::text,
          'description', 'Self-support operational capital received for verified house (self_support_operational_house; float_usage=house_support_funding)'
        )
        FROM public.partner_supported_houses s WHERE s.commitment_id = v_pending.commitment_id
      ) sq;

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'psh-commit-' || v_pending.commitment_id::text
      );

      UPDATE public.partner_self_commitments
         SET status = 'active', ledger_group_id = v_group, updated_at = now()
       WHERE id = v_pending.commitment_id;
    ELSIF v_pending.source = 'self_managed' THEN
      SELECT jsonb_agg(e) INTO v_entries FROM (
        SELECT jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', l.principal, 'direction', 'cash_out',
          'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'partner_self_funding_lines', 'source_id', l.id,
          'reference_id', public._ssd_debit_ref(v_pending.funder_id, l.rent_request_id, l.id),
          'description', 'Self-managed partner funding approved (self_managed_partner; float_usage=self_portfolio_funding)'
        ) AS e
        FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_pending.commitment_id
        UNION ALL
        SELECT jsonb_build_object(
          'amount', l.principal, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'partner_self_funding_lines', 'source_id', l.id,
          'reference_id', l.rent_request_id::text,
          'linked_party', v_pending.funder_id::text,
          'description', 'Self-managed partner capital received (self_managed_partner; float_usage=self_portfolio_funding)'
        )
        FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_pending.commitment_id
      ) s;

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'psm-commit-' || v_pending.commitment_id::text
      );

      UPDATE public.partner_self_commitments
         SET status = 'active', ledger_group_id = v_group, updated_at = now()
       WHERE id = v_pending.commitment_id;
    ELSE
      v_ref := 'WRF' || to_char(now(), 'YYMMDD') || lpad((floor(random()*9000)+1000)::int::text, 4, '0');
      v_entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', v_pending.amount, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
          'reference_id', v_ref,
          'linked_party', 'Rent Management Pool',
          'description', 'Partner rent pool funding approved by Partner Ops (rent_pool; float_usage=portfolio_funding)'
        ),
        jsonb_build_object(
          'amount', v_pending.amount, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
          'reference_id', v_ref,
          'linked_party', v_pending.funder_id::text,
          'description', 'Partner capital received into Rent Management Pool'
        )
      );

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'funder-pending-' || v_pending.id::text
      );
    END IF;

    UPDATE public.funder_pending_portfolios
       SET status = 'approved', reviewed_by = v_caller, reviewed_at = now(), updated_at = now()
     WHERE id = v_pending.id;
  END IF;

  IF v_pending.id IS NOT NULL AND v_pending.commitment_id IS NOT NULL
     AND v_pending.source IN ('self_managed', 'self_managed_house') THEN
    v_fee := public.self_support_pay_proxy_fee(v_pending.commitment_id);
  END IF;

  v_pool := public.landlord_pool_reserve(p_portfolio_id, NULL, 'approve_pending_portfolio');

  IF v_pending.id IS NOT NULL THEN
    IF v_pending.source = 'self_managed' AND v_pending.commitment_id IS NOT NULL THEN
      v_float := public.psm_disburse_landlord_float(v_pending.commitment_id, NULL, NULL);
    END IF;
  END IF;

  IF v_direct AND v_pending.commitment_id IS NOT NULL AND v_pending.source = 'self_managed' THEN
    FOR v_line IN
      SELECT al.id AS allocation_id, al.agent_id, al.rent_request_id
        FROM public.agent_landlord_float_allocations al
        JOIN public.partner_self_funding_lines l ON l.rent_request_id = al.rent_request_id
       WHERE l.commitment_id = v_pending.commitment_id
         AND al.source = 'partner_self_funding'
         AND al.funded_by_partner_id = v_pending.funder_id
         AND al.status IN ('open', 'partially_paid')
    LOOP
      BEGIN
        PERFORM public._funder_direct_release_note(v_line.rent_request_id, v_line.agent_id, v_line.allocation_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'funder direct release flag failed for plan %: %', v_line.rent_request_id, SQLERRM;
      END;
    END LOOP;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (v_caller, 'funder_direct_release', 'investor_portfolios', p_portfolio_id::text,
      'funder_direct_release',
      'Partner float released straight to the agent landlord float',
      jsonb_build_object(
        'direct_release', true,
        'portfolio_id', p_portfolio_id,
        'commitment_id', v_pending.commitment_id,
        'actor_id', v_caller,
        'landlord_float', v_float
      ));
  END IF;

  -- Self-support (switch self_support_activate_on_landlord_paid): the rent is on the agent's landlord
  -- float as above, but the portfolio does not earn until the merchant pays the landlord.
  IF v_pending.id IS NOT NULL AND v_pending.source = 'self_managed' AND v_pending.commitment_id IS NOT NULL
     AND public._ssd_on() THEN
    PERFORM public._ssd_hold_until_landlord_paid(p_portfolio_id, v_pending.commitment_id);
  END IF;
  IF v_direct THEN
    PERFORM set_config('welile.portfolio_trusted', '', true);
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_caller, 'approve_pending_portfolio', 'investor_portfolios', p_portfolio_id::text,
    'approve_pending_portfolio',
    CASE WHEN v_direct
         THEN 'Direct funder release activated the portfolio'
         ELSE 'Partner Ops verified and activated pending funder portfolio' END,
    jsonb_build_object('reason', CASE WHEN v_direct THEN 'funder_direct_release' ELSE 'ops_approved_pending_funder_portfolio' END,
                       'prev_status', v_status,
                       'ledger_group_id', v_group, 'already_funded', v_already,
                       'source', v_pending.source,
                       'landlord_float', v_float,
                       'landlord_pool', v_pool,
                       'proxy_fee', v_fee,
                       'direct_release', v_direct));

  IF v_direct THEN
    PERFORM set_config('psm.owner_release', coalesce(v_prev_owner, ''), true);
  END IF;
  PERFORM set_config('app.funder_direct_release_busy', '', true);
  RETURN p_portfolio_id;
END;
$function$;

-- co_support_accept
CREATE OR REPLACE FUNCTION public.co_support_accept(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
  v_lead_avail numeric;
  v_avail numeric;
  v_problem text;
  v_claimed integer;
  v_lead jsonb;
  v_mine jsonb;
  v_is_house boolean;
BEGIN
  SELECT id, COALESCE(rent_request_id, house_id) AS target, lead_partner_id, house_id IS NOT NULL AS is_house
    INTO v_peek
    FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'INVITE_NOT_FOUND: This link is not valid. Ask your partner to share it again.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_is_house := v_peek.is_house;

  IF v_is_house THEN
    PERFORM public._co_support_require_partner_house(v_uid);
  ELSE
    PERFORM public._co_support_require_partner(v_uid);
  END IF;

  PERFORM public._co_support_lock(v_peek.target, v_peek.lead_partner_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = v_peek.id FOR UPDATE;

  IF v.status = 'completed' AND v.invitee_id = v_uid THEN
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'idempotent_replay', true, 'landlord_float_released', NOT v_is_house);
  END IF;
  IF v.lead_partner_id = v_uid THEN
    RAISE EXCEPTION 'OWN_INVITE: You shared this. Send the link to the partner who will support it with you.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v.status <> 'open' THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is no longer open.' USING ERRCODE = 'check_violation';
  END IF;
  IF v.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invitation has expired. Ask your partner to send a new one.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v.declined_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_DECLINED: This invitation was declined. Ask your partner to send a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The lead must still be a partner with a signed agreement.
  IF NOT public.psm_is_partner(v.lead_partner_id) OR NOT public.funder_has_signed_agreement(v.lead_partner_id) THEN
    RAISE EXCEPTION 'LEAD_NOT_ELIGIBLE: The partner who shared this cannot fund it right now. Ask them to check their account.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.partner_rate_now(v_uid);
  v_avail := public.funder_float_available(v_uid);
  IF v_avail < v.invitee_share THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: Your half is UGX %. You have UGX % of operational float. Add float to your wallet, then accept.',
      public._co_support_fmt(v.invitee_share), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_is_house THEN
    PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[v.rent_request_id]);
    PERFORM public.psm_assert_no_foreign_booking(v.lead_partner_id, ARRAY[v.rent_request_id]);
  END IF;

  -- Close the invite first: this ends the lead's hold, so their half can be used here.
  UPDATE public.co_support_invites
     SET status = 'completed', invitee_id = v_uid, accepted_at = now(),
         closed_at = now(), close_reason = 'accepted', updated_at = now()
   WHERE id = v.id;

  v_lead_avail := public.funder_float_available(v.lead_partner_id);
  IF v_lead_avail < v.lead_share THEN
    RAISE EXCEPTION 'LEAD_FUNDS_SHORT: Your partner no longer has their half in their wallet. Ask them to add float, then try again.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_house THEN
    v_problem := public._co_support_house_problem(v.house_id);
    IF v_problem IS NULL AND (SELECT hl.monthly_rent::numeric FROM public.house_listings hl WHERE hl.id = v.house_id)
                             IS DISTINCT FROM v.rent_amount THEN
      v_problem := 'plan_changed';
    END IF;
  ELSE
    v_problem := public._co_support_plan_problem(v.lead_partner_id, v.rent_request_id);
    -- The halves were agreed on this rent. If the rent changed since, nobody pays.
    IF v_problem IS NULL AND (SELECT rr.rent_amount FROM public.rent_requests rr WHERE rr.id = v.rent_request_id)
                             IS DISTINCT FROM v.rent_amount THEN
      v_problem := 'plan_changed';
    END IF;
    IF v_problem IS NULL THEN
      INSERT INTO public.partner_self_plan_claims (
        rent_request_id, partner_id, amount, status, idempotency_key, expires_at, confirmed_at
      ) VALUES (
        v.rent_request_id, v.lead_partner_id, v.rent_amount, 'confirmed', 'cosup-' || v.id::text, now(), now()
      )
      ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;
      GET DIAGNOSTICS v_claimed = ROW_COUNT;
      IF v_claimed = 0 THEN
        v_problem := 'plan_held';
      END IF;
    END IF;
  END IF;

  IF v_problem IS NOT NULL THEN
    -- It went elsewhere (or its rent changed). Close the invite; no money moves.
    UPDATE public.co_support_invites
       SET status = 'plan_unavailable', invitee_id = NULL, accepted_at = NULL,
           close_reason = v_problem, updated_at = now()
     WHERE id = v.id;
    PERFORM public.psm_audit(v_uid, v.lead_partner_id, 'co_support_plan_unavailable',
      'co_support_invites', v.id, jsonb_build_object('reason', v_problem, 'invitee', v_uid));
    RETURN jsonb_build_object('ok', false, 'status', 'plan_unavailable', 'reason', v_problem,
      'message', CASE WHEN v_problem = 'plan_changed'
                      THEN 'The rent changed after this was shared. Nothing was taken from your wallet. Ask your partner to share it again.'
                      WHEN v_is_house
                      THEN 'This house was taken before you accepted. Nothing was taken from your wallet.'
                      ELSE 'This Rent Plan was taken before you accepted. Nothing was taken from your wallet.' END);
  END IF;

  IF v_is_house THEN
    v_lead := public._co_support_open_house_half(v.id, v.lead_partner_id, v.lead_rent, v.lead_share, 'lead');
    v_mine := public._co_support_open_house_half(v.id, v_uid, v.invitee_rent, v.invitee_share, 'invitee');
  ELSE
    v_lead := public._co_support_open_half(v.id, v.lead_partner_id, v.lead_rent, v.lead_share, 'lead');
    v_mine := public._co_support_open_half(v.id, v_uid, v.invitee_rent, v.invitee_share, 'invitee');

    UPDATE public.partner_self_plan_claims
       SET commitment_id = (v_lead->>'commitment_id')::uuid, updated_at = now()
     WHERE idempotency_key = 'cosup-' || v.id::text
       AND partner_id = v.lead_partner_id
       AND rent_request_id = v.rent_request_id;

    UPDATE public.rent_requests
       SET self_funding_partner_id = v.lead_partner_id,
           self_funding_line_id = (v_lead->>'line_id')::uuid,
           updated_at = now()
     WHERE id = v.rent_request_id;
  END IF;

  UPDATE public.co_support_invites
     SET lead_commitment_id = (v_lead->>'commitment_id')::uuid,
         invitee_commitment_id = (v_mine->>'commitment_id')::uuid,
         lead_portfolio_id = (v_lead->>'portfolio_id')::uuid,
         invitee_portfolio_id = (v_mine->>'portfolio_id')::uuid,
         updated_at = now()
   WHERE id = v.id;

  -- Self-support (switch self_support_activate_on_landlord_paid): empty houses are active at once.
  -- Both halves are debited and active here, in one transaction, in a fixed order.
  IF v_is_house AND public._ssd_on() THEN
    PERFORM public._ssd_house_instant(LEAST((v_lead->>'portfolio_id')::uuid, (v_mine->>'portfolio_id')::uuid));
    PERFORM public._ssd_house_instant(GREATEST((v_lead->>'portfolio_id')::uuid, (v_mine->>'portfolio_id')::uuid));
    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
      jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                         'portfolio_id', v_mine->>'portfolio_id', 'house_id', v.house_id, 'status', 'active'));
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'awaiting_partner_ops', false, 'house_active', true,
                              'earning_from', public._ssd_earning_date(), 'landlord_float_released', false,
                              'available_balance', public.funder_float_available(v_uid));
  END IF;

  IF v_is_house THEN
    -- Partner Ops approves the pair (approve_pending_portfolio); nothing is debited yet.
    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('portfolio_topup', v_uid, 'co_support_invites', v.id,
              'Two partners co-supported a verified empty house: waiting for Partner Ops',
              jsonb_build_object('house_id', v.house_id, 'amount', v.gross_amount,
                                 'lead_partner_id', v.lead_partner_id, 'invitee_id', v_uid,
                                 'lead_portfolio_id', v_lead->>'portfolio_id',
                                 'invitee_portfolio_id', v_mine->>'portfolio_id',
                                 'source', 'self_managed_house'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
      jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                         'portfolio_id', v_mine->>'portfolio_id', 'house_id', v.house_id,
                         'status', 'pending_ops_approval'));
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'awaiting_partner_ops', true, 'landlord_float_released', false,
                              'available_balance', public.funder_float_available(v_uid));
  END IF;

  -- Rent Plan: direct release, as in Phase 1.
  PERFORM set_config('app.funder_direct_release', 'on', true);
  PERFORM public._approve_pending_portfolio_core((v_lead->>'portfolio_id')::uuid, v.lead_partner_id);
  PERFORM public._approve_pending_portfolio_core((v_mine->>'portfolio_id')::uuid, v_uid);

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id = v.rent_request_id
       AND a.source = 'partner_self_funding'
       AND a.status IN ('open', 'partially_paid')
       AND a.allocated_amount = v.rent_amount
  ) THEN
    RAISE EXCEPTION 'CO_SUPPORT_RELEASE_FAILED: The landlord float could not be released, so nothing was taken from either wallet. Please try again.'
      USING ERRCODE = 'check_violation';
  END IF;

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('rent_request_created', v_uid, 'co_support_invites', v.id,
            'Two partners co-supported a Rent Plan: rent moved to the agent landlord float',
            jsonb_build_object('rent_request_id', v.rent_request_id, 'rent_amount', v.rent_amount,
                               'lead_partner_id', v.lead_partner_id, 'invitee_id', v_uid,
                               'lead_portfolio_id', v_lead->>'portfolio_id',
                               'invitee_portfolio_id', v_mine->>'portfolio_id',
                               'direct_release', true));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
    jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                       'portfolio_id', v_mine->>'portfolio_id'));

  RETURN public._co_support_invite_json(v.id, v_uid)
      || jsonb_build_object('ok', true, 'landlord_float_released', true,
                            'available_balance', public.funder_float_available(v_uid))
      || public._ssd_plan_result(v.rent_request_id);
END;
$function$;

-- _co_support_disburse_landlord_float
CREATE OR REPLACE FUNCTION public._co_support_disburse_landlord_float(p_commitment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_co uuid;
  v_inv public.co_support_invites%ROWTYPE;
  v_lines integer;
  v_paid integer;
  v_rent numeric;
  v_lead_line uuid;
  v_rr record;
  v_line record;
  v_alloc uuid;
  v_ref text;
  v_landlord_name text;
  v_pool_entry uuid;
  v_pool_drawn numeric := 0;
  v_treasury jsonb;
  v_notices integer := 0;
BEGIN
  SELECT l.co_support_id INTO v_co
    FROM public.partner_self_funding_lines l
   WHERE l.commitment_id = p_commitment_id AND l.co_support_id IS NOT NULL
   LIMIT 1;
  IF v_co IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'not_co_support');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('co-support-float-' || v_co::text));
  SELECT * INTO v_inv FROM public.co_support_invites WHERE id = v_co;

  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.general_ledger g
            WHERE g.idempotency_key = 'psm-commit-' || l.commitment_id::text
              AND g.ledger_scope = 'wallet'
              AND g.direction = 'cash_out')),
         COALESCE(SUM(COALESCE(l.rent_amount, l.principal)), 0)
    INTO v_lines, v_paid, v_rent
    FROM public.partner_self_funding_lines l
   WHERE l.co_support_id = v_co AND l.status <> 'cancelled';

  -- Wait for the other half. The second half's approval releases the float.
  IF v_lines <> 2 OR v_paid < 2 THEN
    PERFORM public.psm_audit(auth.uid(), v_inv.lead_partner_id, 'co_support_float_waiting',
      'co_support_invites', v_co,
      jsonb_build_object('lines', v_lines, 'paid', v_paid, 'commitment_id', p_commitment_id));
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'co_support_waiting_for_other_half',
                              'lines', v_lines, 'paid', v_paid);
  END IF;

  SELECT l.id INTO v_lead_line
    FROM public.partner_self_funding_lines l
   WHERE l.co_support_id = v_co AND l.partner_id = v_inv.lead_partner_id AND l.status <> 'cancelled'
   LIMIT 1;

  IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = 'psm-float-' || v_lead_line::text) THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'already_released');
  END IF;

  SELECT rr.id, rr.tenant_id, rr.landlord_id,
         COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
         ld.name AS landlord_name,
         COALESCE(ld.mobile_money_number, ld.phone) AS landlord_phone
    INTO v_rr
    FROM public.rent_requests rr
    LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
   WHERE rr.id = v_inv.rent_request_id;

  -- Both partners have paid, so never leave the money without a landlord float:
  -- refuse, and the caller's transaction (both debits) rolls back.
  IF v_rr.agent_id IS NULL THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id = v_rr.id AND a.status IN ('open', 'partially_paid')
  ) THEN
    RAISE EXCEPTION 'PLAN_ALREADY_FUNDED: This Rent Plan already has landlord float.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_landlord_name := COALESCE(v_rr.landlord_name, 'Unknown Landlord');
  v_ref := 'PSC-' || upper(substr(replace(v_co::text, '-', ''), 1, 8));

  -- One allocation for the full rent: the agent pays the landlord once.
  INSERT INTO public.agent_landlord_float_allocations (
    agent_id, tenant_id, rent_request_id, landlord_id,
    landlord_name, landlord_phone, allocated_amount, source,
    funded_by_partner_id, funding_reference
  ) VALUES (
    v_rr.agent_id, v_rr.tenant_id, v_rr.id, v_rr.landlord_id,
    v_landlord_name, v_rr.landlord_phone, v_rent, 'partner_self_funding',
    v_inv.lead_partner_id, v_ref
  )
  RETURNING id INTO v_alloc;

  -- One ledger pair per half, each under its own line (same key shape as a
  -- single-partner release: psm-float-<line>).
  FOR v_line IN
    SELECT l.id, l.partner_id, COALESCE(l.rent_amount, l.principal) AS amount,
           CASE WHEN l.partner_id = v_inv.lead_partner_id THEN v_ref ELSE v_ref || '-2' END AS ref
      FROM public.partner_self_funding_lines l
     WHERE l.co_support_id = v_co AND l.status <> 'cancelled'
     ORDER BY (l.partner_id = v_inv.lead_partner_id) DESC, l.created_at
  LOOP
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'direction','cash_out','amount', v_line.amount,
          'category','rent_disbursement','ledger_scope','platform',
          'source_table','partner_self_funding_lines','source_id', v_line.id,
          'reference_id', v_line.ref,
          'user_id', v_rr.agent_id,
          'linked_party', v_line.partner_id::text,
          'description','Partner self-managed funding released to agent landlord float for ' || v_landlord_name || ' (co-support half)'
        ),
        jsonb_build_object(
          'direction','cash_in','amount', v_line.amount,
          'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','partner_self_funding_lines','source_id', v_line.id,
          'reference_id', v_line.ref,
          'user_id', v_rr.agent_id,
          'linked_party', v_line.partner_id::text,
          'description','Landlord float credited (partner-funded, co-support half) - ' || v_landlord_name
        )
      ),
      idempotency_key := 'psm-float-' || v_line.id::text
    );

    v_pool_entry := NULL;
    SELECT e.id INTO v_pool_entry FROM public.landlord_pool_entries e
     WHERE e.source_table = 'partner_self_funding_lines' AND e.source_id = v_line.id
       AND e.status = 'open' AND e.in_pool > 0;
    IF v_pool_entry IS NOT NULL THEN
      v_pool_drawn := v_pool_drawn + coalesce((public.landlord_pool_deploy(
        v_rr.id, v_line.amount, 'self_support', v_alloc, v_pool_entry,
        'co_support_disburse_landlord_float') ->> 'drawn')::numeric, 0);
    END IF;
  END LOOP;

  INSERT INTO public.agent_float_funding (agent_id, amount, funded_by, rent_request_id, notes)
  VALUES (v_rr.agent_id, v_rent, auth.uid(), v_rr.id,
          'Partner-funded landlord float (co-support) for ' || v_landlord_name)
  ON CONFLICT DO NOTHING;

  UPDATE public.rent_requests
     SET status = 'funded',
         funded_at = COALESCE(funded_at, now()),
         self_funding_partner_id = COALESCE(self_funding_partner_id, v_inv.lead_partner_id),
         self_funding_line_id = COALESCE(self_funding_line_id, v_lead_line),
         updated_at = now()
   WHERE id = v_rr.id
     AND status IN ('approved','coo_approved','pending','agent_ops_approved',
                    'tenant_ops_approved','landlord_ops_approved','agent_verified','cfo_approved');

  v_treasury := public.recognise_funding_treasury(v_rr.id);

  -- Agent and landlord notices: one each, for the full rent, under the lead.
  INSERT INTO public.partner_float_agent_notices (
    commitment_id, topup_id, partner_id, agent_id, landlord_id,
    landlord_name, amount, tenant_count, rent_request_ids
  ) VALUES (
    v_inv.lead_commitment_id, NULL, v_inv.lead_partner_id, v_rr.agent_id, v_rr.landlord_id,
    COALESCE(v_rr.landlord_name, 'the landlord'), v_rent, 1, ARRAY[v_rr.id]
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_notices = ROW_COUNT;

  BEGIN
    INSERT INTO public.partner_float_landlord_notices (
      commitment_id, topup_id, partner_id, agent_id, agent_name, landlord_id,
      landlord_name, landlord_phone, amount, tenant_count, tenant_first_names, rent_request_ids
    )
    SELECT v_inv.lead_commitment_id, NULL, v_inv.lead_partner_id, v_rr.agent_id, pa.full_name, v_rr.landlord_id,
           COALESCE(v_rr.landlord_name, 'the landlord'), ld.phone, v_rent, 1,
           CASE WHEN btrim(COALESCE(pt.full_name, '')) <> ''
                THEN ARRAY[initcap(split_part(btrim(pt.full_name), ' ', 1))]
                ELSE '{}'::text[] END,
           ARRAY[v_rr.id]
      FROM (SELECT 1) one
      LEFT JOIN public.profiles pa ON pa.id = v_rr.agent_id
      LEFT JOIN public.profiles pt ON pt.id = v_rr.tenant_id
      LEFT JOIN public.landlords ld ON ld.id = v_rr.landlord_id
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.psm_audit(auth.uid(), v_inv.lead_partner_id, 'landlord_sms_queue_failed',
      'co_support_invites', v_co, jsonb_build_object('error', SQLERRM));
  END;

  IF COALESCE(current_setting('app.funder_direct_release', true), '') = 'on' THEN
    BEGIN
      PERFORM public._funder_direct_release_note(v_rr.id, v_rr.agent_id, v_alloc);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'funder direct release flag failed for co-supported plan %: %', v_rr.id, SQLERRM;
    END;
  END IF;

  PERFORM public.psm_audit(auth.uid(), v_inv.lead_partner_id, 'landlord_float_disbursed',
    'co_support_invites', v_co,
    jsonb_build_object('funded_lines', 2, 'total_amount', v_rent, 'allocation_id', v_alloc,
                       'notices_queued', v_notices, 'treasury', v_treasury,
                       'landlord_pool_drawn', v_pool_drawn, 'co_support', true));

  RETURN jsonb_build_object('funded', 1, 'skipped', 0, 'total_amount', v_rent,
                            'notices_queued', v_notices,
                            'treasury_recognised', CASE WHEN (v_treasury->>'status') = 'recognised' THEN 1 ELSE 0 END,
                            'landlord_pool_drawn', v_pool_drawn,
                            'co_support_id', v_co, 'allocation_id', v_alloc);
END;
$function$;

-- merchant-direct helpers no production function references any more
DROP FUNCTION IF EXISTS public._ssd_wr_insert_is_direct(uuid);
DROP FUNCTION IF EXISTS public._ssd_inserting();
DROP FUNCTION IF EXISTS public._ssd_payout_is_direct(uuid);
