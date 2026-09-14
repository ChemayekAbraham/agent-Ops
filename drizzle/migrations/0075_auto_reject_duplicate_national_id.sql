-- 1. One National ID may only ever belong to one account.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_national_id_unique_norm
  ON public.profiles (upper(regexp_replace(national_id, '[^A-Za-z0-9]', '', 'g')))
  WHERE national_id IS NOT NULL
    AND length(regexp_replace(national_id, '[^A-Za-z0-9]', '', 'g')) >= 6;

-- 2. Helper: which other account already holds this National ID?
CREATE OR REPLACE FUNCTION public.duplicate_national_id_owner(p_user_id uuid, p_national_id text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id text := upper(regexp_replace(coalesce(p_national_id, ''), '[^A-Za-z0-9]', '', 'g'));
  v_owner uuid;
BEGIN
  IF length(v_id) < 6 THEN
    RETURN NULL;
  END IF;

  SELECT p.id INTO v_owner
  FROM public.profiles p
  WHERE p.id IS DISTINCT FROM p_user_id
    AND upper(regexp_replace(coalesce(p.national_id, ''), '[^A-Za-z0-9]', '', 'g')) = v_id
  LIMIT 1;

  IF v_owner IS NOT NULL THEN
    RETURN v_owner;
  END IF;

  SELECT d.user_id INTO v_owner
  FROM public.payout_destination_verifications d
  WHERE d.user_id IS DISTINCT FROM p_user_id
    AND d.status = 'verified'
    AND upper(regexp_replace(coalesce(d.national_id, ''), '[^A-Za-z0-9]', '', 'g')) = v_id
  LIMIT 1;

  RETURN v_owner;
END;
$$;

GRANT EXECUTE ON FUNCTION public.duplicate_national_id_owner(uuid, text) TO authenticated;

-- 3. Auto-reject any payout destination carrying a National ID already on another account.
CREATE OR REPLACE FUNCTION public.auto_reject_duplicate_national_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF coalesce(btrim(NEW.national_id), '') = '' OR NEW.status = 'rejected' THEN
    RETURN NEW;
  END IF;

  v_owner := public.duplicate_national_id_owner(NEW.user_id, NEW.national_id);
  IF v_owner IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.status := 'rejected';
  NEW.decision_reason := 'Automatically rejected: this National ID is already recorded on another account. One National ID may only be used by one account.';
  NEW.decided_at := now();

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (NEW.user_id, 'payout_destination_auto_rejected_duplicate_id',
            'payout_destination_verifications', NEW.id::text,
            'Automatic rejection: National ID already used on another account.',
            jsonb_build_object('national_id', NEW.national_id, 'duplicate_of_user_id', v_owner));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('account_flagged', NEW.user_id,
            jsonb_build_object('kind', 'duplicate_national_id', 'duplicate_of_user_id', v_owner));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_reject_duplicate_national_id ON public.payout_destination_verifications;
CREATE TRIGGER trg_auto_reject_duplicate_national_id
BEFORE INSERT OR UPDATE ON public.payout_destination_verifications
FOR EACH ROW EXECUTE FUNCTION public.auto_reject_duplicate_national_id();

-- 4. Financial Ops can never verify a duplicate-ID destination: the decision flips to a rejection.
CREATE OR REPLACE FUNCTION public.finops_decide_payout_destination(
  p_id uuid, p_decision text, p_reason text, p_call_outcome text DEFAULT NULL)
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
  v_id_name text;
  v_old_name text;
  v_source text;
  v_dup uuid;
  v_dup_name text;
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

  -- Same National ID on another account: forced rejection, whatever was tapped.
  v_dup := public.duplicate_national_id_owner(v_row.user_id, v_row.national_id);
  IF v_dup IS NOT NULL AND v_decision = 'verified' THEN
    SELECT full_name INTO v_dup_name FROM public.profiles WHERE id = v_dup;
    v_decision := 'rejected';
    v_reason := 'Automatically rejected: this National ID is already recorded on another account ('
                || coalesce(v_dup_name, 'unnamed account') || '). One National ID may only be used by one account.';
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
          jsonb_build_object('status', v_decision, 'call_outcome', p_call_outcome, 'owner', v_row.user_id,
                             'duplicate_of_user_id', v_dup));

  IF v_decision = 'verified' THEN
    v_id_name := btrim(coalesce(nullif(btrim(coalesce(v_row.final_name_override,'')), ''), v_row.national_id_name, ''));
    v_source := CASE WHEN nullif(btrim(coalesce(v_row.final_name_override,'')), '') IS NOT NULL
                     THEN 'financial_ops_manual_override' ELSE 'national_id_ocr' END;
    IF length(v_id_name) >= 3 THEN
      SELECT full_name INTO v_old_name FROM public.profiles WHERE id = v_row.user_id;
      IF v_old_name IS DISTINCT FROM v_id_name THEN
        UPDATE public.profiles SET full_name = v_id_name WHERE id = v_row.user_id;
        INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
        VALUES (v_uid, 'payout_holder_name_from_national_id', 'profiles', v_row.user_id::text,
                'Verified holder name applied during payout verification.',
                jsonb_build_object('full_name', v_old_name),
                jsonb_build_object('full_name', v_id_name, 'source', v_source));
      END IF;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('account_flagged', v_row.user_id,
            jsonb_build_object('kind', 'payout_destination_' || v_decision,
                               'destination_key', v_row.destination_key,
                               'decided_by', v_uid));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'status', v_decision,
    'auto_rejected_duplicate_id', v_dup IS NOT NULL,
    'duplicate_of_name', v_dup_name,
    'full_name', CASE WHEN v_decision = 'verified' AND length(coalesce(v_id_name,'')) >= 3 THEN v_id_name ELSE NULL END,
    'name_source', CASE WHEN v_decision = 'verified' AND length(coalesce(v_id_name,'')) >= 3
                        THEN CASE WHEN v_source = 'financial_ops_manual_override' THEN 'verified' ELSE 'national_id' END
                        ELSE NULL END
  );
