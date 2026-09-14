-- Item #4 of the audit-control closure requirements: one adversarial
-- regression pass over everything built in this series.
--
-- Method: rather than firing real HTTP requests at production (which would
-- risk mutating real withdrawal/role/payout state), each capture trigger
-- was exercised directly at the SQL layer -- the actual trust boundary --
-- by setting request.headers to attacker-controlled values inside a
-- transaction that was rolled back, so no real row was ever written.
--
-- Test 1 -- spoofed ip_address in the insert payload, plus a spoofed
-- x-forwarded-for header, against tenant_agreement_acceptance:
--   client supplied ip_address = '127.0.0.1', device_info = 'SPOOFED...'
--   headers: x-forwarded-for: '1.2.3.4, 10.0.0.1'
--   RESULT: PASS. enforce_server_side_agreement_ip() discarded both
--   client-supplied values and recorded the server-resolved '1.2.3.4'.
--
-- Test 2 -- an attacker crafts a request that mimics a Supabase edge
-- function's own user-agent (hoping the edge-runtime guard's "trust
-- nothing" branch can be tricked into ignoring a header check entirely)
-- while also supplying a spoofed x-forwarded-for:
--   headers: user-agent: 'Deno/1.44.4 (variant; SupabaseEdgeRuntime/1.44.4)',
--            x-forwarded-for: '9.9.9.9'
--   RESULT: PASS. Both ip_address and device_info came back NULL -- the
--   guard correctly refuses to trust ANYTHING in that context rather than
--   picking up the attacker's x-forwarded-for value.
--
-- Test 3 -- header-priority ordering (found a real bug, fixed below).
-- All 13 capture functions in this series resolved x-forwarded-for's
-- FIRST comma-separated hop before falling back to cf-connecting-ip. That
-- ordering assumes the leftmost x-forwarded-for entry is trustworthy, but
-- if a client is free to pre-set its own x-forwarded-for header before it
-- ever reaches Cloudflare, a reverse proxy conventionally APPENDS its own
-- observed address to whatever list it received rather than replacing it
-- -- so the leftmost entry can be entirely attacker-authored, while
-- cf-connecting-ip is set by Cloudflare from the actual TCP connection and
-- cannot be forged by the client no matter what headers it sends. The
-- user's own architecture requirement says the trusted-proxy header is
-- the authority behind Cloudflare; it should never have been the fallback.
-- Fixed here: cf-connecting-ip is now checked FIRST in all 13 functions,
-- with the x-forwarded-for first-hop as the fallback only for requests
-- that reach Postgres without going through Cloudflare at all.
--
-- Test 4 -- payout-account lock (20260913190000): attempting a wallet
-- withdrawal insert with a mobile_money_number that does not match the
-- account's registered payout number correctly raises
-- 'withdrawal_payout_account_locked' and blocks the insert. But this
-- surfaced a real gap: because the trigger raises, a BLOCKED attempt left
-- zero forensic trace anywhere -- no withdrawal_requests row (it never
-- committed) and nothing in audit_logs either. The user explicitly asked
-- to "confirm failed/blocked attempts are also logged" -- they were not.
--
-- First attempt at a fix put an audit_logs INSERT directly inside the
-- trigger, right before the RAISE EXCEPTION. Testing that against a real
-- (unrolled-back) insert -- since it fails on its own, no wrapper was
-- needed -- proved it does NOT work: RAISE EXCEPTION aborts the entire
-- enclosing transaction, undoing everything since the transaction began,
-- INCLUDING the audit_logs row the trigger had just inserted moments
-- earlier in that same transaction. Confirmed empirically: zero rows in
-- audit_logs after the "successful" insert-then-raise.
--
-- This database has no dblink/postgres_fdw (checked pg_extension --
-- only pg_net is installed), so there is no autonomous-transaction
-- escape hatch available to make an insert survive its own transaction's
-- abort. The correct fix has to live where the exception can be CAUGHT
-- instead of raised past: submit_withdrawal_request is the sole writer of
-- withdrawal_requests (confirmed via pg_proc source search), so its own
-- EXCEPTION block now catches invalid_authorization_specification
-- (SQLSTATE 28000, the code this trigger raises with) and logs the block
-- there. PL/pgSQL's exception handling rolls back to a savepoint at the
-- start of the block, then runs the WHEN clause's own code in the
-- recovered transaction -- so an INSERT written there commits normally
-- when the function completes, unlike one written before the RAISE.
-- Verified for real: called submit_withdrawal_request with a mismatched
-- number (inside a transaction so the test destination-verification row
-- could be rolled back afterward) and confirmed the audit_logs row was
-- present with the correct real IP before rolling back.
-- The trigger itself reverts to its original, simpler form.
--
-- Test 5 -- KYC level-change RPCs and the partner_agreements payout
-- trigger are table-level, so no alternative code path can reach those
-- tables without passing through them -- confirmed by inspecting
-- pg_trigger for both tables directly (already established when built).
--
-- Not run against production: actually approving a real withdrawal via a
-- raw RPC call, or actually granting a role via an alternative path, since
-- both would mutate real state for real users/money outside of a
-- reversible transaction. Recommend running those two specifically in a
-- staging environment before considering the initiative closed end to end.

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

  v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  IF v_ip IS NULL THEN
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);
  NEW.user_agent := coalesce(NEW.user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

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

  v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  IF v_ip IS NULL THEN
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  END IF;

  NEW.request_ip_address := coalesce(NEW.request_ip_address, v_ip);
  NEW.request_user_agent := coalesce(NEW.request_user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

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

  v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  IF v_ip IS NULL THEN
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  END IF;

  NEW.request_ip_address := coalesce(NEW.request_ip_address, v_ip);
  NEW.request_user_agent := coalesce(NEW.request_user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

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

  v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  IF v_ip IS NULL THEN
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.capture_system_event_ip()
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

  v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  IF v_ip IS NULL THEN
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);
  NEW.user_agent := coalesce(NEW.user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.capture_kyc_level_change_ip()
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

  v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  IF v_ip IS NULL THEN
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);
  NEW.user_agent := coalesce(NEW.user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_server_side_agreement_ip()
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
    NEW.ip_address := NULL;
    NEW.device_info := NULL;
    RETURN NEW;
  END IF;

  v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  IF v_ip IS NULL THEN
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  END IF;

  NEW.ip_address := v_ip;
  NEW.device_info := v_ua;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  NEW.ip_address := NULL;
  NEW.device_info := NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.log_partner_payout_destination_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF COALESCE(NEW.bank_name,'') IS DISTINCT FROM COALESCE(OLD.bank_name,'') THEN
    v_changed := v_changed || 'bank_name';
  END IF;
  IF COALESCE(NEW.bank_account_number,'') IS DISTINCT FROM COALESCE(OLD.bank_account_number,'') THEN
    v_changed := v_changed || 'bank_account_number';
  END IF;
  IF COALESCE(NEW.bank_account_name,'') IS DISTINCT FROM COALESCE(OLD.bank_account_name,'') THEN
    v_changed := v_changed || 'bank_account_name';
  END IF;
  IF COALESCE(NEW.payout_mode,'') IS DISTINCT FROM COALESCE(OLD.payout_mode,'') THEN
    v_changed := v_changed || 'payout_mode';
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_ua := v_headers ->> 'user-agent';
    IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
      v_ip := NULL;
      v_ua := NULL;
    ELSE
      v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      IF v_ip IS NULL THEN
        v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
    v_ua := NULL;
  END;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, ip_address, user_agent, old_values, new_values, metadata)
    VALUES (
      auth.uid(), 'partner_payout_destination_changed', 'partner_agreements', NEW.id,
      v_ip, v_ua,
      jsonb_build_object('bank_name', OLD.bank_name, 'bank_account_number', OLD.bank_account_number, 'bank_account_name', OLD.bank_account_name, 'payout_mode', OLD.payout_mode),
      jsonb_build_object('bank_name', NEW.bank_name, 'bank_account_number', NEW.bank_account_number, 'bank_account_name', NEW.bank_account_name, 'payout_mode', NEW.payout_mode),
      jsonb_build_object('fields', to_jsonb(v_changed))
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN NEW;
END;
$function$;

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
      v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      IF v_ip IS NULL THEN
        v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
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
      v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      IF v_ip IS NULL THEN
        v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
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

CREATE OR REPLACE FUNCTION public.merchant_claim_log(p_withdrawal_id uuid, p_agent_user_id uuid, p_desk_id uuid, p_result_code text, p_error_code text DEFAULT NULL::text, p_idempotent boolean DEFAULT false, p_race_lost boolean DEFAULT false, p_blocking_withdrawal_id uuid DEFAULT NULL::uuid, p_reservation_outcome text DEFAULT NULL::text, p_detail text DEFAULT NULL::text)
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
      v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      IF v_ip IS NULL THEN
        v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
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
        v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
        IF v_ip IS NULL THEN
          v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
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
      v_req_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      IF v_req_ip IS NULL THEN
        v_req_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
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

-- Reverted to its original, simpler form -- the in-trigger logging
-- attempt was proven ineffective (see note above) and removed.
CREATE OR REPLACE FUNCTION public.enforce_withdrawal_payout_account_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_locked_num text;
  v_locked_name text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.mobile_money_number IS NOT DISTINCT FROM OLD.mobile_money_number THEN
    RETURN NEW;
  END IF;

  IF NEW.payout_method IS DISTINCT FROM 'mobile_money'
     OR coalesce(NEW.mobile_money_number, '') = ''
     OR coalesce(NEW.reason, '') NOT ILIKE '%wallet withdrawal%' THEN
    RETURN NEW;
  END IF;

  SELECT mobile_money_number, mobile_money_name
    INTO v_locked_num, v_locked_name
  FROM public.profiles
  WHERE id = NEW.user_id;

  IF coalesce(v_locked_num, '') = '' OR coalesce(v_locked_name, '') = '' THEN
    RETURN NEW;
  END IF;

  IF right(regexp_replace(NEW.mobile_money_number, '\D', '', 'g'), 9)
     <> right(regexp_replace(v_locked_num, '\D', '', 'g'), 9) THEN
    RAISE EXCEPTION
      USING ERRCODE = '28000',
            MESSAGE = 'withdrawal_payout_account_locked',
            DETAIL = format(
              'This account''s registered payout number is %s (%s). The request specified a different number. Change the registered Withdrawal Account in Settings first, then submit the withdrawal.',
              v_locked_num, v_locked_name);
  END IF;

  RETURN NEW;
END;
$function$;

-- The actual fix for Test 4: submit_withdrawal_request is the sole writer
-- of withdrawal_requests. Its own EXCEPTION block now catches
-- invalid_authorization_specification (the 28000 the trigger raises) and
-- logs the blocked attempt to audit_logs there, where it survives, then
-- returns the RPC's normal {success:false,...} JSON shape instead of
-- letting a raw Postgres error reach the client uncaught (which is what
-- happened before this fix, confirmed during testing).
CREATE OR REPLACE FUNCTION public.submit_withdrawal_request(
  p_amount numeric, p_payout_method text,
  p_mobile_money_number text DEFAULT NULL::text, p_mobile_money_name text DEFAULT NULL::text,
  p_mobile_money_provider text DEFAULT NULL::text, p_bank_name text DEFAULT NULL::text,
  p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text,
  p_client_request_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_available      numeric;
  v_method         text  := lower(coalesce(p_payout_method, ''));
  v_provider       text;
  v_new_id         uuid;
  v_client_req_id  uuid := coalesce(p_client_request_id, gen_random_uuid());
  v_existing_id    uuid;
  v_existing_code  text;
  v_payout_code    text;
  v_qr_data        text;
  v_dest_status    text;
  v_dest_reason    text;
  v_reason         text := nullif(btrim(left(coalesce(p_reason, ''), 200)), '');
  v_is_commission  boolean := lower(coalesce(v_reason, '')) IN (
    'commission payout',
    'cash-out commission',
    'cashout commission',
    'cash-out commission payout',
    'cashout commission payout'
  );
  v_commission_earned    numeric := 0;
  v_commission_withdrawn numeric := 0;
  v_headers jsonb;
  v_block_ip text;
  v_block_ua text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized',
      'message', 'You must be signed in to submit a withdrawal.');
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_amount',
      'message', 'Amount must be a positive whole number of UGX.');
  END IF;

  IF p_amount < 1000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'amount_below_min',
      'message', 'Minimum withdrawal is UGX 1,000.');
  END IF;

  IF p_amount > 50000000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'amount_above_max',
      'message', 'Maximum withdrawal per request is UGX 50,000,000.');
  END IF;

  IF v_method NOT IN ('mobile_money', 'bank_transfer', 'cash') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_method',
      'message', 'Payout method must be mobile_money, bank_transfer, or cash.');
  END IF;

  IF v_method = 'mobile_money' THEN
    v_provider := lower(coalesce(p_mobile_money_provider, ''));
    IF v_provider NOT IN ('mtn', 'airtel') THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_provider',
        'message', 'Mobile money provider must be MTN or Airtel.');
    END IF;
    IF coalesce(btrim(p_mobile_money_number), '') = ''
       OR coalesce(btrim(p_mobile_money_name), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'missing_momo_details',
        'message', 'Mobile money number and account name are required.');
    END IF;
    IF p_mobile_money_number !~ '^\+?[0-9 ]{9,15}$' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_momo_number',
        'message', 'Mobile money number must be 9-15 digits.');
    END IF;
  ELSIF v_method = 'bank_transfer' THEN
    IF coalesce(btrim(p_bank_name), '') = ''
       OR coalesce(btrim(p_bank_account_number), '') = ''
       OR coalesce(btrim(p_bank_account_name), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'missing_bank_details',
        'message', 'Bank name, account number, and account holder name are required.');
    END IF;
  END IF;

  IF v_method IN ('mobile_money', 'bank_transfer') THEN
    SELECT e.status, e.decision_reason INTO v_dest_status, v_dest_reason
    FROM public.ensure_payout_destination(
      v_uid, v_method, p_mobile_money_number, p_mobile_money_name, v_provider,
      p_bank_name, p_bank_account_number, p_bank_account_name
    ) e;

    IF coalesce(v_dest_status, 'waiting') <> 'verified' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', CASE WHEN v_dest_status = 'rejected' THEN 'destination_rejected' ELSE 'destination_unverified' END,
        'message', CASE
          WHEN v_dest_status = 'rejected'
            THEN 'This payout destination was rejected by Financial Ops. Reason: ' || coalesce(v_dest_reason, 'not stated') || '. Contact support.'
          ELSE 'This number is not yet verified. Financial Ops will call you to confirm it belongs to you.'
        END,
        'destination_status', coalesce(v_dest_status, 'waiting')
      );
    END IF;
  END IF;

  BEGIN
    PERFORM public.collect_due_agent_advance_installment(v_uid);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF v_is_commission THEN
    v_available := public.commission_withdrawal_available(v_uid);
  ELSE
    v_available := public.get_user_available_balance(v_uid);
  END IF;

  IF v_available IS NULL OR v_available < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'code', 'insufficient_funds',
      'message', format(
        'Insufficient funds. Available: UGX %s, requested: UGX %s.',
        to_char(coalesce(v_available, 0), 'FM999,999,999'),
        to_char(p_amount, 'FM999,999,999')
      ),
      'available', coalesce(v_available, 0)
    );
  END IF;

  SELECT id, payout_code
    INTO v_existing_id, v_existing_code
  FROM public.withdrawal_requests
  WHERE client_request_id = v_client_req_id
    AND user_id = v_uid
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'already_submitted',
      'request_id', v_existing_id,
      'payout_code', v_existing_code,
      'available_after', v_available - p_amount
    );
  END IF;

  IF v_method = 'cash' THEN
    LOOP
      v_payout_code := lpad((floor(random() * 10000))::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.payout_codes
        WHERE code = v_payout_code
          AND status IN ('pending', 'claimed')
      );
    END LOOP;
  END IF;

  INSERT INTO public.withdrawal_requests (
    user_id, amount, status, payout_method,
    mobile_money_number, mobile_money_name, mobile_money_provider,
    bank_name, bank_account_number, bank_account_name,
    client_request_id, initiated_by, payout_code, reason
  ) VALUES (
    v_uid, p_amount, 'pending', v_method,
    CASE WHEN v_method = 'mobile_money' THEN btrim(p_mobile_money_number) END,
    CASE
      WHEN v_method = 'mobile_money' THEN btrim(p_mobile_money_name)
      WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_name)
      ELSE 'Cash Pickup'
    END,
    CASE
      WHEN v_method = 'mobile_money' THEN v_provider
      WHEN v_method = 'bank_transfer' THEN 'bank'
      ELSE 'cash'
    END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_name) END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_number) END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_name) END,
    v_client_req_id, v_uid,
    v_payout_code, v_reason
  )
  RETURNING id INTO v_new_id;

  IF v_method = 'cash' THEN
    v_qr_data := jsonb_build_object(
      'code', v_payout_code,
      'amount', p_amount,
      'userId', v_uid,
      'withdrawalId', v_new_id
    )::text;

    INSERT INTO public.payout_codes (
      withdrawal_request_id, user_id, code, qr_data, amount, status
    ) VALUES (
      v_new_id, v_uid, v_payout_code, v_qr_data, p_amount, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'submitted',
    'request_id', v_new_id,
    'payout_code', v_payout_code,
    'available_after', v_available - p_amount
  );

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'duplicate_pending',
      'message', 'You already have a pending withdrawal with these details. Wait for it to be approved or rejected.');
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden',
      'message', 'Withdrawals from this account must be routed through your assigned agent.');
  WHEN invalid_authorization_specification THEN
    BEGIN
      v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
      v_block_ua := v_headers ->> 'user-agent';
      IF v_block_ua IS NOT NULL AND v_block_ua ILIKE '%SupabaseEdgeRuntime%' THEN
        -- The payout-OTP verification path calls this RPC from an edge
        -- function, not directly from the browser -- that hop's own
        -- outbound request carries edge infrastructure's UA, not the real
        -- user's. Recording it as the block's IP would be actively wrong,
        -- so it is intentionally left null here, same as every other
        -- capture point in this series.
        v_block_ip := NULL;
        v_block_ua := NULL;
      ELSE
        v_block_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
        IF v_block_ip IS NULL THEN
          v_block_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_block_ip := NULL;
      v_block_ua := NULL;
    END;

    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, ip_address, user_agent, metadata)
      VALUES (
        v_uid, 'withdrawal_payout_account_lock_blocked', 'withdrawal_requests',
        v_block_ip, v_block_ua,
        jsonb_build_object('attempted_number', p_mobile_money_number, 'amount', p_amount, 'detail', SQLERRM)
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN jsonb_build_object('success', false, 'code', 'payout_account_locked', 'message', SQLERRM);
  WHEN raise_exception THEN
    RETURN jsonb_build_object('success', false, 'code', 'rejected', 'message', SQLERRM);
END;
$function$;
