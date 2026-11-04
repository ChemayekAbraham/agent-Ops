-- Stop six SECURITY DEFINER functions from
-- INSERT INTO public.wallets ... ON CONFLICT (user_id).
--
-- public.wallets is a view (wallets_physical LEFT JOIN wallet_balances_projection).
-- A view cannot satisfy ON CONFLICT, so every one of these inserts raises 42P10.
--
-- wallets_physical NOT NULL columns (production, checked 2026-10-27):
--   id, created_at, updated_at, locked_balance  — defaults (gen_random_uuid / now / 0)
--   user_id                                      — no default; supplied by the insert
--   currency                                     — NOT NULL, default 'UGX'; set explicitly
--   there is no balance column. Do not write one.
--
-- Ensure-row inserts (ON CONFLICT DO NOTHING) now target
--   public.wallets_physical (user_id, currency) VALUES (…, 'UGX')
--   ON CONFLICT (user_id) DO NOTHING.
--
-- credit_agent_rent_commission(uuid, numeric, text, uuid) and
-- sync_agent_wallet_on_earning() used ON CONFLICT DO UPDATE to add to
-- wallets.balance. That write is removed. No create_ledger_transaction or
-- apply_wallet_movement call is added in its place: apply_wallet_movement
-- only ensures a physical row, and a second ledger RPC is not a safe
-- equivalent of the old balance add (TODO in each function).
--
-- credit_agent_rent_commission(uuid, numeric, text, uuid) also dropped its
-- two direct general_ledger inserts (category agent_commission), one for the
-- collector and one in the override loop. Each agent_earnings insert already
-- fires trg_agent_earning_to_ledger → log_agent_earning_to_ledger, which
-- posts that cash_in for every earning_type except referral_bonus. commission
-- and subagent_commission are covered. Keeping the function's own insert
-- would land a second cash_in once the 42P10 rollback is gone.
-- Notifications and the jsonb return shape are unchanged.
-- sync_agent_wallet_on_earning still skips referral_bonus, commission and
-- subagent_commission, so it does not also credit those rows.
--
-- CREATE OR REPLACE only. No GRANT, REVOKE, RLS, index, or trigger change.
-- Existing EXECUTE grants stay (CREATE OR REPLACE keeps them).
--
-- agent_deposit_to_partner keeps PERFORM public.require_staff_aal2() as its
-- first statement. That call is in the live body, injected by
-- 20261022130000_staff_mfa_phase2_function_checks.sql, and is absent from the
-- latest defining migration (20260807220054). Replacing from that file alone
-- would drop the staff MFA check.
--
-- Bodies otherwise come from the latest migration that defines each function:
--   agent_deposit_to_partner                         20260807220054
--   credit_agent_rent_commission(uuid,numeric,text,uuid)  20260707104642
--   backfill_missing_profile_by_email                20260429092121
--   recompute_wallet_buckets                         20260417133735
--   sync_agent_wallet_on_earning                     20260306042342
--   auto_route_rent_funds                            20260210121954
-- The other overload, credit_agent_rent_commission(uuid, numeric, uuid, text),
-- does not insert into wallets and is not replaced.

