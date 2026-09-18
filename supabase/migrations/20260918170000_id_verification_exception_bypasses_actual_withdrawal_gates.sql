-- Doc 72 wired id_verification_exceptions into payout_withdrawal_block_reasons
-- -- but that function is ADVISORY ONLY (it feeds the Withdraw screen's
-- "why is this blocked" message). It was never the thing that actually lets
-- a withdrawal through. The real gates are:
--
--   1. submit_withdrawal_request() -- the RPC that inserts withdrawal_requests.
--      It requires ensure_payout_destination()'s returned status to be
--      'verified', OR a matching user_identity_bindings.locked_payout_number.
--      Neither check has ever known about id_verification_exceptions.
--   2. enforce_withdrawal_destination_verified() -- the BEFORE INSERT trigger
--      on withdrawal_requests, the true DB-level backstop for any insert path.
--      It already exempts user_is_pure_partner (checked before it even looks
--      at destination status) but was never given the exception check either.
--
-- Result: granting a CTO ID-verification exception (cto_grant_id_verification_
-- exception) made the advisory panel say "verified", but bwayo mark -- whose
-- one payout_destination_verifications row is still 'waiting' and who has no
-- user_identity_bindings row -- would still have been rejected by
-- submit_withdrawal_request with destination_unverified on an actual attempt.
-- Reported by Josh after granting exceptions to NABBAALE CLAIRE / bwayo mark /
-- ATUHAIRE CAROLYNE and expecting the override to be absolute: "give this
-- place the absolute power to exempt anyone."
--
-- Fix: both real gates now short-circuit on an active id_verification_exceptions
-- row, same precedence as their existing pure-partner short-circuits, and the
-- migration's own original comment: "a CTO exception means this specific
-- person does not need to go through ID verification at all, not skip only
-- one leg of it." ensure_payout_destination() itself is left untouched --
-- it still records/upserts the destination row for audit trail purposes,
-- it's just no longer the thing standing in an exempted user's way.

CREATE OR REPLACE FUNCTION public.enforce_withdrawal_destination_verified()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  m text := lower(coalesce(NEW.payout_method,''));
  v_dest_status text;
  v_binding record;
  v_has_nid boolean;
