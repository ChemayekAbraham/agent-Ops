CREATE OR REPLACE FUNCTION public.trg_welile_home_auto_collect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sub uuid;
  v_out numeric;
  v_avail numeric;
  v_amt numeric;
BEGIN
  IF NEW.event_type NOT IN ('deposit_approved','funds_added') THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  SELECT id, outstanding_balance
  INTO v_sub, v_out
  FROM public.welile_homes_subscriptions
  WHERE tenant_id = NEW.user_id
    AND mode = 'agent_collection'
    AND subscription_status = 'active'
    AND outstanding_balance > 0
  ORDER BY next_due_date NULLS LAST
  LIMIT 1;

  IF v_sub IS NULL THEN RETURN NEW; END IF;

  SELECT GREATEST(0, COALESCE(total_visible, 0))
  INTO v_avail
  FROM public.wallet_strict_for_user(NEW.user_id);

  v_amt := LEAST(COALESCE(v_out, 0), COALESCE(v_avail, 0));
  IF v_amt > 0 THEN
    PERFORM public.welile_home_record_collection(v_sub, v_amt, 'tenant_wallet', 'Auto-collected on deposit');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Best-effort only: never block the deposit event.
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.welile_home_record_collection(p_subscription_id uuid, p_amount numeric, p_source text DEFAULT 'tenant_wallet'::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid;
  v_agent_id uuid;
  v_landlord_id uuid;
  v_outstanding numeric;
  v_monthly_rent numeric;
  v_cap numeric;
  v_agent_comm numeric;
  v_remaining numeric;
  v_take numeric;
  v_room numeric;
  v_due record;
  v_legs jsonb;
  v_txn uuid;
  v_key text;
  v_strict_float numeric := 0;
  v_tenant_avail numeric := 0;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;
  IF p_source NOT IN ('tenant_wallet','agent_allocation') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid source');
  END IF;

  SELECT tenant_id, agent_id, landlord_id, outstanding_balance, monthly_rent
  INTO v_tenant_id, v_agent_id, v_landlord_id, v_outstanding, v_monthly_rent
  FROM public.welile_homes_subscriptions
  WHERE id = p_subscription_id AND mode = 'agent_collection';

  IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Welile Homes subscription not found');
  END IF;
  IF COALESCE(v_outstanding, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'No outstanding balance to collect');
  END IF;

  v_cap := LEAST(p_amount, v_outstanding);

  -- Source-specific balance guards
  IF p_source = 'tenant_wallet' THEN
    SELECT GREATEST(0, COALESCE(total_visible, 0)) INTO v_tenant_avail
    FROM public.wallet_strict_for_user(v_tenant_id);
    IF v_tenant_avail < v_cap THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_TENANT_BALANCE',
        'error', format('Tenant wallet balance (%s) is less than the amount to collect (%s)', v_tenant_avail, v_cap));
    END IF;
  ELSE
    IF v_agent_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'No managing agent for allocation');
    END IF;
    SELECT GREATEST(0, COALESCE(float_balance, 0)) INTO v_strict_float
    FROM public.wallet_strict_for_user(v_agent_id);
    IF v_strict_float < v_cap THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_FLOAT',
        'error', format('Agent float (%s) is less than the amount to allocate (%s)', v_strict_float, v_cap));
    END IF;
  END IF;

  v_agent_comm := round(v_cap * 0.02, 2);

  v_key := format('welile_home_collect:%s:%s:%s:%s:%s',
    p_subscription_id, p_source, v_cap, extract(epoch from clock_timestamp())::text, gen_random_uuid()::text);

  IF p_source = 'tenant_wallet' THEN
    v_legs := jsonb_build_array(
      jsonb_build_object('user_id',v_tenant_id,'amount',v_cap,'direction','cash_out','category','rent_repayment','ledger_scope','wallet','classification','production','description','Welile Homes rent collected from tenant wallet','linked_party',v_landlord_id,'source_table','welile_homes_monthly_dues','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_tenant_id,'amount',v_cap,'direction','cash_in','category','rent_repayment','ledger_scope','platform','classification','production','description','Welile Homes rent received','linked_party',v_landlord_id,'source_table','welile_homes_subscriptions','source_id',p_subscription_id)
    );
  ELSE
    v_legs := jsonb_build_array(
      jsonb_build_object('user_id',v_agent_id,'amount',v_cap,'direction','cash_out','category','rent_payment_for_tenant','ledger_scope','wallet','classification','production','description','Welile Homes rent allocated from agent float','linked_party',v_landlord_id,'recipient_type','operational_wallet','source_table','welile_homes_monthly_dues','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_agent_id,'amount',v_cap,'direction','cash_in','category','rent_repayment','ledger_scope','platform','classification','production','description','Welile Homes rent received (agent-allocated)','linked_party',v_landlord_id,'source_table','welile_homes_subscriptions','source_id',p_subscription_id)
    );
  END IF;

  -- Agent 2% commission (out of Welile's 10%)
  IF v_agent_id IS NOT NULL AND v_agent_comm > 0 THEN
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object('user_id',v_agent_id,'amount',v_agent_comm,'direction','cash_out','category','agent_commission_payable','ledger_scope','platform','classification','production','description','Welile Homes 2% agent commission (platform)','source_table','welile_homes_subscriptions','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_agent_id,'amount',v_agent_comm,'direction','cash_in','category','agent_commission_earned','ledger_scope','wallet','classification','production','description','Welile Homes 2% agent commission','recipient_type','user','source_table','welile_homes_subscriptions','source_id',p_subscription_id)
    );
  END IF;

  v_txn := public.create_ledger_transaction(v_legs, v_key, true);

  -- Apply collected amount to earliest open dues (FIFO)
  v_remaining := v_cap;
  FOR v_due IN
    SELECT id, amount_due, amount_collected
    FROM public.welile_homes_monthly_dues
    WHERE subscription_id = p_subscription_id AND collection_status <> 'collected'
    ORDER BY period_month
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_room := v_due.amount_due - v_due.amount_collected;
    IF v_room <= 0 THEN CONTINUE; END IF;
    v_take := LEAST(v_remaining, v_room);
    UPDATE public.welile_homes_monthly_dues
    SET amount_collected = amount_collected + v_take,
        collection_status = CASE WHEN amount_collected + v_take >= amount_due THEN 'collected' ELSE 'partial' END,
        ledger_transaction_id = COALESCE(ledger_transaction_id, v_txn),
        updated_at = now()
    WHERE id = v_due.id;
    v_remaining := v_remaining - v_take;
  END LOOP;

  UPDATE public.welile_homes_subscriptions
  SET outstanding_balance = GREATEST(0, outstanding_balance - v_cap),
      next_due_date = (SELECT min(payout_date) FROM public.welile_homes_monthly_dues
                       WHERE subscription_id = p_subscription_id AND collection_status <> 'collected'),
      updated_at = now()
  WHERE id = p_subscription_id;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('payment_made', v_tenant_id, 'welile_homes_subscription', p_subscription_id,
      jsonb_build_object('action','collection','source',p_source,'amount',v_cap,'agent_commission',v_agent_comm,'txn',v_txn));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_group', v_txn,
    'amount_collected', v_cap,
    'agent_commission', v_agent_comm,
    'source', p_source
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_available numeric := 0;
  v_float numeric := 0;
  v_current_hold numeric := 0;
  v_effective_bucket text := 'withdrawable';
  v_is_admin_bypass boolean := false;
  v_is_writeoff_bypass boolean := false;
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.direction NOT IN ('cash_out', 'debit') THEN
    RETURN NEW;
  END IF;

  v_is_admin_bypass := COALESCE(NEW.classification, '') = 'admin_correction';
  v_is_writeoff_bypass := COALESCE(NEW.category, '') = 'platform_loss_writeoff';

  IF v_is_admin_bypass OR v_is_writeoff_bypass THEN
    IF NEW.solvency_bypass_reason IS NULL THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_REASON_REQUIRED: cash_out leg classified % / category % must include a solvency_bypass_reason code',
        COALESCE(NEW.classification, '(null)'), COALESCE(NEW.category, '(null)')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.solvency_bypass_reason = 'other_with_note'
       AND length(COALESCE(NEW.description, '')) < 30 THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_NOTE_REQUIRED: reason code other_with_note requires a description of at least 30 characters'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.category, '') = 'system_balance_correction' THEN
    RETURN NEW;
  END IF;

  v_effective_bucket := COALESCE(
    NULLIF(NEW.wallet_bucket, ''),
    CASE
      WHEN NEW.recipient_type = 'operational_wallet' THEN 'float'
      WHEN NEW.recipient_type = 'user' THEN 'withdrawable'
      ELSE NULL
    END,
    (
      SELECT r.bucket
      FROM public.wallet_route_for_category(NEW.user_id, NEW.category, NEW.direction) r
      LIMIT 1
    ),
    'withdrawable'
  );

  -- Float / operational-wallet debits: use the maintained projection cache
  -- (indexed PK lookup, sub-millisecond) instead of recomputing the strict
  -- view from the full ledger on every insert. The projection is updated by
  -- trg_wallet_projection_ledger and reflects the same numbers as
  -- v_user_wallet_strict for float. If a projection row is missing (new
  -- user), fall back to the fast per-user calculator for correctness.
  IF v_effective_bucket = 'float'
     OR COALESCE(NEW.recipient_type, '') = 'operational_wallet' THEN
    SELECT float_balance INTO v_float
    FROM public.wallet_balances_projection
    WHERE user_id = NEW.user_id;

    IF v_float IS NULL THEN
      SELECT COALESCE(float_balance, 0) INTO v_float
      FROM public.wallet_strict_for_user(NEW.user_id);
    END IF;

    IF COALESCE(v_float, 0) < NEW.amount THEN
      RAISE EXCEPTION 'NEGATIVE_FLOAT_BLOCKED: user % cannot debit % from float (ledger-backed float balance is %)',
        NEW.user_id, NEW.amount, COALESCE(v_float, 0)
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_table = 'withdrawal_requests' AND NEW.source_id IS NOT NULL THEN
    SELECT COALESCE(wr.amount, 0)
      INTO v_current_hold
    FROM public.withdrawal_requests wr
    WHERE wr.id = NEW.source_id
      AND wr.status IN ('pending', 'requested', 'manager_approved', 'processing', 'approved')
      AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
      AND (
        CASE
          WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
          ELSE wr.user_id
        END
      ) = NEW.user_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.general_ledger g
        WHERE g.source_table = 'withdrawal_requests'
          AND g.source_id = wr.id
          AND g.ledger_scope = 'wallet'
          AND g.direction IN ('cash_out', 'debit')
      )
    LIMIT 1;
  END IF;

  v_available := COALESCE(public.get_user_available_balance(NEW.user_id), 0) + COALESCE(v_current_hold, 0);

  IF v_available < NEW.amount THEN
    RAISE EXCEPTION 'LEDGER_BACKING_REQUIRED: user % cannot debit % from withdrawable funds (ledger-backed available is %)',
      NEW.user_id, NEW.amount, v_available
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;