-- Identity binding: one account -> one captured National ID identity -> one locked payout number.

CREATE TABLE IF NOT EXISTS public.user_identity_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  national_id text,
  linked_national_id text,
  full_legal_name text,
  national_id_surname text,
  national_id_given_name text,
  date_of_birth date,
  sex text,
  national_id_card_number text,
  national_id_photo_path text,
  national_id_back_photo_path text,
  selfie_photo_path text,
  locked_payout_number text,
  locked_payout_name text,
  locked_payout_provider text,
  phone_country_code text DEFAULT '+256',
  status text NOT NULL DEFAULT 'identity_captured',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  capture_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_identity_bindings_status_ck
    CHECK (status IN ('identity_captured', 'identity_verification_pending', 'identity_verified', 'revoked'))
);

GRANT SELECT ON public.user_identity_bindings TO authenticated;
GRANT ALL ON public.user_identity_bindings TO service_role;

ALTER TABLE public.user_identity_bindings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_identity_bindings'
      AND policyname = 'Owner reads own identity binding'
  ) THEN
    CREATE POLICY "Owner reads own identity binding"
      ON public.user_identity_bindings FOR SELECT TO authenticated
      USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_identity_bindings'
      AND policyname = 'Finance and admin read identity bindings'
  ) THEN
    CREATE POLICY "Finance and admin read identity bindings"
      ON public.user_identity_bindings FOR SELECT TO authenticated
      USING (
        public.has_role(auth.uid(), 'financial_ops')
        OR public.has_role(auth.uid(), 'cfo')
        OR public.has_role(auth.uid(), 'super_admin')
        OR public.has_role(auth.uid(), 'manager')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS user_identity_bindings_nin_idx
  ON public.user_identity_bindings (upper(regexp_replace(coalesce(national_id, ''), '[^A-Za-z0-9]', '', 'g')));
CREATE INDEX IF NOT EXISTS user_identity_bindings_locked_number_idx
  ON public.user_identity_bindings (right(regexp_replace(coalesce(locked_payout_number, ''), '\D', '', 'g'), 9));

-- Immutability: filling a blank field is allowed, overwriting a captured one is not.
CREATE OR REPLACE FUNCTION public.identity_binding_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_field text;
BEGIN
  IF OLD.status = 'revoked' THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  FOREACH v_field IN ARRAY ARRAY[
    'national_id', 'national_id_card_number', 'national_id_photo_path',
    'national_id_back_photo_path', 'selfie_photo_path',
    'locked_payout_number'
  ] LOOP
    IF (to_jsonb(OLD) ->> v_field) IS NOT NULL
       AND coalesce(to_jsonb(NEW) ->> v_field, '') <> coalesce(to_jsonb(OLD) ->> v_field, '') THEN
      BEGIN
        INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
        VALUES (auth.uid(), 'IDENTITY_REPLACEMENT_ATTEMPT', 'user_identity_bindings', OLD.id,
                jsonb_build_object('field', v_field, 'reason', 'Identity binding is immutable once captured.'));
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      RAISE EXCEPTION 'Your identity details are already linked to this account and cannot be changed here. Contact support if something is wrong.';
    END IF;
  END LOOP;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_identity_binding_immutable ON public.user_identity_bindings;
CREATE TRIGGER trg_identity_binding_immutable
  BEFORE UPDATE ON public.user_identity_bindings
  FOR EACH ROW EXECUTE FUNCTION public.identity_binding_immutable_guard();

-- Central resolver: the ONLY place a normal user's payout destination comes from.
CREATE OR REPLACE FUNCTION public.resolve_withdrawal_destination(p_user_id uuid)
RETURNS TABLE(number text, account_name text, provider text, source text, binding_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT b.locked_payout_number, b.locked_payout_name, b.locked_payout_provider, 'identity_binding'::text, b.id
  FROM public.user_identity_bindings b
  WHERE b.user_id = p_user_id
    AND b.status <> 'revoked'
    AND coalesce(b.locked_payout_number, '') <> ''
  UNION ALL
  SELECT p.mobile_money_number, p.mobile_money_name, lower(coalesce(p.mobile_money_provider, '')), 'profile_account'::text, NULL::uuid
  FROM public.profiles p
  WHERE p.id = p_user_id
    AND coalesce(p.mobile_money_number, '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM public.user_identity_bindings b2
      WHERE b2.user_id = p_user_id AND b2.status <> 'revoked'
        AND coalesce(b2.locked_payout_number, '') <> ''
    )
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.resolve_withdrawal_destination(uuid) TO authenticated, service_role;

-- Capture (not verification): binds whatever identity information already exists
-- on the account and locks the payout number.
CREATE OR REPLACE FUNCTION public.complete_identity_binding(
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_p record;
  v_num text;
  v_name text;
  v_prov text;
  v_id uuid;
  v_existing record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  SELECT id, full_name, national_id, linked_national_id, national_id_name,
         national_id_surname, national_id_given_name, national_id_card_number,
         date_of_birth, sex, national_id_photo_path, national_id_back_photo_path,
         selfie_photo_path, mobile_money_number, mobile_money_name, mobile_money_provider
    INTO v_p
  FROM public.profiles WHERE id = v_uid;

  SELECT * INTO v_existing FROM public.user_identity_bindings WHERE user_id = v_uid;
  IF v_existing.id IS NOT NULL AND v_existing.status <> 'revoked' THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'already_bound', 'binding_id', v_existing.id,
      'status', v_existing.status,
      'locked_payout_number', v_existing.locked_payout_number);
  END IF;

  IF coalesce(v_p.national_id, v_p.linked_national_id, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'national_id_missing',
      'message', 'Add your National ID details first.');
  END IF;
  IF coalesce(v_p.national_id_photo_path, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'id_photo_missing',
      'message', 'Take a photo of your National ID first.');
  END IF;
  IF coalesce(v_p.selfie_photo_path, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'selfie_missing',
      'message', 'Take your selfie first.');
  END IF;

  -- The number must have been confirmed with the code sent to it.
  SELECT d.momo_number,
         coalesce(nullif(btrim(d.final_name_override), ''), d.account_name),
         lower(coalesce(d.provider, ''))
    INTO v_num, v_name, v_prov
  FROM public.payout_destination_verifications d
  WHERE d.user_id = v_uid
    AND d.destination_type = 'mobile_money'
    AND d.ownership_code_confirmed_at IS NOT NULL
    AND coalesce(d.momo_number, '') <> ''
  ORDER BY d.ownership_code_confirmed_at ASC
  LIMIT 1;

  IF coalesce(v_num, '') = '' THEN
    v_num := v_p.mobile_money_number;
    v_name := v_p.mobile_money_name;
    v_prov := lower(coalesce(v_p.mobile_money_provider, ''));
  END IF;

  IF coalesce(v_num, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'payout_number_missing',
      'message', 'Confirm your withdrawal number with the code sent to it first.');
  END IF;

  INSERT INTO public.user_identity_bindings (
    user_id, national_id, linked_national_id, full_legal_name,
    national_id_surname, national_id_given_name, date_of_birth, sex,
    national_id_card_number, national_id_photo_path, national_id_back_photo_path,
    selfie_photo_path, locked_payout_number, locked_payout_name, locked_payout_provider,
    status, ip_address, user_agent, capture_source
  ) VALUES (
    v_uid, v_p.national_id, v_p.linked_national_id,
    coalesce(nullif(btrim(coalesce(v_p.national_id_name, '')), ''), v_p.full_name),
    v_p.national_id_surname, v_p.national_id_given_name, v_p.date_of_birth, v_p.sex,
    v_p.national_id_card_number, v_p.national_id_photo_path, v_p.national_id_back_photo_path,
    v_p.selfie_photo_path, v_num, v_name, nullif(v_prov, ''),
    'identity_captured', nullif(btrim(coalesce(p_ip_address, '')), ''),
    nullif(btrim(coalesce(p_user_agent, '')), ''), 'user_capture'
  )
  ON CONFLICT (user_id) DO UPDATE SET
    national_id = coalesce(public.user_identity_bindings.national_id, EXCLUDED.national_id),
    linked_national_id = coalesce(public.user_identity_bindings.linked_national_id, EXCLUDED.linked_national_id),
    locked_payout_number = coalesce(public.user_identity_bindings.locked_payout_number, EXCLUDED.locked_payout_number),
    locked_payout_name = coalesce(public.user_identity_bindings.locked_payout_name, EXCLUDED.locked_payout_name),
    locked_payout_provider = coalesce(public.user_identity_bindings.locked_payout_provider, EXCLUDED.locked_payout_provider),
    status = 'identity_captured'
  RETURNING id INTO v_id;

  -- Capture alone opens withdrawals: the destination row stops being a manual gate.
  UPDATE public.payout_destination_verifications d
  SET status = 'verified',
      decision_reason = coalesce(nullif(btrim(d.decision_reason), ''),
        'Identity captured and permanently bound to this account; withdrawal number locked.'),
      decided_at = coalesce(d.decided_at, now()),
      call_outcome = coalesce(d.call_outcome, 'identity_captured'),
      updated_at = now()
  WHERE d.user_id = v_uid
    AND d.status = 'waiting'
    AND d.destination_type = 'mobile_money'
    AND right(regexp_replace(coalesce(d.momo_number, ''), '\D', '', 'g'), 9)
        = right(regexp_replace(v_num, '\D', '', 'g'), 9);

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, ip_address, user_agent, metadata)
    VALUES
      (v_uid, 'IDENTITY_CAPTURED', 'user_identity_bindings', v_id,
       nullif(btrim(coalesce(p_ip_address, '')), ''), nullif(btrim(coalesce(p_user_agent, '')), ''),
       jsonb_build_object('reason', 'Identity information captured and bound to the account.')),
      (v_uid, 'WITHDRAWAL_NUMBER_LOCKED', 'user_identity_bindings', v_id,
       nullif(btrim(coalesce(p_ip_address, '')), ''), nullif(btrim(coalesce(p_user_agent, '')), ''),
       jsonb_build_object('locked_number_last4', right(regexp_replace(v_num, '\D', '', 'g'), 4),
                          'reason', 'Withdrawal number locked to the captured identity.'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'code', 'identity_captured',
    'binding_id', v_id, 'status', 'identity_captured', 'locked_payout_number', v_num);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.complete_identity_binding(text, text) TO authenticated, service_role;

-- Withdrawal: the destination is resolved server-side from the binding, never from the client.
CREATE OR REPLACE FUNCTION public.submit_withdrawal_request(
  p_amount numeric,
  p_payout_method text,
  p_mobile_money_number text DEFAULT NULL::text,
  p_mobile_money_name text DEFAULT NULL::text,
  p_mobile_money_provider text DEFAULT NULL::text,
  p_bank_name text DEFAULT NULL::text,
  p_bank_account_number text DEFAULT NULL::text,
  p_bank_account_name text DEFAULT NULL::text,
  p_client_request_id uuid DEFAULT NULL::uuid,
  p_reason text DEFAULT NULL::text
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
  v_headers jsonb;
  v_block_ip text;
  v_block_ua text;
  -- Identity-locked destination
  v_locked record;
  v_momo_number text := p_mobile_money_number;
  v_momo_name   text := p_mobile_money_name;
  v_binding     record;
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

    IF v_dest_status = 'rejected' THEN
      RETURN jsonb_build_object(
        'success', false, 'code', 'destination_rejected',
        'message', 'This payout destination was rejected by Financial Ops. Reason: '
                   || coalesce(v_dest_reason, 'not stated') || '. Contact support.',
        'destination_status', 'rejected');
    END IF;

    -- A captured identity binding replaces manual approval as the gate. Only
    -- the locked number can be paid, so waiting-in-queue no longer blocks.
    IF coalesce(v_dest_status, 'waiting') <> 'verified'
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

-- No self-service number change once the identity binding exists.
CREATE OR REPLACE FUNCTION public.set_withdrawal_account(p_number text, p_name text, p_provider text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_norm text;
  v_provider text;
  v_name text := btrim(coalesce(p_name, ''));
  v_conflict uuid;
  v_locked text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT locked_payout_number INTO v_locked
  FROM public.user_identity_bindings
  WHERE user_id = v_uid AND status <> 'revoked'
    AND coalesce(locked_payout_number, '') <> '';

  IF v_locked IS NOT NULL
     AND right(regexp_replace(coalesce(p_number, ''), '\D', '', 'g'), 9)
         <> right(regexp_replace(v_locked, '\D', '', 'g'), 9) THEN
    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, metadata)
      VALUES (v_uid, 'IDENTITY_REPLACEMENT_ATTEMPT', 'profiles',
              jsonb_build_object('field', 'mobile_money_number',
                'reason', 'Attempt to change a withdrawal number locked to a captured identity.'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE EXCEPTION 'Your withdrawal number is locked to your identity and cannot be changed here. Contact support.';
  END IF;

  v_norm := public.normalize_ug_phone(p_number);
  IF v_norm IS NULL OR length(regexp_replace(v_norm, '\D', '', 'g')) < 9 THEN
    RAISE EXCEPTION 'Enter a valid Ugandan mobile money number';
  END IF;

  IF length(v_name) < 4 OR array_length(regexp_split_to_array(v_name, '\s+'), 1) < 2 THEN
    RAISE EXCEPTION 'Enter the full name exactly as it appears on the mobile money account';
  END IF;

  v_provider := lower(btrim(coalesce(p_provider, '')));
  IF v_provider NOT IN ('mtn', 'airtel') THEN
    RAISE EXCEPTION 'Select MTN or Airtel';
  END IF;

  SELECT id INTO v_conflict
  FROM public.profiles
  WHERE id <> v_uid
    AND mobile_money_number IS NOT NULL
    AND public.normalize_ug_phone(mobile_money_number) = v_norm
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'This mobile money number is already linked to another Welile account';
  END IF;

  UPDATE public.profiles
  SET mobile_money_number = v_norm,
      mobile_money_name = v_name,
      mobile_money_provider = v_provider,
      updated_at = now()
  WHERE id = v_uid;

  RETURN jsonb_build_object(
    'mobile_money_number', v_norm,
    'mobile_money_name', v_name,
    'mobile_money_provider', v_provider
  );
END;
$function$;

-- Backfill: everyone whose identity information is already complete. Incomplete
-- records are left alone. Nothing historical is removed or rewritten.
INSERT INTO public.user_identity_bindings (
  user_id, national_id, linked_national_id, full_legal_name,
  national_id_surname, national_id_given_name, date_of_birth, sex,
  national_id_card_number, national_id_photo_path, national_id_back_photo_path,
  selfie_photo_path, locked_payout_number, locked_payout_name, locked_payout_provider,
  status, submitted_at, capture_source
)
SELECT p.id,
       p.national_id, p.linked_national_id,
       coalesce(nullif(btrim(coalesce(p.national_id_name, '')), ''), p.full_name),
       p.national_id_surname, p.national_id_given_name, p.date_of_birth, p.sex,
       p.national_id_card_number, p.national_id_photo_path, p.national_id_back_photo_path,
       p.selfie_photo_path,
       coalesce(nullif(btrim(coalesce(d.momo_number, '')), ''), p.mobile_money_number),
       coalesce(nullif(btrim(coalesce(d.final_name_override, '')), ''),
                nullif(btrim(coalesce(d.account_name, '')), ''), p.mobile_money_name),
       lower(coalesce(nullif(d.provider, ''), p.mobile_money_provider)),
       'identity_captured',
       coalesce(p.identity_photos_submitted_at, now()),
       'backfill_2026_09_15'
FROM public.profiles p
LEFT JOIN LATERAL (
  SELECT v.momo_number, v.account_name, v.final_name_override, v.provider
  FROM public.payout_destination_verifications v
  WHERE v.user_id = p.id
    AND v.destination_type = 'mobile_money'
    AND coalesce(v.momo_number, '') <> ''
  ORDER BY (v.status = 'verified') DESC,
           (v.ownership_code_confirmed_at IS NOT NULL) DESC,
           v.created_at ASC
  LIMIT 1
) d ON true
WHERE coalesce(p.national_id, p.linked_national_id, '') <> ''
  AND coalesce(p.national_id_photo_path, '') <> ''
  AND coalesce(p.selfie_photo_path, '') <> ''
  AND coalesce(nullif(btrim(coalesce(d.momo_number, '')), ''), p.mobile_money_number, '') <> ''
ON CONFLICT (user_id) DO NOTHING;