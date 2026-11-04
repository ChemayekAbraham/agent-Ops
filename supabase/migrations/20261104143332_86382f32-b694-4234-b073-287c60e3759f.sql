-- 1) Per-lease CFO setting + collection details on repayment history
ALTER TABLE public.merchandise_recovery_plans
  ADD COLUMN IF NOT EXISTS instant_wallet_sweep boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS instant_sweep_set_by uuid,
  ADD COLUMN IF NOT EXISTS instant_sweep_set_at timestamptz;

ALTER TABLE public.merchandise_recovery_deductions
  ADD COLUMN IF NOT EXISTS collection_mode text,
  ADD COLUMN IF NOT EXISTS trigger_category text,
  ADD COLUMN IF NOT EXISTS trigger_amount numeric,
  ADD COLUMN IF NOT EXISTS trigger_ledger_id uuid,
  ADD COLUMN IF NOT EXISTS reference text;

-- Only the CFO RPC may change the setting
CREATE OR REPLACE FUNCTION public._guard_instant_wallet_sweep()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.instant_wallet_sweep IS DISTINCT FROM OLD.instant_wallet_sweep
     AND COALESCE(current_setting('welile.instant_sweep_rpc', true),'') <> 'on' THEN
    RAISE EXCEPTION 'Instant bike collection can only be changed by the CFO setting' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_instant_wallet_sweep ON public.merchandise_recovery_plans;
CREATE TRIGGER trg_guard_instant_wallet_sweep BEFORE UPDATE ON public.merchandise_recovery_plans
  FOR EACH ROW EXECUTE FUNCTION public._guard_instant_wallet_sweep();

CREATE OR REPLACE FUNCTION public.cfo_set_bike_instant_sweep(p_plan_id uuid, p_enabled boolean, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); p record;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_mfa_ok() OR NOT public.has_role(v_uid,'cfo'::app_role) THEN
    RAISE EXCEPTION 'Only the CFO can change instant bike collection' USING ERRCODE='42501';
  END IF;
  IF length(trim(COALESCE(p_reason,''))) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;
  SELECT * INTO p FROM public.merchandise_recovery_plans WHERE id=p_plan_id AND COALESCE(is_bike_lease,false) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bike lease plan not found'; END IF;
  PERFORM set_config('welile.instant_sweep_rpc','on',true);
  UPDATE public.merchandise_recovery_plans SET instant_wallet_sweep=p_enabled, instant_sweep_set_by=v_uid, instant_sweep_set_at=now() WHERE id=p_plan_id;
  PERFORM set_config('welile.instant_sweep_rpc','',true);
  INSERT INTO public.audit_logs(user_id, actor_id, action_type, action, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, v_uid, 'bike_instant_sweep_set', 'bike_instant_sweep_set', 'merchandise_recovery_plans', p_plan_id::text, trim(p_reason),
    jsonb_build_object('instant_wallet_sweep', p.instant_wallet_sweep), jsonb_build_object('instant_wallet_sweep', p_enabled));
  RETURN jsonb_build_object('plan_id', p_plan_id, 'instant_wallet_sweep', p_enabled);
