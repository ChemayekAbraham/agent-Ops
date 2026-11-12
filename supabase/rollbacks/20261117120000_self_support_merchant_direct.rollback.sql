-- Rollback for 20261117120000_self_support_merchant_direct. Refuses while any partner money is still waiting in the merchant queue.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.self_support_landlord_payments WHERE status = 'queued') THEN
    RAISE EXCEPTION 'self-support landlord payments are still queued: let them pay or refund (ssd_expire_unpaid) first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_self_commitments WHERE status = 'awaiting_landlord') THEN
    RAISE EXCEPTION 'commitments still awaiting_landlord';
  END IF;
END $$;

SELECT cron.unschedule('ssd_expire_unpaid') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ssd_expire_unpaid');
DROP TRIGGER IF EXISTS trg_a0_ssd_landlord_payout_status ON public.landlord_payouts;
DROP TRIGGER IF EXISTS zzzz_ssd_landlord_paid_notify ON public.landlord_payouts;

-- production definitions as of 2026-11-12
-- enforce_landlord_payout_eligibility
CREATE OR REPLACE FUNCTION public.enforce_landlord_payout_eligibility()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_record_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
BEGIN
  IF public.landlord_float_withdrawals_paused() THEN
    RAISE EXCEPTION 'Landlord float withdrawals are currently paused from Platform Controls. Try again once they are re-enabled.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  IF v_kampala_hour < 6 OR v_kampala_hour >= 22 THEN
    RAISE EXCEPTION 'Landlord payouts are only allowed between 06:00 and 22:00 Africa/Kampala.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- verified_mobile_money_number (never raw phone/mobile_money_number) is the
  -- only number Landlord Ops actually approved -- see migration 20260922150000.
  SELECT verified, verified_mobile_money_number,
         phone
    INTO v_landlord_verified, v_landlord_phone, v_record_phone
  FROM public.landlords WHERE id = NEW.landlord_id;

  IF v_landlord_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Landlord is not verified — Landlord Ops must verify the phone number first.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_landlord_phone IS NULL OR length(public.landlord_number_norm(v_landlord_phone)) < 9 THEN
    RAISE EXCEPTION 'Landlord Ops has not approved a payout number for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Structural guarantee, independent of any application code: the phone
  -- actually being paid out to must be the number Landlord Ops approved.
  -- Compared as the subscriber number (last 9 digits) so formatting
  -- ("0772 363 578" vs "0772363578" vs "+256772363578") can't block a payout,
  -- while any different number is still refused (doc 122).
  IF public.landlord_number_norm(NEW.landlord_phone) <> public.landlord_number_norm(v_landlord_phone) THEN
    RAISE EXCEPTION 'Payout phone does not match the number Landlord Ops approved for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The approved number must also be the landlord's registered phone. If it is not, the approval is stale or came from
  -- the backfill, so the payout is refused until Landlord Ops confirms which number is correct.
  IF v_record_phone IS NOT NULL
     AND length(public.landlord_number_norm(v_record_phone)) >= 9
     AND public.landlord_number_norm(NEW.landlord_phone) <> public.landlord_number_norm(v_record_phone) THEN
    RAISE EXCEPTION 'PAYOUT_NUMBER_MISMATCH: the payout number does not match the phone number registered for this landlord. Landlord Ops must confirm the correct number before a payout can be made.'
      USING ERRCODE = 'check_violation',
            HINT = 'Landlord Ops: use the Payout number review to confirm the number on the landlord record.';
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent has no landlord float account.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_float_balance < NEW.amount THEN
    RAISE EXCEPTION 'Insufficient landlord float (balance: %, requested: %).', v_float_balance, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- enforce_landlord_float_performance_gate
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

-- trg_bike_sweep_block_withdrawal_fn
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

-- require_withdrawal_pin_proof
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

-- prevent_duplicate_pending_withdrawal
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

-- get_agent_lp_float_available
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

-- deduct_agent_float_for_payout
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

-- refund_agent_float_for_payout
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

-- apply_landlord_payout_to_allocation
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

-- post_landlord_payout_finops_commission
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