BEGIN
  IF m NOT IN ('mobile_money','bank_transfer') THEN
    RETURN NEW;
  END IF;

  IF NEW.landlord_payout_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.proxy_partner_id IS NOT NULL
     AND NEW.initiated_by IS NOT NULL
     AND NEW.initiated_by <> NEW.user_id THEN
    RETURN NEW;
  END IF;

  IF public.user_is_pure_partner(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.id_verification_exceptions e
    WHERE e.user_id = NEW.user_id AND e.revoked_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  -- HARD GATE: no National ID on record means no payout, whatever the state of
  -- the destination queue. Accepts either the profile field or a captured
  -- identity binding.
  SELECT EXISTS (
           SELECT 1 FROM public.profiles p
           WHERE p.id = NEW.user_id
             AND coalesce(btrim(p.national_id), '') <> ''
         )
         OR EXISTS (
           SELECT 1 FROM public.user_identity_bindings b
           WHERE b.user_id = NEW.user_id
             AND b.status <> 'revoked'
             AND coalesce(btrim(coalesce(b.national_id, b.linked_national_id, '')), '') <> ''
         )
    INTO v_has_nid;

  IF NOT v_has_nid THEN
    RAISE EXCEPTION 'You have not submitted your National ID yet. Submit your National ID and payout details, then try again.';
  END IF;

  IF public.payout_destination_is_verified(
       NEW.user_id, NEW.payout_method, NEW.mobile_money_number, NEW.bank_name, NEW.bank_account_number) THEN
    RETURN NEW;
  END IF;

  SELECT d.status INTO v_dest_status
  FROM public.payout_destination_verifications d
  WHERE d.user_id = NEW.user_id
    AND d.destination_key = public.payout_destination_key(
          NEW.payout_method, NEW.mobile_money_number, NEW.bank_name, NEW.bank_account_number)
  ORDER BY (d.status = 'rejected') DESC, d.updated_at DESC NULLS LAST
  LIMIT 1;

  IF v_dest_status = 'rejected' THEN
    RAISE EXCEPTION 'This payout destination was rejected by Financial Ops. Contact support.';
  END IF;

  IF m = 'mobile_money' THEN
    SELECT * INTO v_binding
    FROM public.user_identity_bindings
    WHERE user_id = NEW.user_id
      AND status <> 'revoked'
      AND coalesce(locked_payout_number, '') <> ''
      AND regexp_replace(coalesce(locked_payout_number, ''), '[^0-9]', '', 'g')
          LIKE '%' || right(regexp_replace(coalesce(NEW.mobile_money_number, ''), '[^0-9]', '', 'g'), 9)
    LIMIT 1;

    IF v_binding.id IS NOT NULL
       AND coalesce(btrim(coalesce(v_binding.national_id, v_binding.linked_national_id, '')), '') <> ''
       AND coalesce(btrim(coalesce(v_binding.national_id_photo_path, '')), '') <> ''
       AND coalesce(btrim(coalesce(v_binding.selfie_photo_path, '')), '') <> '' THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'You have not submitted your National ID details and payout number yet. Submit them, then try again.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_withdrawal_request(p_amount numeric, p_payout_method text, p_mobile_money_number text DEFAULT NULL::text, p_mobile_money_name text DEFAULT NULL::text, p_mobile_money_provider text DEFAULT NULL::text, p_bank_name text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text, p_client_request_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
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
  v_headers jsonb;
  v_block_ip text;
  v_block_ua text;
  -- Identity-locked destination
  v_locked record;
  v_momo_number text := p_mobile_money_number;
  v_momo_name   text := p_mobile_money_name;
  v_binding     record;
  v_id_exempt   boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized',
      'message', 'You must be signed in to submit a withdrawal.');
  END IF;

  v_id_exempt := EXISTS (
    SELECT 1 FROM public.id_verification_exceptions e
    WHERE e.user_id = v_uid AND e.revoked_at IS NULL
  );

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

  -- The client never decides where money goes. When the account carries a
  -- locked withdrawal number, that number is used regardless of what came in.
  IF v_method = 'mobile_money' THEN
    SELECT * INTO v_locked FROM public.resolve_withdrawal_destination(v_uid);

    IF v_locked.number IS NOT NULL THEN
      IF coalesce(btrim(coalesce(p_mobile_money_number, '')), '') <> ''
         AND right(regexp_replace(p_mobile_money_number, '\D', '', 'g'), 9)
             <> right(regexp_replace(v_locked.number, '\D', '', 'g'), 9) THEN
        BEGIN
          v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
          INSERT INTO public.audit_logs (user_id, action_type, table_name, ip_address, user_agent, metadata)
          VALUES (v_uid, 'WITHDRAWAL_DESTINATION_OVERRIDE_ATTEMPT', 'withdrawal_requests',
                  nullif(v_headers ->> 'cf-connecting-ip', ''), v_headers ->> 'user-agent',
                  jsonb_build_object(
                    'attempted_last4', right(regexp_replace(p_mobile_money_number, '\D', '', 'g'), 4),
                    'locked_last4', right(regexp_replace(v_locked.number, '\D', '', 'g'), 4),
                    'amount', p_amount,
                    'reason', 'Request carried a payout number other than the locked withdrawal number.'));
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;

      v_momo_number := v_locked.number;
      v_momo_name   := coalesce(nullif(btrim(coalesce(v_locked.account_name, '')), ''), p_mobile_money_name);
      v_provider    := lower(coalesce(nullif(v_locked.provider, ''), lower(coalesce(p_mobile_money_provider, ''))));
    ELSE
      v_provider := lower(coalesce(p_mobile_money_provider, ''));
    END IF;

    IF v_provider NOT IN ('mtn', 'airtel') THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_provider',
        'message', 'Mobile money provider must be MTN or Airtel.');
    END IF;
    IF coalesce(btrim(coalesce(v_momo_number, '')), '') = ''
       OR coalesce(btrim(coalesce(v_momo_name, '')), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'missing_momo_details',
        'message', 'Mobile money number and account name are required.');
    END IF;
    IF v_momo_number !~ '^\+?[0-9 ]{9,15}$' THEN
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
      v_uid, v_method, v_momo_number, v_momo_name, v_provider,
      p_bank_name, p_bank_account_number, p_bank_account_name
    ) e;

    SELECT * INTO v_binding
    FROM public.user_identity_bindings
    WHERE user_id = v_uid AND status <> 'revoked'
      AND coalesce(locked_payout_number, '') <> '';

    IF v_dest_status = 'rejected' AND NOT v_id_exempt THEN
      RETURN jsonb_build_object(
        'success', false, 'code', 'destination_rejected',
        'message', 'This payout destination was rejected by Financial Ops. Reason: '
                   || coalesce(v_dest_reason, 'not stated') || '. Contact support.',
        'destination_status', 'rejected');
    END IF;

    -- A captured identity binding replaces manual approval as the gate. Only
    -- the locked number can be paid, so waiting-in-queue no longer blocks.
    -- A CTO-granted id_verification_exceptions row bypasses this entirely --
    -- it means this person does not need to go through ID verification at all.
    IF coalesce(v_dest_status, 'waiting') <> 'verified'
       AND NOT v_id_exempt
       AND NOT (
         v_method = 'mobile_money'
         AND v_binding.id IS NOT NULL
         AND right(regexp_replace(v_momo_number, '\D', '', 'g'), 9)
             = right(regexp_replace(v_binding.locked_payout_number, '\D', '', 'g'), 9)
       ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'destination_unverified',
        'message', 'This number is not yet verified. Financial Ops will call you to confirm it belongs to you.',
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
    CASE WHEN v_method = 'mobile_money' THEN btrim(v_momo_number) END,
    CASE
      WHEN v_method = 'mobile_money' THEN btrim(v_momo_name)
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