END $$;
REVOKE ALL ON FUNCTION public.cfo_set_bike_instant_sweep(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_set_bike_instant_sweep(uuid, boolean, text) TO authenticated;

-- 2) Advance recovery never asks for more than the wallet holds (bike may have collected first)
CREATE OR REPLACE FUNCTION public.apply_roi_advance_recovery(p_user_id uuid, p_roi_amount numeric, p_source_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_adv record; v_remaining numeric := COALESCE(p_roi_amount, 0); v_recovered numeric := 0;
  v_take numeric; v_closing numeric; v_new_status text; v_idem text;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date; v_details jsonb := '[]'::jsonb; v_avail numeric;
BEGIN
  IF p_user_id IS NULL OR v_remaining <= 0 THEN
    RETURN jsonb_build_object('recovered', 0, 'net_roi', GREATEST(0, v_remaining), 'advances', v_details);
  END IF;
  IF p_idempotency_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = 'roi_adv_rec_' || p_idempotency_key) THEN
    RETURN jsonb_build_object('recovered', 0, 'net_roi', v_remaining, 'advances', v_details, 'skipped', 'already_recovered');
  END IF;
  FOR v_adv IN
    SELECT * FROM public.agent_advances
    WHERE agent_id = p_user_id AND recovery_source = 'roi' AND status IN ('active','overdue')
      AND COALESCE(deduction_paused, false) = false AND outstanding_balance > 0 AND COALESCE(roi_recovery_percent, 0) > 0
    ORDER BY issued_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_avail := floor(GREATEST(COALESCE(public.get_user_available_balance__impl(p_user_id), 0), 0));
    v_take := round(LEAST(v_adv.outstanding_balance, v_remaining, COALESCE(p_roi_amount, 0) * (v_adv.roi_recovery_percent / 100.0)));
    v_take := LEAST(v_take, v_avail);
    IF v_take <= 0 THEN CONTINUE; END IF;
    v_idem := COALESCE('roi_adv_rec_' || p_idempotency_key,
      'roi_adv_rec_' || v_adv.id::text || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text);
    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_take, 'category', 'agent_repayment', 'recipient_type', 'user',
          'source_table', 'agent_advances', 'source_id', v_adv.id,
          'description', 'Advance recovery of ' || v_adv.roi_recovery_percent || '% from ROI payout', 'currency', 'UGX',
          'metadata', jsonb_build_object('source','roi_recovery','advance_id',v_adv.id,'roi_amount',p_roi_amount,'portfolio_id',p_source_id)),
        jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_take, 'category', 'agent_advance_repayment', 'recipient_type', 'operational_wallet',
          'source_table', 'agent_advances', 'source_id', v_adv.id,
          'description', 'Advance repayment received from ROI recovery', 'currency', 'UGX',
          'metadata', jsonb_build_object('source','roi_recovery','advance_id',v_adv.id,'roi_amount',p_roi_amount,'portfolio_id',p_source_id))),
      idempotency_key => v_idem);
    v_closing := GREATEST(0, v_adv.outstanding_balance - v_take);
    v_new_status := CASE WHEN v_closing <= 0 THEN 'completed' WHEN v_adv.expires_at < now() THEN 'overdue' ELSE 'active' END;
    UPDATE public.agent_advances SET outstanding_balance = v_closing, status = v_new_status, updated_at = now() WHERE id = v_adv.id;
    INSERT INTO public.agent_advance_ledger (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status, recovery_source, roi_amount, recovery_percent)
    VALUES (v_adv.id, v_today, v_adv.outstanding_balance, 0, v_take, v_closing, CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END, 'roi', p_roi_amount, v_adv.roi_recovery_percent);
    v_remaining := v_remaining - v_take; v_recovered := v_recovered + v_take;
    v_details := v_details || jsonb_build_object('advance_id', v_adv.id, 'percent', v_adv.roi_recovery_percent, 'recovered', v_take, 'outstanding_after', v_closing, 'status', v_new_status);
  END LOOP;
  RETURN jsonb_build_object('recovered', v_recovered, 'net_roi', GREATEST(0, COALESCE(p_roi_amount,0) - v_recovered), 'advances', v_details);
END;
$function$;