-- landlord_payout_allowed_today
CREATE OR REPLACE FUNCTION public.landlord_payout_allowed_today()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(w.amount), 0)
    FROM public.withdrawal_requests w
   WHERE w.landlord_payout_id IS NOT NULL
     AND w.landlord_block_exempt_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala');
$function$;

-- landlord_payout_goal_allowed
CREATE OR REPLACE FUNCTION public.landlord_payout_goal_allowed()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT COALESCE(SUM(w.amount), 0) FROM public.withdrawal_requests w
     WHERE w.landlord_payout_id IS NOT NULL AND w.landlord_block_exempt_at >= public.landlord_payout_goal_started_at();
  $function$;

-- trg_e60_no_self_approval
CREATE OR REPLACE FUNCTION public.trg_e60_no_self_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is not null and auth.uid() = new.partner_id then
    -- Direct release: the funder releases their own float, no Partner Ops approval by design.
    if coalesce(current_setting('app.funder_direct_release', true), '') = 'on'
       and public._pipeline_switch_on('funder_direct_release') then
      return new;
    end if;
    raise exception 'E60_SELF_APPROVAL: you cannot approve your own funding. Another Partner Ops approver must approve it.' using errcode = '42501';
  end if;
  return new;
end $function$;

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
          'reference_id', l.rent_request_id::text,
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

