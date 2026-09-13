-- CORRECTION to the "tie every action to an IP address" series (items 1-9,
-- 46). Found while investigating withdrawal_approved_ledger audit rows:
-- some audit_logs rows showed a plausible-looking IP (e.g. 16.62.123.17)
-- paired with user_agent "Deno/2.1.4 (variant; SupabaseEdgeRuntime/1.76.0;
-- ...)" -- that is NOT the approving staff member's browser. It is
-- Supabase's own edge-runtime infrastructure, captured because an edge
-- function's service-role call to Postgres/PostgREST carries its own
-- request.headers, and this session's capture triggers blindly trusted
-- whatever x-forwarded-for was present there.
--
-- This is worse than the original gap: a NULL IP honestly says "we don't
-- know." A SupabaseEdgeRuntime-sourced IP looks like real forensic
-- evidence but misattributes the action to the wrong network entirely --
-- exactly the kind of false lead that could send a future investigation
-- (like CASE MP-20260913-01) in the wrong direction.
--
-- Confirmed live and already real, not hypothetical, before this fix:
--   general_ledger          68 rows (create_ledger_transaction)
--   deposit_requests         2 rows (capture_deposit_request_client_context)
--   profile_field_audit      1 row  (log_profile_field_changes)
-- audit_logs, withdrawal_requests, login_phase_events, withdrawal_claim_
-- attempts, withdrawal_notification_log, password_change_audit showed 0
-- affected rows at the time of this fix, but shared the identical
-- vulnerability structurally and are hardened here too, preventively.
--
-- Fix, applied to every capture function in this series: detect a
-- user-agent containing "SupabaseEdgeRuntime" and treat that request as
-- having no attributable client IP at all (leave both columns null) rather
-- than trust x-forwarded-for in that context.
--
-- Data cleanup: the 3 already-corrupted tables outside general_ledger had
-- their false ip_address/user_agent values nulled out directly (deposit_
-- requests, profile_field_audit, audit_logs). general_ledger's 68 affected
-- rows are deliberately left as-is -- that table is protected by
-- trg_enforce_ledger_rpc_only ("writes must go through create_ledger_
-- transaction RPC"), and this migration does not bypass that guard even
-- for a metadata-only correction. Those 68 rows' ip_address/user_agent
-- should be treated as unreliable until/unless a separate, deliberate
-- decision is made to correct them through an approved path.

-- 1. audit_logs
CREATE OR REPLACE FUNCTION public.capture_audit_log_ip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ua := v_headers ->> 'user-agent';

  IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
    NEW.ip_address := coalesce(NEW.ip_address, NULL);
    NEW.user_agent := coalesce(NEW.user_agent, NULL);
    RETURN NEW;
  END IF;

  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  IF v_ip IS NULL THEN
    v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);
  NEW.user_agent := coalesce(NEW.user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

-- 2. general_ledger
CREATE OR REPLACE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL::text, skip_balance_check boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id uuid;
  v_entry jsonb;
  v_total_in numeric := 0;
  v_total_out numeric := 0;
  v_user_balance numeric;
  v_cached_withdrawable numeric;
  v_anchor_at timestamptz;
  v_lock_key bigint;
  v_wallet_id uuid;
  v_recipient_type text;
  v_category text;
  v_scope text;
  v_effective_bucket text;
  v_headers jsonb;
  v_req_ip text;
  v_req_ua text;
BEGIN
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN
    RAISE EXCEPTION 'entries must be a JSON array, got: %', COALESCE(jsonb_typeof(entries), 'NULL');
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_req_ua := v_headers ->> 'user-agent';
    IF v_req_ua IS NOT NULL AND v_req_ua ILIKE '%SupabaseEdgeRuntime%' THEN
      v_req_ip := NULL;
      v_req_ua := NULL;
    ELSE
      v_req_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
      IF v_req_ip IS NULL THEN
        v_req_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_req_ip := NULL;
    v_req_ua := NULL;
  END;

  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    v_lock_key := abs(hashtext(idempotency_key));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT transaction_group_id INTO v_group_id
    FROM public.general_ledger
    WHERE general_ledger.idempotency_key = create_ledger_transaction.idempotency_key
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_group_id IS NOT NULL THEN
      RETURN v_group_id;
    END IF;
  END IF;

  v_group_id := gen_random_uuid();

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    IF (v_entry->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'All amounts must be positive, got: %', v_entry->>'amount';
    END IF;

    v_category       := v_entry->>'category';
    v_scope          := COALESCE(v_entry->>'ledger_scope', 'wallet');
    v_recipient_type := NULLIF(v_entry->>'recipient_type', '');

    IF v_scope = 'wallet' AND v_category IN (
      'agent_repayment','agent_advance_repayment','salary_advance_repayment','debt_recovery'
    ) THEN
      IF v_recipient_type IS NULL THEN
        BEGIN
          INSERT INTO public.wallet_routing_violations (
            user_id, category, direction, amount, recipient_type, reason, context
          ) VALUES (
            NULLIF(v_entry->>'user_id','')::uuid,
            v_category, v_entry->>'direction',
            (v_entry->>'amount')::numeric, NULL,
            'RECIPIENT_TYPE_REQUIRED',
            jsonb_build_object('source','create_ledger_transaction','rule','advance_recovery_isolation')
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RAISE EXCEPTION 'agent_repayment requires explicit recipient_type on the wallet leg' USING ERRCODE = 'check_violation';
      END IF;

      BEGIN
        PERFORM public.assert_routing_compatible(v_category, v_recipient_type);
      EXCEPTION WHEN check_violation THEN
        BEGIN
          INSERT INTO public.wallet_routing_violations (
            user_id, category, direction, amount, recipient_type, reason, context
          ) VALUES (
            NULLIF(v_entry->>'user_id','')::uuid,
            v_category, v_entry->>'direction',
            (v_entry->>'amount')::numeric, v_recipient_type,
            SQLERRM,
            jsonb_build_object('source','create_ledger_transaction','rule','advance_recovery_isolation')
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RAISE;
      END;
    END IF;

    IF v_entry->>'direction' = 'cash_in' THEN
      v_total_in := v_total_in + (v_entry->>'amount')::numeric;
    ELSIF v_entry->>'direction' = 'cash_out' THEN
      v_total_out := v_total_out + (v_entry->>'amount')::numeric;

      v_effective_bucket := COALESCE(
        NULLIF(v_entry->>'wallet_bucket', ''),
        CASE
          WHEN v_recipient_type = 'operational_wallet' THEN 'float'
          WHEN v_recipient_type = 'user' THEN 'withdrawable'
          ELSE 'withdrawable'
        END
      );

      IF NOT skip_balance_check
         AND v_scope = 'wallet'
         AND (v_entry->>'user_id') IS NOT NULL
         AND v_effective_bucket = 'withdrawable' THEN

        SELECT anchor_at INTO v_anchor_at
        FROM public.wallet_fresh_start_anchors
        WHERE user_id = (v_entry->>'user_id')::uuid;

        WITH category_routed AS (
          SELECT COALESCE(SUM(CASE WHEN r.bucket = 'withdrawable' THEN r.sign * gl.amount ELSE 0 END), 0) AS net
          FROM public.general_ledger gl
          CROSS JOIN LATERAL public.wallet_route_for_category(gl.user_id, gl.category, gl.direction) r
          WHERE gl.user_id = (v_entry->>'user_id')::uuid
            AND gl.ledger_scope = 'wallet'
            AND (gl.classification IS NULL OR gl.classification = 'production')
            AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
            AND gl.wallet_bucket IS NULL
        ), explicit_routed AS (
          SELECT COALESCE(SUM(
            CASE
              WHEN wallet_bucket = 'withdrawable' AND direction IN ('cash_in','credit') THEN amount
              WHEN wallet_bucket = 'withdrawable' AND direction IN ('cash_out','debit') THEN -amount
              ELSE 0
            END
          ), 0) AS net
          FROM public.general_ledger
          WHERE user_id = (v_entry->>'user_id')::uuid
            AND ledger_scope = 'wallet'
            AND (classification IS NULL OR classification = 'production')
            AND (v_anchor_at IS NULL OR created_at >= v_anchor_at)
            AND wallet_bucket IS NOT NULL
        )
        SELECT category_routed.net + explicit_routed.net
        INTO v_user_balance
        FROM category_routed, explicit_routed;

        SELECT COALESCE(withdrawable_balance, 0)
        INTO v_cached_withdrawable
        FROM public.wallets
        WHERE user_id = (v_entry->>'user_id')::uuid;

        v_user_balance := GREATEST(0,
          LEAST(COALESCE(v_cached_withdrawable, 0), GREATEST(0, COALESCE(v_user_balance, 0)))
        );

        IF v_user_balance < (v_entry->>'amount')::numeric THEN
          RAISE EXCEPTION 'Insufficient ledger balance for user %. Available: %, Required: %',
            v_entry->>'user_id', v_user_balance, v_entry->>'amount';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in or cash_out', v_entry->>'direction';
    END IF;
  END LOOP;

  IF v_total_in <> v_total_out THEN
    RAISE EXCEPTION 'Transaction not balanced. Total cash_in (%) <> total cash_out (%)', v_total_in, v_total_out;
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    v_wallet_id := NULL;
    IF (v_entry->>'user_id') IS NOT NULL THEN
      SELECT id INTO v_wallet_id
      FROM public.wallets
      WHERE user_id = (v_entry->>'user_id')::uuid;
    END IF;

    INSERT INTO public.general_ledger (
      user_id, wallet_id, ledger_scope, direction, category, amount, currency,
      description, source_table, source_id, transaction_group_id,
      idempotency_key, transaction_date, linked_party, reference_id, account,
      classification, recipient_type, wallet_bucket, routing_source,
      solvency_bypass_reason, ip_address, user_agent
    ) VALUES (
      (v_entry->>'user_id')::uuid,
      v_wallet_id,
      COALESCE(v_entry->>'ledger_scope', 'wallet'),
      v_entry->>'direction',
      v_entry->>'category',
      (v_entry->>'amount')::numeric,
      COALESCE(v_entry->>'currency', 'UGX'),
      v_entry->>'description',
      COALESCE(v_entry->>'source_table', 'ledger_transaction'),
      (v_entry->>'source_id')::uuid,
      v_group_id,
      create_ledger_transaction.idempotency_key,
      COALESCE((v_entry->>'transaction_date')::timestamptz, now()),
      v_entry->>'linked_party',
      v_entry->>'reference_id',
      v_entry->>'account',
      COALESCE(v_entry->>'classification', 'production'),
      NULLIF(v_entry->>'recipient_type', ''),
      NULLIF(v_entry->>'wallet_bucket', ''),
      NULLIF(v_entry->>'routing_source', ''),
      NULLIF(v_entry->>'solvency_bypass_reason', '')::public.solvency_bypass_reason,
      v_req_ip,
      v_req_ua
    );
  END LOOP;

  RETURN v_group_id;
END;
$function$;

-- 3. deposit_requests
CREATE OR REPLACE FUNCTION public.capture_deposit_request_client_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ua := v_headers ->> 'user-agent';
  IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
    RETURN NEW;
  END IF;

  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  IF v_ip IS NULL THEN
    v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  END IF;

  NEW.request_ip_address := coalesce(NEW.request_ip_address, v_ip);
  NEW.request_user_agent := coalesce(NEW.request_user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

-- 4. withdrawal_requests
CREATE OR REPLACE FUNCTION public.capture_withdrawal_request_client_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ua := v_headers ->> 'user-agent';
  IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
    RETURN NEW;
  END IF;

  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  IF v_ip IS NULL THEN
    v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  END IF;

  NEW.request_ip_address := coalesce(NEW.request_ip_address, v_ip);
  NEW.request_user_agent := coalesce(NEW.request_user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

-- 5. login_phase_events
CREATE OR REPLACE FUNCTION public.capture_login_phase_event_ip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ua := v_headers ->> 'user-agent';
  IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
    RETURN NEW;
  END IF;

  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  IF v_ip IS NULL THEN
    v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

-- 6. profile_field_audit
CREATE OR REPLACE FUNCTION public.log_profile_field_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  audited TEXT[] := ARRAY[
    'full_name','phone','email','avatar_url','national_id',
    'mobile_money_number','mobile_money_name','mobile_money_provider',
    'continent','country','region','district','city','town',
    'sub_county','parish','village','landmark','ug_village_id',
    'residence_lat','residence_lng',
    'primary_persona','occupation','has_smartphone',
    'address_complete','referrer_id','territory','agent_type'
  ];
  f TEXT;
  oldj JSONB := to_jsonb(OLD);
  newj JSONB := to_jsonb(NEW);
  ov TEXT;
  nv TEXT;
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_ua := v_headers ->> 'user-agent';
    IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
      v_ip := NULL;
      v_ua := NULL;
    ELSE
      v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
      IF v_ip IS NULL THEN
        v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
    v_ua := NULL;
  END;

  FOREACH f IN ARRAY audited LOOP
    ov := oldj ->> f;
    nv := newj ->> f;
    IF ov IS DISTINCT FROM nv THEN
      INSERT INTO public.profile_field_audit (user_id, changed_by, field_name, old_value, new_value, ip_address, user_agent)
      VALUES (NEW.id, auth.uid(), f, ov, nv, v_ip, v_ua);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

-- 7. withdrawal_claim_attempts
CREATE OR REPLACE FUNCTION public.merchant_claim_log(
  p_withdrawal_id uuid, p_agent_user_id uuid, p_desk_id uuid, p_result_code text,
  p_error_code text DEFAULT NULL, p_idempotent boolean DEFAULT false,
  p_race_lost boolean DEFAULT false, p_blocking_withdrawal_id uuid DEFAULT NULL,
  p_reservation_outcome text DEFAULT NULL, p_detail text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_ua := v_headers ->> 'user-agent';
    IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
      v_ip := NULL;
      v_ua := NULL;
    ELSE
      v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
      IF v_ip IS NULL THEN
        v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
    v_ua := NULL;
  END;

  INSERT INTO public.withdrawal_claim_attempts (
    withdrawal_id, agent_user_id, desk_id, result_code, error_code, idempotent,
    race_lost, blocking_withdrawal_id, reservation_outcome, detail, ip_address, user_agent)
  VALUES (
    p_withdrawal_id, p_agent_user_id, p_desk_id, p_result_code, p_error_code, p_idempotent,
    p_race_lost, p_blocking_withdrawal_id, p_reservation_outcome, left(p_detail, 500), v_ip, v_ua);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'withdrawal_claim_attempts insert failed: %', SQLERRM;
END;
$function$;

-- 8. withdrawal_notification_log
CREATE OR REPLACE FUNCTION public.accept_withdrawal_dispatch(p_withdrawal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_w record;
  v_result jsonb;
  v_ok boolean;
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cashout_agents WHERE agent_id = v_uid AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'error', 'not_merchant_agent');
  END IF;

  SELECT payout_method, mobile_money_provider, bank_name, mobile_money_number, mobile_money_name
    INTO v_w
  FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'error', 'not_found');
  END IF;

  IF NOT public.merchant_handles_payout(v_uid, v_w.payout_method, v_w.mobile_money_provider, v_w.bank_name) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'error', 'provider_not_assigned');
  END IF;

  v_result := public.claim_withdrawal_verified(p_withdrawal_id, v_w.mobile_money_number, v_w.mobile_money_name);
  v_ok := COALESCE((v_result->>'success')::boolean, false);

  IF v_ok THEN
    BEGIN
      v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
      v_ua := v_headers ->> 'user-agent';
      IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
        v_ip := NULL;
        v_ua := NULL;
      ELSE
        v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
        IF v_ip IS NULL THEN
          v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_ip := NULL;
      v_ua := NULL;
    END;

    UPDATE public.withdrawal_notification_log
       SET response = 'accepted', claimed_at = now(), updated_at = now(),
           ip_address = v_ip, user_agent = v_ua
     WHERE withdrawal_id = p_withdrawal_id AND recipient_id = v_uid;
    UPDATE public.withdrawal_notification_log
       SET response = 'superseded', claimed_at = now(), updated_at = now()
     WHERE withdrawal_id = p_withdrawal_id AND recipient_id <> v_uid AND response = 'pending';
  END IF;

  RETURN v_result || jsonb_build_object('ok', v_ok);
END;
$function$;

-- 9. password_change_audit
CREATE OR REPLACE FUNCTION public.log_password_change_on_auth_users()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_ua := v_headers ->> 'user-agent';
    IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
      v_ip := NULL;
      v_ua := NULL;
    ELSE
      v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
      IF v_ip IS NULL THEN
        v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
    v_ua := NULL;
  END;

  BEGIN
    INSERT INTO public.password_change_audit (user_id, ip_address, user_agent)
    VALUES (NEW.id, v_ip, v_ua);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN NEW;
END;
$function$;

-- Data cleanup: null out the already-corrupted rows outside general_ledger.
UPDATE public.deposit_requests SET request_ip_address = NULL, request_user_agent = NULL WHERE request_user_agent ILIKE '%SupabaseEdgeRuntime%';
UPDATE public.profile_field_audit SET ip_address = NULL, user_agent = NULL WHERE user_agent ILIKE '%SupabaseEdgeRuntime%';
UPDATE public.audit_logs SET ip_address = NULL, user_agent = NULL WHERE user_agent ILIKE '%SupabaseEdgeRuntime%';
-- general_ledger's 68 affected rows are NOT touched here -- see header note.