CREATE OR REPLACE FUNCTION public.agent_deposit_to_partner(p_agent_id uuid, p_partner_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_balance NUMERIC;
  v_partner_balance NUMERIC;
  v_txn_group UUID := gen_random_uuid();
  v_tracking_id TEXT;
  v_agent_name TEXT;
  v_partner_name TEXT;
  v_commission NUMERIC;
BEGIN
  PERFORM public.require_staff_aal2();
  IF auth.uid() IS DISTINCT FROM p_agent_id THEN
    RAISE EXCEPTION 'not_authorized: caller must be the agent making the deposit';
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  IF p_agent_id = p_partner_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot deposit to yourself');
  END IF;

  SELECT balance INTO v_agent_balance FROM wallets WHERE user_id = p_agent_id;
  IF v_agent_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Agent wallet not found');
  END IF;
  IF v_agent_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Insufficient balance. Available: %s', v_agent_balance));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM proxy_agent_assignments
    WHERE agent_id = p_agent_id AND beneficiary_id = p_partner_id
      AND is_active = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active proxy relationship with this partner');
  END IF;

  SELECT full_name INTO v_agent_name FROM profiles WHERE id = p_agent_id;
  SELECT full_name INTO v_partner_name FROM profiles WHERE id = p_partner_id;

  v_tracking_id := 'PDEP-' || UPPER(SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 8));
  -- 1% commission to the proxy agent on every partner deposit
  v_commission := ROUND(p_amount * 0.01);

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  -- Leg 1: Deduct from agent wallet
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_agent_id, p_amount, 'cash_out', 'wallet_transfer', 'proxy_agent_assignments', v_tracking_id,
    format('Deposit to partner %s — %s', v_partner_name, COALESCE(p_notes, v_tracking_id)),
    'wallet', v_txn_group, 'UGX', p_partner_id);

  -- Leg 2: Credit partner wallet
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_partner_id, p_amount, 'cash_in', 'wallet_transfer', 'proxy_agent_assignments', v_tracking_id,
    format('Deposit from agent %s — %s', v_agent_name, COALESCE(p_notes, v_tracking_id)),
    'wallet', v_txn_group, 'UGX', p_agent_id);

  IF v_commission > 0 THEN
    -- Leg 3: Agent commission credit (wallet scope → routes to withdrawable)
    INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
    VALUES (p_agent_id, v_commission, 'cash_in', 'partner_commission', 'proxy_agent_assignments', v_tracking_id,
      format('1%% commission on %s deposit to %s', p_amount, v_partner_name),
      'wallet', v_txn_group, 'UGX', p_partner_id);

    -- Leg 4: Platform expense (platform scope — reduces money we have)
    INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
    VALUES (p_agent_id, v_commission, 'cash_out', 'partner_commission', 'proxy_agent_assignments', v_tracking_id,
      format('Partner commission expense: 1%% of %s for deposit to %s', p_amount, v_partner_name),
      'platform', v_txn_group, 'UGX', p_partner_id);
  END IF;

  -- Update wallet balances (keep aggregate + withdrawable bucket cache in sync with ledger truth)
  UPDATE wallets
     SET balance = balance - p_amount + v_commission,
         withdrawable_balance = COALESCE(withdrawable_balance, 0) - p_amount + v_commission,
         updated_at = NOW()
   WHERE user_id = p_agent_id;

  INSERT INTO public.wallets_physical (user_id, currency)
  VALUES (p_partner_id, 'UGX')
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE wallets
     SET balance = balance + p_amount,
         withdrawable_balance = COALESCE(withdrawable_balance, 0) + p_amount,
         updated_at = NOW()
   WHERE user_id = p_partner_id;

  SELECT balance INTO v_agent_balance FROM wallets WHERE user_id = p_agent_id;
  SELECT balance INTO v_partner_balance FROM wallets WHERE user_id = p_partner_id;

  -- Audit log
  INSERT INTO system_events (event_type, actor_id, target_id, metadata)
  VALUES ('partner_commission_earned', p_agent_id, p_partner_id,
    jsonb_build_object(
      'deposit_amount', p_amount,
      'commission', v_commission,
      'commission_rate', 0.01,
      'tracking_id', v_tracking_id,
      'partner_name', v_partner_name,
      'txn_group_id', v_txn_group
    ));

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'tracking_id', v_tracking_id,
    'agent_balance_after', v_agent_balance,
    'partner_balance_after', v_partner_balance,
    'partner_name', v_partner_name,
    'txn_group_id', v_txn_group,
    'commission_earned', v_commission
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.backfill_missing_profile_by_email(_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user RECORD;
  v_full_name text;
  v_phone text;
  v_signup_source text;
  v_funder_ref text;
  v_existing uuid;
  v_phone_taken_by uuid;
  v_phone_used text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'manager') THEN
    RAISE EXCEPTION 'Only managers can backfill profiles';
  END IF;

  SELECT id, email, raw_user_meta_data, created_at
    INTO v_user
  FROM auth.users
  WHERE lower(email) = lower(trim(_email))
  LIMIT 1;

  IF v_user.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'auth_user_not_found');
  END IF;

  SELECT id INTO v_existing FROM public.profiles WHERE id = v_user.id;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'profile_already_exists', 'user_id', v_user.id);
  END IF;

  v_full_name     := COALESCE(NULLIF(v_user.raw_user_meta_data->>'full_name',''), split_part(v_user.email,'@',1));
  v_phone         := COALESCE(NULLIF(v_user.raw_user_meta_data->>'phone',''), '');
  v_signup_source := NULLIF(v_user.raw_user_meta_data->>'signup_source','');

  IF v_signup_source = 'funder-onboarding' THEN
    v_funder_ref := public.build_funder_reference(v_user.id, v_user.created_at);
  ELSE
    v_funder_ref := NULL;
  END IF;

  -- Detect phone collision and substitute a deterministic placeholder so the row can be created
  v_phone_used := v_phone;
  IF v_phone IS NOT NULL AND length(v_phone) > 0 THEN
    SELECT id INTO v_phone_taken_by
    FROM public.profiles
    WHERE normalize_phone_last9(phone) = normalize_phone_last9(v_phone)
    LIMIT 1;
    IF v_phone_taken_by IS NOT NULL THEN
      v_phone_used := 'orphan-' || substring(v_user.id::text, 1, 8) || '@welile.user';
    END IF;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, phone, signup_source, funder_reference)
  VALUES (v_user.id, v_user.email, v_full_name, v_phone_used, v_signup_source, v_funder_ref);

  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user.id, 'supporter')
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.wallets_physical (user_id, currency)
  VALUES (v_user.id, 'UGX')
  ON CONFLICT (user_id) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'reason', 'profile_backfilled',
    'user_id', v_user.id,
    'signup_source', v_signup_source,
    'funder_reference', v_funder_ref,
    'phone_substituted', v_phone_used IS DISTINCT FROM v_phone,
    'phone_taken_by', v_phone_taken_by
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_route_rent_funds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rent_request RECORD;
  v_landlord RECORD;
  v_recipient_user_id UUID;
  v_recipient_type TEXT;
  v_recipient_name TEXT;
  v_caretaker_profile RECORD;
  v_landlord_profile RECORD;
  v_agent_profile RECORD;
