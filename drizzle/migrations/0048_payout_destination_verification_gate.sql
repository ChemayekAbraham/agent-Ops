-- Ensure a destination record exists (waiting by default) and return its status
CREATE OR REPLACE FUNCTION public.ensure_payout_destination(
  p_user_id uuid,
  p_method text,
  p_momo_number text DEFAULT NULL,
  p_momo_name text DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_bank_name text DEFAULT NULL,
  p_bank_account_number text DEFAULT NULL,
  p_bank_account_name text DEFAULT NULL
)
RETURNS TABLE (id uuid, status text, decision_reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := public.payout_destination_key(p_method, p_momo_number, p_bank_name, p_bank_account_number);
  v_type text := CASE WHEN lower(coalesce(p_method,'')) = 'mobile_money' THEN 'mobile_money' ELSE 'bank_transfer' END;
  v_name text := coalesce(nullif(btrim(coalesce(p_momo_name,'')), ''), nullif(btrim(coalesce(p_bank_account_name,'')), ''));
  v_id uuid;
  v_status text;
  v_reason text;
  v_prev_name text;
  v_id_name text;
  v_nid text;
  v_report jsonb;
BEGIN
  IF v_key IS NULL THEN
    RETURN;
  END IF;

  SELECT p.national_id, coalesce(p.national_id_name, p.full_name)
    INTO v_nid, v_id_name
  FROM public.profiles p WHERE p.id = p_user_id;

  v_report := public.payout_name_match_report(v_id_name, v_name);

  SELECT d.id, d.status, d.account_name INTO v_id, v_status, v_prev_name
  FROM public.payout_destination_verifications d
  WHERE d.user_id = p_user_id AND d.destination_key = v_key;

  IF v_id IS NULL THEN
    INSERT INTO public.payout_destination_verifications (
      user_id, destination_type, destination_key, provider,
      momo_number, bank_name, bank_account_number, account_name,
      national_id, national_id_name, name_match_score, name_mismatch_tokens
    ) VALUES (
      p_user_id, v_type, v_key,
      CASE WHEN v_type = 'mobile_money' THEN lower(coalesce(p_provider,'')) ELSE 'bank' END,
      CASE WHEN v_type = 'mobile_money' THEN btrim(p_momo_number) END,
      CASE WHEN v_type = 'bank_transfer' THEN btrim(p_bank_name) END,
      CASE WHEN v_type = 'bank_transfer' THEN btrim(p_bank_account_number) END,
      v_name, v_nid, v_id_name,
      (v_report->>'score')::numeric, coalesce(v_report->'diff', '[]'::jsonb)
    )
    RETURNING payout_destination_verifications.id, payout_destination_verifications.status,
              payout_destination_verifications.decision_reason
      INTO v_id, v_status, v_reason;
  ELSE
    -- A changed account name on a verified destination sends it back to waiting
    UPDATE public.payout_destination_verifications d
    SET account_name = coalesce(v_name, d.account_name),
        national_id = coalesce(v_nid, d.national_id),
        national_id_name = coalesce(v_id_name, d.national_id_name),
        name_match_score = (v_report->>'score')::numeric,
        name_mismatch_tokens = coalesce(v_report->'diff', '[]'::jsonb),
        status = CASE
          WHEN d.status = 'verified'
               AND v_name IS NOT NULL
               AND lower(coalesce(v_prev_name,'')) <> lower(v_name) THEN 'waiting'
          ELSE d.status END,
        decision_reason = CASE
          WHEN d.status = 'verified'
               AND v_name IS NOT NULL
               AND lower(coalesce(v_prev_name,'')) <> lower(v_name)
          THEN 'Account name changed after verification — needs re-verification'
          ELSE d.decision_reason END
    WHERE d.id = v_id
    RETURNING d.status, d.decision_reason INTO v_status, v_reason;
  END IF;

  RETURN QUERY SELECT v_id, v_status, v_reason;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_payout_destination(uuid,text,text,text,text,text,text,text) FROM public;

-- Read-only status probe for the app (own destinations only)
CREATE OR REPLACE FUNCTION public.my_payout_destination_status(
  p_method text,
  p_momo_number text DEFAULT NULL,
  p_bank_name text DEFAULT NULL,
  p_bank_account_number text DEFAULT NULL
)
RETURNS TABLE (status text, decision_reason text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.status, d.decision_reason
  FROM public.payout_destination_verifications d
  WHERE d.user_id = auth.uid()
    AND d.destination_key = public.payout_destination_key(p_method, p_momo_number, p_bank_name, p_bank_account_number);
$$;

GRANT EXECUTE ON FUNCTION public.my_payout_destination_status(text,text,text,text) TO authenticated;

-- The gate itself
CREATE OR REPLACE FUNCTION public.payout_destination_is_verified(
  p_user_id uuid,
  p_method text,
  p_momo_number text DEFAULT NULL,
  p_bank_name text DEFAULT NULL,
  p_bank_account_number text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lower(coalesce(p_method,'')) = 'cash'
      OR EXISTS (
        SELECT 1 FROM public.payout_destination_verifications d
        WHERE d.user_id = p_user_id
          AND d.status = 'verified'
          AND d.destination_key = public.payout_destination_key(p_method, p_momo_number, p_bank_name, p_bank_account_number)
      );
$$;

-- National ID capture (never a direct table write from the app)
CREATE OR REPLACE FUNCTION public.submit_national_id(p_national_id text, p_id_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id text := upper(btrim(coalesce(p_national_id,'')));
  v_name text := btrim(coalesce(p_id_name,''));
  v_taken uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'You must be signed in.');
  END IF;
  IF v_id !~ '^[A-Z0-9]{10,14}$' THEN
    RETURN jsonb_build_object('success', false, 'message', 'National ID number must be 10 to 14 letters and numbers, no spaces.');
  END IF;
  IF length(v_name) < 4 OR position(' ' IN v_name) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Enter your full name exactly as printed on the National ID.');
  END IF;

  SELECT id INTO v_taken FROM public.profiles WHERE upper(btrim(national_id)) = v_id AND id <> v_uid LIMIT 1;
  IF v_taken IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'This National ID is already recorded on another account. Financial Ops must resolve it.');
  END IF;

  UPDATE public.profiles
  SET national_id = v_id, national_id_name = v_name
  WHERE id = v_uid;

  UPDATE public.payout_destination_verifications d
  SET national_id = v_id,
      national_id_name = v_name,
      name_match_score = (public.payout_name_match_report(v_name, d.account_name)->>'score')::numeric,
      name_mismatch_tokens = coalesce(public.payout_name_match_report(v_name, d.account_name)->'diff', '[]'::jsonb)
  WHERE d.user_id = v_uid;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'national_id_submitted', 'profiles', v_uid::text,
          'User submitted National ID for payout verification',
          jsonb_build_object('national_id', v_id, 'national_id_name', v_name));

  RETURN jsonb_build_object('success', true, 'message', 'National ID recorded. Financial Ops will confirm it against your payout number.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_national_id(text,text) TO authenticated;

-- Financial Ops decision
CREATE OR REPLACE FUNCTION public.finops_decide_payout_destination(
  p_id uuid,
  p_decision text,
  p_reason text,
  p_call_outcome text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision,'')));
  v_reason text := btrim(coalesce(p_reason,''));
  v_row public.payout_destination_verifications;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only Financial Ops can verify payout destinations.';
  END IF;
  IF v_decision NOT IN ('verified','rejected') THEN
    RAISE EXCEPTION 'Decision must be verified or rejected.';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Write at least 10 characters explaining the decision.';
  END IF;

  SELECT * INTO v_row FROM public.payout_destination_verifications WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Destination not found.';
  END IF;
  IF v_row.user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot verify your own payout destination.';
  END IF;

  UPDATE public.payout_destination_verifications
  SET status = v_decision,
      decision_reason = v_reason,
      call_outcome = nullif(btrim(coalesce(p_call_outcome,'')), ''),
      decided_by = v_uid,
      decided_at = now()
  WHERE id = p_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'payout_destination_' || v_decision, 'payout_destination_verifications', p_id::text, v_reason,
          jsonb_build_object('status', v_row.status),
          jsonb_build_object('status', v_decision, 'call_outcome', p_call_outcome, 'owner', v_row.user_id));

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('account_flagged', v_row.user_id,
            jsonb_build_object('kind', 'payout_destination_' || v_decision,
                               'destination_key', v_row.destination_key,
                               'decided_by', v_uid));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'status', v_decision);