-- 3) Instant bike collection when money lands in the withdrawable wallet
CREATE OR REPLACE FUNCTION public._bike_instant_sweep(p_agent uuid, p_trigger_id uuid, p_trigger_cat text, p_trigger_amount numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p record; v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date; v_v2 boolean; v_ratio numeric;
  v_avail numeric; v_amount numeric; v_fee numeric; v_prin numeric; v_closing numeric; v_entries jsonb; v_idem text; v_total numeric := 0;
BEGIN
  FOR p IN SELECT * FROM public.merchandise_recovery_plans
     WHERE customer_id=p_agent AND instant_wallet_sweep AND status='active' AND outstanding_balance>0
       AND COALESCE(is_bike_lease,false) AND NOT COALESCE(recovery_hold,false)
     ORDER BY created_at FOR UPDATE
  LOOP
    IF NOT public.merchandise_plan_recovery_eligible(p.id) THEN CONTINUE; END IF;
    v_avail := floor(GREATEST(COALESCE(public.get_user_available_balance__impl(p_agent),0),0));
    v_amount := LEAST(v_avail, p.outstanding_balance);
    EXIT WHEN v_amount <= 0;
    v_v2 := COALESCE(p.pricing_basis,'')='spiro_28pct_v2';
    v_ratio := 0;
    IF v_v2 THEN
      SELECT b.fee_ratio INTO v_ratio FROM public._merch_bike_day(p.sale_id, true, LEAST(GREATEST(v_today, COALESCE(p.starts_on, v_today)), p.term_end_on - 1)) b;
    END IF;
    v_fee := 0; v_prin := v_amount;
    IF v_v2 THEN
      v_fee := LEAST(round(v_amount * COALESCE(v_ratio,0)), GREATEST(COALESCE(p.fee_total,0)-COALESCE(p.fee_recovered,0),0));
      v_prin := v_amount - v_fee;
    END IF;
    v_idem := 'bike_instant_' || p.id::text || '_' || p_trigger_id::text;
    v_entries := jsonb_build_array(jsonb_build_object(
      'user_id', p_agent, 'ledger_scope','wallet','direction','cash_out','amount',v_amount,'category','agent_repayment',
      'recipient_type','user','wallet_bucket','withdrawable','source_table','merchandise_recovery_plans','source_id',p.id,
      'description','Bike Lease Payment - '||COALESCE(p.item_name,'Bike')||' (collected on arrival)','currency','UGX',
      'metadata', jsonb_build_object('source','bike_instant_sweep','plan_id',p.id,'sale_id',p.sale_id,'trigger_ledger_id',p_trigger_id,
        'trigger_category',p_trigger_cat,'trigger_amount',p_trigger_amount,'principal_part',v_prin,'fee_part',v_fee)));
    IF v_prin > 0 THEN
      v_entries := v_entries || jsonb_build_array(jsonb_build_object('user_id',p_agent,'ledger_scope','platform','direction','cash_in',
        'amount',v_prin,'category','bike_recovery_repayment','recipient_type','operational_wallet','source_table','merchandise_recovery_plans',
        'source_id',p.id,'description','Bike lease cost recovered from agent wallet: '||COALESCE(p.item_name,'Bike'),'currency','UGX',
        'metadata',jsonb_build_object('source','bike_instant_sweep','plan_id',p.id,'part','principal')));
    END IF;
    IF v_fee > 0 THEN
      v_entries := v_entries || jsonb_build_array(jsonb_build_object('user_id',p_agent,'ledger_scope','platform','direction','cash_in',
        'amount',v_fee,'category','access_fee_collected','recipient_type','operational_wallet','source_table','merchandise_recovery_plans',
        'source_id',p.id,'description','Bike lease access fee collected: '||COALESCE(p.item_name,'Bike'),'currency','UGX',
        'metadata',jsonb_build_object('source','bike_lease_access_fee','plan_id',p.id,'part','access_fee')));
    END IF;
    BEGIN
      PERFORM public.create_ledger_transaction(entries => v_entries, idempotency_key => v_idem);
      v_closing := GREATEST(0, p.outstanding_balance - v_amount);
      INSERT INTO public.merchandise_recovery_deductions (plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref,
        collection_mode, trigger_category, trigger_amount, trigger_ledger_id, reference)
      VALUES (p.id, p_agent, p.item_name, v_amount, v_avail, v_closing, gen_random_uuid(), 'instant', p_trigger_cat, p_trigger_amount, p_trigger_id, v_idem);
      UPDATE public.merchandise_recovery_plans SET outstanding_balance=v_closing, amount_recovered=amount_recovered+v_amount,
        fee_recovered=COALESCE(fee_recovered,0)+v_fee, principal_recovered=COALESCE(principal_recovered,0)+CASE WHEN v_v2 THEN v_prin ELSE 0 END,
        due_balance=GREATEST(0,COALESCE(due_balance,0)-v_amount), last_success_on=v_today, last_attempt_on=v_today, last_attempt_result='collected_on_arrival',
        last_bike_recovery_on=v_today, last_recovery_at=now(), miss_alert_sent=false,
        status=CASE WHEN v_closing<=0 THEN 'completed' ELSE status END, completed_at=CASE WHEN v_closing<=0 THEN now() ELSE completed_at END, updated_at=now()
      WHERE id=p.id;
      IF p.sale_id IS NOT NULL THEN
        UPDATE public.merchandise_sales SET amount_paid=COALESCE(amount_paid,0)+v_amount, amount_outstanding=v_closing,
          payment_status=CASE WHEN v_closing<=0 THEN 'paid' ELSE 'partial' END, updated_at=now() WHERE id=p.sale_id;
      END IF;
      v_total := v_total + v_amount;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.merchandise_recovery_plans SET last_attempt_on=v_today, last_attempt_result=left('instant failed: '||SQLERRM,300) WHERE id=p.id;
    END;
  END LOOP;
  RETURN v_total;
END $$;
REVOKE ALL ON FUNCTION public._bike_instant_sweep(uuid, uuid, text, numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_bike_instant_sweep_fn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.user_id IS NULL OR COALESCE(NEW.ledger_scope,'wallet') <> 'wallet' OR NEW.direction <> 'cash_in' THEN RETURN NEW; END IF;
  IF NEW.wallet_bucket IS DISTINCT FROM 'withdrawable' OR NEW.category = 'bucket_reclass_in' THEN RETURN NEW; END IF;
  -- Bike first (only leases the CFO switched on)
  IF EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE customer_id=NEW.user_id AND instant_wallet_sweep AND status='active' AND outstanding_balance>0) THEN
    BEGIN
      PERFORM public._bike_instant_sweep(NEW.user_id, NEW.id, NEW.category, NEW.amount);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'bike instant sweep failed for %: %', NEW.user_id, SQLERRM;
    END;
  END IF;
  -- Then advance recovery from Partner Returns, in the same transaction as the Return
  IF NEW.category = 'roi_wallet_credit' AND COALESCE(NEW.idempotency_key,'') LIKE 'return-cycle:%' THEN
    BEGIN
      PERFORM public.apply_roi_advance_recovery(NEW.user_id, NEW.amount, NULLIF(NEW.source_id::text,'')::uuid, NEW.idempotency_key);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'roi advance recovery failed for %: %', NEW.user_id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_zzz_bike_instant_sweep ON public.general_ledger;
CREATE TRIGGER trg_zzz_bike_instant_sweep AFTER INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.trg_bike_instant_sweep_fn();

-- 4) No withdrawal / float conversion while the bike is owed and money sits in withdrawable
CREATE OR REPLACE FUNCTION public._bike_sweep_blocks_outflow(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE customer_id=p_user AND instant_wallet_sweep AND status='active' AND outstanding_balance>0 AND NOT COALESCE(recovery_hold,false))
$$;
REVOKE ALL ON FUNCTION public._bike_sweep_blocks_outflow(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_bike_sweep_block_ledger_fn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND COALESCE(NEW.ledger_scope,'wallet')='wallet' AND NEW.direction='cash_out'
     AND NEW.category IN ('wallet_withdrawal','bucket_reclass_out') AND COALESCE(NEW.wallet_bucket,'withdrawable')='withdrawable'
     AND public._bike_sweep_blocks_outflow(NEW.user_id) THEN
    RAISE EXCEPTION 'BIKE_LEASE_FIRST: this wallet''s money goes to the bike lease balance first' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bike_sweep_block_outflow ON public.general_ledger;
CREATE TRIGGER trg_bike_sweep_block_outflow BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.trg_bike_sweep_block_ledger_fn();

CREATE OR REPLACE FUNCTION public.trg_bike_sweep_block_withdrawal_fn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public._bike_sweep_blocks_outflow(NEW.user_id) THEN
    RAISE EXCEPTION 'BIKE_LEASE_FIRST: withdrawals are paused until the bike lease is fully paid' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bike_sweep_block_withdrawal ON public.withdrawal_requests;
CREATE TRIGGER trg_bike_sweep_block_withdrawal BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.trg_bike_sweep_block_withdrawal_fn();

-- 5) Switch it on for ALPHA SSEMA's lease only
SELECT set_config('welile.instant_sweep_rpc','on',true);
UPDATE public.merchandise_recovery_plans SET instant_wallet_sweep=true, instant_sweep_set_at=now()
 WHERE id='93d95269-34da-45f0-9845-fff6b7312220' AND customer_id='9188db01-e54a-4f84-8de9-042e6b5b6bd6';
INSERT INTO public.audit_logs(action_type, action, table_name, record_id, reason, new_values, target_user_id)
VALUES ('bike_instant_sweep_set','bike_instant_sweep_set','merchandise_recovery_plans','93d95269-34da-45f0-9845-fff6b7312220',
  'Turned on at CFO instruction: collect bike lease on arrival of withdrawable money (ALPHA SSEMA, SPB-141C9E02)',
  jsonb_build_object('instant_wallet_sweep',true), '9188db01-e54a-4f84-8de9-042e6b5b6bd6');