BEGIN
  -- Only trigger when status changes to 'verified'
  IF NEW.status = 'verified' AND (OLD.status IS DISTINCT FROM 'verified') THEN

    -- Get the rent request
    SELECT * INTO v_rent_request FROM public.rent_requests WHERE id = NEW.rent_request_id;
    IF v_rent_request IS NULL THEN RETURN NEW; END IF;

    -- Get the landlord record
    SELECT * INTO v_landlord FROM public.landlords WHERE id = NEW.landlord_id;
    IF v_landlord IS NULL THEN RETURN NEW; END IF;

    -- Strategy 1: Check if landlord has a user account (match by phone)
    SELECT id, full_name INTO v_landlord_profile
    FROM public.profiles
    WHERE normalize_phone_last9(phone) = normalize_phone_last9(v_landlord.phone)
    LIMIT 1;

    IF v_landlord_profile.id IS NOT NULL AND v_landlord.has_smartphone IS NOT FALSE THEN
      v_recipient_user_id := v_landlord_profile.id;
      v_recipient_type := 'landlord';
      v_recipient_name := v_landlord.name;

    -- Strategy 2: Check if caretaker has a user account
    ELSIF v_landlord.caretaker_phone IS NOT NULL THEN
      SELECT id, full_name INTO v_caretaker_profile
      FROM public.profiles
      WHERE normalize_phone_last9(phone) = normalize_phone_last9(v_landlord.caretaker_phone)
      LIMIT 1;

      IF v_caretaker_profile.id IS NOT NULL THEN
        v_recipient_user_id := v_caretaker_profile.id;
        v_recipient_type := 'caretaker';
        v_recipient_name := COALESCE(v_landlord.caretaker_name, v_caretaker_profile.full_name);
      END IF;
    END IF;

    -- Strategy 3: Fall back to the agent who verified/registered
    IF v_recipient_user_id IS NULL THEN
      -- Try the agent from the rent request first
      IF v_rent_request.agent_id IS NOT NULL THEN
        SELECT full_name INTO v_agent_profile FROM public.profiles WHERE id = v_rent_request.agent_id;
        v_recipient_user_id := v_rent_request.agent_id;
        v_recipient_type := 'agent';
        v_recipient_name := COALESCE(v_agent_profile.full_name, 'Agent');
      -- Then try the landlord's registered_by
      ELSIF v_landlord.registered_by IS NOT NULL THEN
        SELECT full_name INTO v_agent_profile FROM public.profiles WHERE id = v_landlord.registered_by;
        v_recipient_user_id := v_landlord.registered_by;
        v_recipient_type := 'agent';
        v_recipient_name := COALESCE(v_agent_profile.full_name, 'Agent');
      END IF;
    END IF;

    -- If we found a recipient, credit their wallet
    IF v_recipient_user_id IS NOT NULL THEN
      -- Ensure wallet exists
      INSERT INTO public.wallets_physical (user_id, currency)
      VALUES (v_recipient_user_id, 'UGX')
      ON CONFLICT (user_id) DO NOTHING;

      -- Credit the wallet
      UPDATE public.wallets
      SET balance = balance + NEW.amount, updated_at = now()
      WHERE user_id = v_recipient_user_id;

      -- Update rent request with routing info
      UPDATE public.rent_requests
      SET fund_recipient_type = v_recipient_type,
          fund_recipient_id = v_recipient_user_id,
          fund_recipient_name = v_recipient_name,
          fund_routed_at = now()
      WHERE id = NEW.rent_request_id;

      -- Notify the recipient
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        v_recipient_user_id,
        '💰 Rent Funds Received!',
        'UGX ' || NEW.amount::text || ' rent payment for ' ||
          CASE v_recipient_type
            WHEN 'landlord' THEN 'your property'
            WHEN 'caretaker' THEN 'the property you manage'
            WHEN 'agent' THEN 'your landlord''s property (landlord not on platform)'
          END || ' has been deposited to your wallet.',
        'success',
        jsonb_build_object(
          'amount', NEW.amount,
          'rent_request_id', NEW.rent_request_id,
          'recipient_type', v_recipient_type
        )
      );

      -- Notify tenant about fund routing
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        v_rent_request.tenant_id,
        '🏠 Rent Payment Routed!',
        'Your rent of UGX ' || NEW.amount::text || ' has been sent to ' || v_recipient_name ||
          ' (' || v_recipient_type || ').',
        'success',
        jsonb_build_object(
          'recipient_type', v_recipient_type,
          'recipient_name', v_recipient_name,
          'amount', NEW.amount
        )
      );

      -- Notify all managers
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      SELECT
        ur.user_id,
        '📋 Funds Routed: ' || v_recipient_type,
        'UGX ' || NEW.amount::text || ' routed to ' || v_recipient_name || ' (' || v_recipient_type || ') for rent request.',
        'info',
        jsonb_build_object(
          'rent_request_id', NEW.rent_request_id,
          'recipient_type', v_recipient_type,
          'recipient_id', v_recipient_user_id,
          'amount', NEW.amount
        )
      FROM public.user_roles ur
      WHERE ur.role = 'manager' AND ur.enabled = true;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_wallet_buckets(p_user_id uuid)
 RETURNS TABLE(withdrawable numeric, float_bal numeric, advance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_w numeric := 0;
  v_f numeric := 0;
  v_a numeric := 0;
  r record;
  v_route record;
  v_recover numeric;
BEGIN
  FOR r IN
    SELECT category, direction, amount
    FROM public.general_ledger
    WHERE user_id = p_user_id AND ledger_scope = 'wallet'
    ORDER BY created_at ASC, id ASC
  LOOP
    SELECT * INTO v_route FROM public.wallet_route_for_category(r.category, r.direction);
    IF v_route.bucket = 'withdrawable' AND v_route.sign = 1 THEN
      v_recover := LEAST(r.amount, v_a);
      v_a := v_a - v_recover;
      v_w := v_w + (r.amount - v_recover);
    ELSIF v_route.bucket = 'withdrawable' AND v_route.sign = -1 THEN
      v_w := v_w - r.amount;
    ELSIF v_route.bucket = 'float' AND v_route.sign = 1 THEN
      v_f := v_f + r.amount;
    ELSIF v_route.bucket = 'float' AND v_route.sign = -1 THEN
      v_f := v_f - r.amount;
    ELSIF v_route.bucket = 'advance_credit' THEN
      v_w := v_w + r.amount;
      v_a := v_a + r.amount;
    ELSIF v_route.bucket = 'advance_repayment' THEN
      v_w := v_w - r.amount;
      v_a := GREATEST(0, v_a - r.amount);
    END IF;
  END LOOP;

  v_w := GREATEST(0, v_w);
  v_f := GREATEST(0, v_f);
  v_a := GREATEST(0, v_a);

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  INSERT INTO public.wallets_physical (user_id, currency)
  VALUES (p_user_id, 'UGX')
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.wallets
    SET withdrawable_balance = v_w,
        float_balance = v_f,
        advance_balance = v_a,
        balance = v_w + v_f,
        updated_at = now()
    WHERE user_id = p_user_id;

  RETURN QUERY SELECT v_w, v_f, v_a;
END;
$function$;

-- Overload (uuid, numeric, text, uuid) only. The (uuid, numeric, uuid, text)
-- overload already posts through create_ledger_transaction and does not touch wallets.
-- p_source_table and p_source_id stay on this signature. They are not read:
-- the cash_in is the agent_earnings trigger (source_table agent_earnings).
CREATE OR REPLACE FUNCTION public.credit_agent_rent_commission(
  p_rent_request_id uuid,
  p_repayment_amount numeric,
  p_source_table text DEFAULT 'rent_requests'::text,
  p_source_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id UUID;
  v_tenant_id UUID;
  v_direct_parent UUID;
  v_commission NUMERIC;
  v_override_amount NUMERIC;
  v_is_sub_agent BOOLEAN := FALSE;
  v_commission_rate NUMERIC := 0.05;
  v_current_child UUID;
  v_current_parent UUID;
  v_depth INT := 0;
  v_max_depth CONSTANT INT := 5;
  v_override_rate NUMERIC;
  v_overrides_paid JSONB := '[]'::jsonb;
BEGIN
  SELECT COALESCE(assigned_agent_id, agent_id), tenant_id
  INTO v_agent_id, v_tenant_id
  FROM rent_requests
  WHERE id = p_rent_request_id;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_agent');
  END IF;

  -- Only an ACCEPTED (verified) parent link makes the collector a sub-agent.
  SELECT sa.parent_agent_id INTO v_direct_parent
  FROM agent_subagents sa
  WHERE sa.sub_agent_id = v_agent_id
    AND sa.status = 'verified'
  ORDER BY sa.created_at ASC
  LIMIT 1;

  IF v_direct_parent IS NOT NULL THEN
    v_is_sub_agent := TRUE;
    v_commission_rate := 0.04;
  END IF;

  v_commission := ROUND(p_repayment_amount * v_commission_rate);

  IF v_commission <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'zero_commission');
  END IF;

  INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
  VALUES (
    v_agent_id, v_commission, 'commission', v_tenant_id, p_rent_request_id,
    (v_commission_rate * 100)::TEXT || '% commission on UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999')) || ' rent repayment'
  );

  -- The collector cash_in is log_agent_earning_to_ledger on the
  -- agent_earnings insert above (earning_type commission). Do not insert
  -- general_ledger here as well: that was a second agent_commission cash_in.
  -- TODO(wallets-42p10): the old ON CONFLICT DO UPDATE added v_commission to
  -- wallets.balance (42P10; balance is not a wallets_physical column).
  -- apply_wallet_movement only ensures a physical row. Ensure the row only.
  INSERT INTO public.wallets_physical (user_id, currency)
  VALUES (v_agent_id, 'UGX')
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO notifications (user_id, title, message, type, metadata)
  VALUES (
    v_agent_id, 'Commission Earned! 💰',
    'You earned UGX ' || TRIM(TO_CHAR(v_commission, '999,999,999')) || ' (' || (v_commission_rate * 100)::TEXT || '%) from rent repayment. Credited automatically.',
    'earning',
    jsonb_build_object('amount', v_commission, 'type', 'commission', 'rent_request_id', p_rent_request_id)
  );

  v_current_child := v_agent_id;

  WHILE v_depth < v_max_depth LOOP
    -- Only walk ACCEPTED (verified) upline links.
    SELECT sa.parent_agent_id INTO v_current_parent
    FROM agent_subagents sa
    WHERE sa.sub_agent_id = v_current_child
      AND sa.status = 'verified'
    ORDER BY sa.created_at ASC
    LIMIT 1;

    EXIT WHEN v_current_parent IS NULL;
    EXIT WHEN v_current_parent = v_agent_id;

    v_depth := v_depth + 1;

    v_override_rate := CASE v_depth
      WHEN 1 THEN 0.01
      WHEN 2 THEN 0.005
      WHEN 3 THEN 0.0025
      WHEN 4 THEN 0.001
      WHEN 5 THEN 0.0005
      ELSE 0
    END;

    v_override_amount := ROUND(p_repayment_amount * v_override_rate);

    IF v_override_amount > 0 THEN
      INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
      VALUES (
        v_current_parent, v_override_amount, 'subagent_commission', v_tenant_id, p_rent_request_id,
        (v_override_rate * 100)::TEXT || '% L' || v_depth || ' override from sub-agent tenant repayment of UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999'))
      );

      -- The override cash_in is log_agent_earning_to_ledger on the
      -- subagent_commission earning above. No second general_ledger insert.
      -- TODO(wallets-42p10): ensure the physical row only; do not add
      -- v_override_amount onto wallets.balance.
      INSERT INTO public.wallets_physical (user_id, currency)
      VALUES (v_current_parent, 'UGX')
      ON CONFLICT (user_id) DO NOTHING;

      INSERT INTO notifications (user_id, title, message, type)
      VALUES (
        v_current_parent,
        CASE WHEN v_depth = 1 THEN 'Sub-Agent Commission 💰' ELSE 'Downline Commission 💰' END,
        'You earned UGX ' || TRIM(TO_CHAR(v_override_amount, '999,999,999')) || ' (' || (v_override_rate * 100)::TEXT || '% L' || v_depth || ' override) from a downline sub-agent''s tenant repayment.',
        'earning'
      );

      v_overrides_paid := v_overrides_paid || jsonb_build_object(
        'level', v_depth,
        'parent_id', v_current_parent,
        'amount', v_override_amount,
        'rate', v_override_rate
      );
    END IF;

    v_current_child := v_current_parent;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'agent_id', v_agent_id,
    'commission', v_commission,
    'is_sub_agent', v_is_sub_agent,
    'overrides', v_overrides_paid
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_agent_wallet_on_earning()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Commission-class earnings are credited elsewhere
  -- (pending_wallet_operations → manager approval → general_ledger → wallet).
  -- Other earning types used to add NEW.amount onto wallets.balance.
  IF TG_OP = 'INSERT'
     AND NEW.earning_type NOT IN ('referral_bonus', 'commission', 'subagent_commission')
  THEN
    -- TODO(wallets-42p10): ON CONFLICT DO UPDATE SET balance = wallets.balance
    -- + NEW.amount raises 42P10 and writes a derived balance. apply_wallet_movement
    -- only ensures a physical row (no bucket write). create_ledger_transaction
    -- is not a safe substitute: trg_agent_earning_to_ledger (same INSERT, fires
    -- before this trigger) already posts a wallet-scoped general_ledger cash_in
    -- for every earning type except referral_bonus, with ledger.authorized set.
    -- A second RPC would double-credit, and these earning types have no single
    -- category / bucket / balancing platform leg in this trigger. Ensure the
    -- physical row only. referral_bonus, commission and subagent_commission
    -- stay excluded, as before.
    INSERT INTO public.wallets_physical (user_id, currency)
    VALUES (NEW.agent_id, 'UGX')
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;