END;
$$;

GRANT EXECUTE ON FUNCTION public.finops_decide_payout_destination(uuid,text,text,text) TO authenticated;

-- Financial Ops queue
CREATE OR REPLACE FUNCTION public.finops_payout_verification_queue(
  p_status text DEFAULT 'waiting',
  p_search text DEFAULT NULL,
  p_sort text DEFAULT 'oldest',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  full_name text,
  user_phone text,
  destination_type text,
  provider text,
  momo_number text,
  bank_name text,
  bank_account_number text,
  account_name text,
  national_id text,
  national_id_name text,
  name_match_score numeric,
  name_mismatch_tokens jsonb,
  status text,
  decision_reason text,
  call_outcome text,
  decided_by_name text,
  decided_at timestamptz,
  first_seen_at timestamptz,
  withdrawable_balance numeric,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text := lower(coalesce(nullif(btrim(p_status),''), 'waiting'));
  v_q text := nullif(btrim(coalesce(p_search,'')), '');
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT d.*, p.full_name, p.phone,
           coalesce(w.withdrawable_balance, 0) AS bal,
           dp.full_name AS decider_name
    FROM public.payout_destination_verifications d
    LEFT JOIN public.profiles p ON p.id = d.user_id
    LEFT JOIN public.profiles dp ON dp.id = d.decided_by
    LEFT JOIN public.wallets w ON w.user_id = d.user_id
    WHERE (
        v_status = 'all'
        OR (v_status = 'mismatch' AND d.status = 'waiting' AND d.name_match_score IS NOT NULL AND d.name_match_score < 0.5)
        OR (v_status = 'no_id' AND d.status = 'waiting' AND coalesce(btrim(d.national_id), '') = '')
        OR (v_status IN ('waiting','verified','rejected') AND d.status = v_status)
      )
      AND (
        v_q IS NULL
        OR p.full_name ILIKE '%' || v_q || '%'
        OR coalesce(d.account_name,'') ILIKE '%' || v_q || '%'
        OR coalesce(d.national_id,'') ILIKE '%' || v_q || '%'
        OR coalesce(d.momo_number,'') ILIKE '%' || v_q || '%'
        OR coalesce(d.bank_account_number,'') ILIKE '%' || v_q || '%'
        OR coalesce(p.phone,'') ILIKE '%' || v_q || '%'
      )
  ), counted AS (
    SELECT count(*) AS n FROM base
  )
  SELECT b.id, b.user_id, b.full_name, b.phone, b.destination_type, b.provider,
         b.momo_number, b.bank_name, b.bank_account_number, b.account_name,
         b.national_id, b.national_id_name, b.name_match_score, b.name_mismatch_tokens,
         b.status, b.decision_reason, b.call_outcome, b.decider_name, b.decided_at,
         b.first_seen_at, b.bal, c.n
  FROM base b CROSS JOIN counted c
  ORDER BY
    CASE WHEN lower(coalesce(p_sort,'oldest')) = 'balance' THEN b.bal END DESC NULLS LAST,
    b.first_seen_at ASC
  LIMIT greatest(1, least(coalesce(p_limit,20), 100))
  OFFSET greatest(0, coalesce(p_offset,0));