-- funder_support_tenant_direct
CREATE OR REPLACE FUNCTION public.funder_support_tenant_direct(p_rent_request_ids uuid[], p_promised_deposit_date date DEFAULT NULL::date, p_term_months integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_total numeric := 0;
  v_capacity numeric;
  v_mode text;
  v_res jsonb;
  v_key text;
  v_commitment uuid;
  v_portfolio uuid;
  v_receivables integer := 0;
  v_released boolean := false;
  v_port_status text;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for direct tenant support' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;

  -- A plan with no assigned agent is not fundable. Checked before any claim
  -- or commitment is confirmed by this function.
  IF EXISTS (
    SELECT 1
      FROM public.rent_requests rr
     WHERE rr.id = ANY (p_rent_request_ids)
       AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NULL
  ) THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_key := 'psmd-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids, ','));

  -- Second tap: the first call already created the commitment and may already
  -- have spent the float. Replay that result instead of asking for a deposit.
  IF EXISTS (
    SELECT 1 FROM public.partner_self_commitments c
     WHERE c.partner_id = v_uid AND c.idempotency_key = v_key
  ) THEN
    v_res := public.psm_confirm_commitment_for(
      v_uid, p_rent_request_ids, p_term_months, v_key, v_uid, NULL, 'float'
    );
    v_commitment := (v_res->>'commitment_id')::uuid;
    SELECT fp.portfolio_id, ip.status
      INTO v_portfolio, v_port_status
      FROM public.funder_pending_portfolios fp
      JOIN public.investor_portfolios ip ON ip.id = fp.portfolio_id
     WHERE fp.commitment_id = v_commitment
     ORDER BY fp.created_at DESC
     LIMIT 1;

    IF public._pipeline_switch_on('funder_direct_release')
       AND v_portfolio IS NOT NULL
       AND v_port_status IN ('pending_ops_approval', 'awaiting_partner_details')
       AND NOT EXISTS (
         SELECT 1 FROM public.landlord_float_receivables r
          WHERE r.commitment_id = v_commitment AND r.status = 'outstanding'
       ) THEN
      PERFORM set_config('app.funder_direct_release', 'on', true);
      PERFORM public._approve_pending_portfolio_core(v_portfolio, v_uid);
      v_released := true;
    ELSIF v_port_status = 'active' THEN
      v_released := true;
    END IF;

    RETURN v_res || jsonb_build_object(
      'funding_mode', CASE WHEN v_released THEN 'float' ELSE 'replay' END,
      'portfolio_id', v_portfolio,
      'status', CASE WHEN v_released THEN 'active' ELSE COALESCE(v_port_status, v_res->>'status') END,
      'awaiting_ops_approval', NOT v_released,
      'landlord_float_released', v_released,
      'idempotent_replay', true
    );
  END IF;

  SELECT COALESCE(SUM(public.self_support_gross(p.funding_amount)), 0) INTO v_total
    FROM public.v_partner_self_fundable_plans p
   WHERE p.rent_request_id = ANY (p_rent_request_ids);

  v_capacity := public.funder_support_capacity(v_uid);

  IF v_total > 0 AND v_capacity >= v_total THEN
    v_mode := 'float';
  ELSE
    v_mode := 'receivable';
    IF p_promised_deposit_date IS NULL THEN
      RAISE EXCEPTION 'DEPOSIT_DATE_REQUIRED'
        USING HINT = 'Choose the date you will deposit this amount into your wallet.',
              ERRCODE = 'check_violation';
    END IF;
    IF p_promised_deposit_date < CURRENT_DATE THEN
      RAISE EXCEPTION 'DEPOSIT_DATE_IN_PAST' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM public.psm_release_cancelled_idempotency(v_uid, v_key);

  v_res := public.psm_confirm_commitment_for(
    v_uid, p_rent_request_ids, p_term_months,
    v_key,
    v_uid, NULL, v_mode
  );

  v_commitment := (v_res->>'commitment_id')::uuid;
  v_portfolio := NULLIF(v_res->>'portfolio_id', '')::uuid;

  IF COALESCE((v_res->>'idempotent_replay')::boolean, false) THEN
    RETURN v_res || jsonb_build_object('funding_mode', v_mode, 'portfolio_id', v_portfolio);
  END IF;

  IF v_mode = 'receivable' THEN
    -- Unchanged: nothing is released here. The deposit-credit trigger calls
    -- the core once the float actually covers this portfolio and the switch is ON.
    INSERT INTO public.landlord_float_receivables (
      funder_id, commitment_id, rent_request_id, landlord_id, landlord_name,
      tenant_id, agent_id, amount, promised_deposit_date, notes
    )
    SELECT v_uid, v_commitment, l.rent_request_id, rr.landlord_id, ld.name,
           rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id), l.principal,
           p_promised_deposit_date,
           'Funder supported the tenant directly with no wallet balance; deposit promised'
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
     WHERE l.commitment_id = v_commitment
    ON CONFLICT DO NOTHING;

    v_receivables := (SELECT COUNT(*) FROM public.landlord_float_receivables
                       WHERE commitment_id = v_commitment AND status = 'outstanding');

    -- Switch ON: this promise is not a Partner Ops or CFO approval. The float
    -- credit trigger releases it through the core when the deposit lands.
    IF public._pipeline_switch_on('funder_direct_release') AND v_portfolio IS NOT NULL THEN
      UPDATE public.investor_portfolios
         SET status = 'awaiting_funder_deposit'
       WHERE id = v_portfolio
         AND status IN ('pending_ops_approval', 'awaiting_partner_details');
    END IF;

    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
              'Funder pledged direct landlord float with a promised deposit date',
              jsonb_build_object('amount', v_total, 'promised_deposit_date', p_promised_deposit_date,
                                 'receivable_lines', v_receivables, 'funding_mode', 'receivable'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN v_res || jsonb_build_object(
      'funding_mode', 'receivable',
      'receivable_lines', v_receivables,
      'promised_deposit_date', p_promised_deposit_date,
      'landlord_float_released', false,
      'awaiting_ops_approval', NOT public._pipeline_switch_on('funder_direct_release')
    );
  END IF;

  IF public._pipeline_switch_on('funder_direct_release') AND v_portfolio IS NOT NULL THEN
    PERFORM set_config('app.funder_direct_release', 'on', true);
    PERFORM public._approve_pending_portfolio_core(v_portfolio, v_uid);

    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
              'Funder direct release: rent moved to the agent landlord float',
              jsonb_build_object('amount', v_total, 'funding_mode', 'float',
                                 'portfolio_id', v_portfolio, 'status', 'active',
                                 'direct_release', true));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    PERFORM public.psm_audit(v_uid, v_uid, 'direct_support_released_to_agent',
      'partner_self_commitments', v_commitment,
      jsonb_build_object('amount', v_total, 'funding_mode', 'float', 'portfolio_id', v_portfolio));

    RETURN v_res || jsonb_build_object(
      'funding_mode', 'float',
      'status', 'active',
      'awaiting_ops_approval', false,
      'from_withdrawable', 0,
      'from_float', v_total,
      'landlord_float_released', true,
      'available_balance', public.funder_float_available(v_uid)
    );
  END IF;

  -- Switch OFF: the historical Partner Ops queue. No money moves here.
  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
            'Funder submitted direct tenant support for Partner Ops vetting',
            jsonb_build_object('amount', v_total, 'funding_mode', v_mode,
                               'portfolio_id', v_portfolio, 'status', 'pending_ops_approval'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM public.psm_audit(v_uid, v_uid, 'direct_support_submitted_for_vetting',
    'partner_self_commitments', v_commitment,
    jsonb_build_object('amount', v_total, 'funding_mode', v_mode, 'portfolio_id', v_portfolio));

  RETURN v_res || jsonb_build_object(
    'funding_mode', v_mode,
    'status', 'pending_ops_approval',
    'awaiting_ops_approval', true,
    'from_withdrawable', 0,
    'from_float', 0,
    'landlord_float_released', false,
    'available_balance', public.funder_float_available(v_uid)
  );
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
                            'available_balance', public.funder_float_available(v_uid));