END;
$$;

-- 5. Surface the duplicate on the queue so Financial Ops see it before calling.
DROP FUNCTION IF EXISTS public.finops_payout_verification_queue(text, text, text, integer, integer);
CREATE FUNCTION public.finops_payout_verification_queue(
  p_status text DEFAULT 'waiting', p_search text DEFAULT NULL, p_sort text DEFAULT 'ready_first',
  p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
RETURNS TABLE(
  id uuid, user_id uuid, full_name text, user_phone text, destination_type text, provider text,
  momo_number text, bank_name text, bank_account_number text, account_name text,
  national_id text, national_id_name text, name_match_score numeric, name_mismatch_tokens jsonb,
  status text, decision_reason text, call_outcome text, decided_by_name text,
  decided_at timestamp with time zone, first_seen_at timestamp with time zone,
  withdrawable_balance numeric, name_source text,
  duplicate_id_user_id uuid, duplicate_id_name text, total_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text := lower(coalesce(nullif(btrim(p_status),''), 'waiting'));
  v_q text := nullif(btrim(coalesce(p_search,'')), '');
  v_sort text := lower(coalesce(nullif(btrim(p_sort),''), 'ready_first'));
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
           dp.full_name AS decider_name,
           (p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT NULL) AS photos_ready,
           public.duplicate_national_id_owner(d.user_id, d.national_id) AS dup_user
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
         b.first_seen_at, b.bal,
         CASE
           WHEN nullif(btrim(coalesce(b.final_name_override, '')), '') IS NOT NULL THEN 'verified'
           WHEN b.national_id_name IS NOT NULL AND btrim(b.national_id_name) <> ''
                AND lower(btrim(coalesce(b.full_name, ''))) = lower(btrim(b.national_id_name)) THEN 'national_id'
           ELSE NULL
         END AS name_source,
         b.dup_user,
         (SELECT dpp.full_name FROM public.profiles dpp WHERE dpp.id = b.dup_user),
         c.n
  FROM base b CROSS JOIN counted c
  ORDER BY
    CASE WHEN v_sort = 'ready_first' THEN (b.photos_ready::int) END DESC,
    CASE WHEN v_sort IN ('ready_first','newest') THEN coalesce(b.national_id_submitted_at, b.first_seen_at) END DESC NULLS LAST,
    CASE WHEN v_sort = 'balance' THEN b.bal END DESC NULLS LAST,
    CASE WHEN v_sort = 'oldest' THEN b.first_seen_at END ASC NULLS LAST,
    b.first_seen_at ASC
  LIMIT greatest(1, least(coalesce(p_limit,20), 100))
  OFFSET greatest(0, coalesce(p_offset,0));
END;
$$;

GRANT EXECUTE ON FUNCTION public.finops_payout_verification_queue(text, text, text, integer, integer) TO authenticated;