END;
$$;

GRANT EXECUTE ON FUNCTION public.finops_payout_verification_queue(text,text,text,integer,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.finops_payout_verification_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;

  SELECT jsonb_build_object(
    'waiting', count(*) FILTER (WHERE status = 'waiting'),
    'verified', count(*) FILTER (WHERE status = 'verified'),
    'rejected', count(*) FILTER (WHERE status = 'rejected'),
    'mismatch', count(*) FILTER (WHERE status = 'waiting' AND name_match_score IS NOT NULL AND name_match_score < 0.5),
    'no_id', count(*) FILTER (WHERE status = 'waiting' AND coalesce(btrim(national_id),'') = ''),
    'waiting_balance', coalesce(sum(CASE WHEN status = 'waiting' THEN (SELECT coalesce(w.withdrawable_balance,0) FROM public.wallets w WHERE w.user_id = d.user_id) END), 0)
  ) INTO v_out
  FROM public.payout_destination_verifications d;

  RETURN v_out;
END;
$$;

GRANT EXECUTE ON FUNCTION public.finops_payout_verification_counts() TO authenticated;

-- Trigger: user-initiated withdrawals must target a verified destination
CREATE OR REPLACE FUNCTION public.enforce_withdrawal_destination_verified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF lower(coalesce(NEW.payout_method,'')) NOT IN ('mobile_money','bank_transfer') THEN
    RETURN NEW;
  END IF;
  -- Only the self-service path is gated here; ops/system-initiated rows keep working.
  IF NEW.initiated_by IS DISTINCT FROM NEW.user_id THEN
    RETURN NEW;
  END IF;

  IF NOT public.payout_destination_is_verified(
       NEW.user_id, NEW.payout_method, NEW.mobile_money_number, NEW.bank_name, NEW.bank_account_number) THEN
    RAISE EXCEPTION 'This payout destination is not yet verified. Financial Ops will call you to confirm it belongs to you.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_withdrawal_destination_verified ON public.withdrawal_requests;
CREATE TRIGGER trg_enforce_withdrawal_destination_verified
BEFORE INSERT ON public.withdrawal_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_withdrawal_destination_verified();