END;
$function$;

-- partner_support_houses__3
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric;
  v_stored numeric;
  v_key text;
  v_total numeric := 0;  -- what the partner pays: rent + the agent facilitation fee
  v_rent numeric := 0;   -- the houses' monthly rent
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || md5(array_to_string(p_house_ids,',')));

  IF NOT public.funder_has_signed_agreement(v_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psh-commit-' || v_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
      'committed_amount', v_existing.committed_amount, 'houses', v_existing.lines_count,
      'status', v_existing.status);
  END IF;

  CREATE TEMP TABLE _psh_pick ON COMMIT DROP AS
  SELECT h.id AS house_id, public.self_support_gross(h.monthly_rent::numeric) AS principal,
         h.monthly_rent::numeric AS rent_amount,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0), COALESCE(SUM(rent_amount),0)
    INTO v_count, v_total, v_rent FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_rent < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_rent)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  v_rate := public.partner_rate_now(v_partner);

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, p.rent_amount, p.principal - p.rent_amount,
           CASE WHEN p.principal > p.rent_amount THEN 'pending' END, v_rate, v_term,
         'pending', p.landlord_id, p.agent_id,
         jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key)
  FROM _psh_pick p;

  PERFORM public.psm_audit(v_partner, v_partner, 'house_support_pending_ops_approval',
    'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'houses', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'funding_tag','self_support_operational_house',
                       'idempotency_key', v_key));

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('portfolio_topup', v_partner, 'investor_portfolios', v_portfolio_id,
            'Partner submitted a verified-house self-support portfolio',
            jsonb_build_object('commitment_id', v_commitment_id, 'amount', v_total,
                               'houses', v_count, 'source','self_managed_house'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
    'committed_amount', v_total, 'houses', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'roi_percentage', v_rate,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$;

-- partner_support_houses__4
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_commitment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric;
  v_stored numeric;
  v_key text;
  v_total numeric := 0;  -- what the partner pays: rent + the agent facilitation fee
  v_rent numeric := 0;   -- the houses' monthly rent
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
  v_target public.partner_self_commitments%ROWTYPE;
  v_is_topup boolean := p_commitment_id IS NOT NULL;
  v_elig jsonb;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || COALESCE(p_commitment_id::text,'new') || '-' || md5(array_to_string(p_house_ids,',')));

  IF NOT public.funder_has_signed_agreement(v_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psh-commit-' || v_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
      'committed_amount', v_existing.committed_amount, 'houses', v_existing.lines_count,
      'status', v_existing.status);
  END IF;

  CREATE TEMP TABLE _psh_pick ON COMMIT DROP AS
  SELECT h.id AS house_id, public.self_support_gross(h.monthly_rent::numeric) AS principal,
         h.monthly_rent::numeric AS rent_amount,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0), COALESCE(SUM(rent_amount),0)
    INTO v_count, v_total, v_rent FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_rent < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_rent)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_topup THEN
    SELECT * INTO v_target FROM public.partner_self_commitments
     WHERE id = p_commitment_id AND partner_id = v_partner FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    -- A rent-plan portfolio can never absorb house capital: the flows differ.
    IF EXISTS (SELECT 1 FROM public.partner_self_funding_lines
                WHERE commitment_id = v_target.id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio funds rent plans, so houses cannot be added to it.'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT h.portfolio_id INTO v_portfolio_id FROM public.partner_supported_houses h
     WHERE h.commitment_id = v_target.id AND h.status <> 'cancelled' AND h.portfolio_id IS NOT NULL
     ORDER BY h.portfolio_id LIMIT 1;
    IF v_portfolio_id IS NULL THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio does not hold houses.'
        USING ERRCODE = 'check_violation';
    END IF;

    v_elig := public.partner_self_topup_eligibility(v_target.id);
    IF NOT (v_elig->>'allow_topup')::boolean THEN
      RAISE EXCEPTION 'PSM_TOPUP_WINDOW_CLOSED: %', COALESCE(v_elig->>'block_reason','Top-up not allowed')
        USING ERRCODE = 'check_violation';
    END IF;

    v_commitment_id := v_target.id;
    SELECT MIN(metadata->>'portfolio_code') INTO v_code FROM public.partner_supported_houses
     WHERE commitment_id = v_target.id AND status <> 'cancelled';

    -- A top-up keeps the rate stored on the portfolio (existing partners keep their rate).
    SELECT ip.roi_percentage INTO v_rate FROM public.investor_portfolios ip WHERE ip.id = v_portfolio_id;
    v_rate := COALESCE(v_rate, v_target.monthly_rate);

    INSERT INTO public.partner_supported_houses (
      partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months,
      status, landlord_id, listing_agent_id, metadata
    )
    SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, p.rent_amount, p.principal - p.rent_amount,
           CASE WHEN p.principal > p.rent_amount THEN 'pending' END,
           v_rate, COALESCE(v_target.term_months, v_term),
           'pending', p.landlord_id, p.agent_id,
           jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key, 'topup', true)
    FROM _psh_pick p;

    UPDATE public.partner_self_commitments
       SET lines_count = COALESCE(lines_count,0) + v_count, updated_at = now()
     WHERE id = v_commitment_id;

    INSERT INTO public.funder_pending_portfolios (
      portfolio_id, funder_id, amount, source, commitment_id, term_months
    ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house_topup', v_commitment_id,
              COALESCE(v_target.term_months, v_term));

    PERFORM public.psm_audit(v_partner, v_partner, 'house_support_topup_pending_ops_approval',
      'partner_self_commitments', v_commitment_id,
      jsonb_build_object('amount', v_total, 'houses', v_count, 'portfolio_id', v_portfolio_id,
                         'idempotency_key', v_key));

    RETURN jsonb_build_object(
      'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
      'topup', true, 'committed_amount', v_total, 'houses', v_count,
      'monthly_return', round(v_total * v_rate / 100),
      'roi_percentage', v_rate,
      'status', 'pending_ops_approval',
      'available_balance', public.funder_float_available(v_partner)
    );
  END IF;

  v_rate := public.partner_rate_now(v_partner);

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, p.rent_amount, p.principal - p.rent_amount,
           CASE WHEN p.principal > p.rent_amount THEN 'pending' END, v_rate, v_term,
         'pending', p.landlord_id, p.agent_id,
         jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key)
  FROM _psh_pick p;

  PERFORM public.psm_audit(v_partner, v_partner, 'house_support_pending_ops_approval',
    'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'houses', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'funding_tag','self_support_operational_house',
                       'idempotency_key', v_key));

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('portfolio_topup', v_partner, 'investor_portfolios', v_portfolio_id,
            'Partner submitted a verified-house self-support portfolio',
            jsonb_build_object('commitment_id', v_commitment_id, 'amount', v_total,
                               'houses', v_count, 'source','self_managed_house'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
    'committed_amount', v_total, 'houses', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'roi_percentage', v_rate,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$;

-- funder_release_sms_dispatch
CREATE OR REPLACE FUNCTION public.funder_release_sms_dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.funder_release_sms
     WHERE status = 'pending' AND attempts < 4
  ) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
   WHERE name = 'email_queue_service_role_key'
   LIMIT 1;

  IF v_key IS NULL OR btrim(v_key) = '' THEN
    RAISE WARNING 'funder release sms dispatch skipped: email_queue_service_role_key is not in vault';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-funder-release-sms',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'funder release sms dispatch failed: %', SQLERRM;
END;
$function$;


DROP FUNCTION IF EXISTS public.self_support_my_landlord_payments(integer);
DROP FUNCTION IF EXISTS public.self_support_staff_resolve(uuid, text, text);
DROP FUNCTION IF EXISTS public.ssd_expire_unpaid(integer);
DROP FUNCTION IF EXISTS public.trg_ssd_landlord_payout_status();
DROP FUNCTION IF EXISTS public.trg_ssd_landlord_paid_notify();
DROP FUNCTION IF EXISTS public._ssd_house_instant(uuid);
DROP FUNCTION IF EXISTS public._ssd_refund(uuid, text);
DROP FUNCTION IF EXISTS public._ssd_activate(uuid);
DROP FUNCTION IF EXISTS public._ssd_settle_commitment(uuid);
DROP FUNCTION IF EXISTS public._ssd_queue_plan(uuid);
DROP FUNCTION IF EXISTS public._ssd_queue_commitment(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._ssd_notify(uuid, text);
DROP FUNCTION IF EXISTS public._ssd_notice(text, uuid, text, text, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public._ssd_support_result(uuid, uuid);
DROP FUNCTION IF EXISTS public._ssd_plan_result(uuid);
DROP FUNCTION IF EXISTS public._ssd_payment_json(uuid);
DROP FUNCTION IF EXISTS public._ssd_plan_queued(uuid, numeric);
DROP FUNCTION IF EXISTS public._ssd_portfolio_queued(uuid);
DROP FUNCTION IF EXISTS public._ssd_first(text);
DROP FUNCTION IF EXISTS public._ssd_momo_provider(text, boolean);
DROP FUNCTION IF EXISTS public._ssd_wr_insert_is_direct(uuid);
DROP FUNCTION IF EXISTS public._ssd_inserting();
DROP FUNCTION IF EXISTS public._ssd_payout_is_direct(uuid);
DROP FUNCTION IF EXISTS public._ssd_day_start(date);
DROP FUNCTION IF EXISTS public._ssd_earning_date();
DROP FUNCTION IF EXISTS public._ssd_debit_ref(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._ssd_on();
-- the tables keep their history; drop them only once nobody needs the record
-- DROP TABLE public.self_support_notices; DROP TABLE public.self_support_landlord_payments;
-- index names are schema-wide: move them aside too, so the migration can be applied again
DO $r$ DECLARE i record; BEGIN
  FOR i IN SELECT c.relname FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
            WHERE x.indrelid IN ('public.self_support_landlord_payments'::regclass, 'public.self_support_notices'::regclass) LOOP
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', i.relname, left(i.relname, 40) || '_r20261117120000');
  END LOOP;
END $r$;
ALTER TABLE public.self_support_landlord_payments RENAME TO self_support_landlord_payments_retired_20261117120000;
ALTER TABLE public.self_support_notices RENAME TO self_support_notices_retired_20261117120000;

ALTER TABLE public.partner_self_commitments DROP CONSTRAINT partner_self_commitments_status_check;
ALTER TABLE public.partner_self_commitments ADD CONSTRAINT partner_self_commitments_status_check
  CHECK (status = ANY (ARRAY['pending_ops_approval'::text, 'active'::text, 'matured'::text, 'cancelled'::text]));
DELETE FROM public.pipeline_switches WHERE key = 'self_support_merchant_direct';
