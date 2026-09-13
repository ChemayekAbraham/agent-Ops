ALTER TABLE public.payout_destination_verifications
  ADD COLUMN IF NOT EXISTS national_id_submitted_at timestamptz;

CREATE OR REPLACE FUNCTION public.submit_national_id(p_national_id text, p_id_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      national_id_submitted_at = now(),
      name_match_score = (public.payout_name_match_report(v_name, d.account_name)->>'score')::numeric,
      name_mismatch_tokens = coalesce(public.payout_name_match_report(v_name, d.account_name)->'diff', '[]'::jsonb)
  WHERE d.user_id = v_uid;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'national_id_submitted', 'profiles', v_uid::text,
          'User submitted National ID for payout verification',
          jsonb_build_object('national_id', v_id, 'national_id_name', v_name));

  RETURN jsonb_build_object('success', true, 'message', 'National ID recorded. Financial Ops will confirm it against your payout number.');
END;
$function$;

CREATE OR REPLACE FUNCTION public.finops_payout_verification_queue(p_status text DEFAULT 'waiting'::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'newest'::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, user_id uuid, full_name text, user_phone text, destination_type text, provider text, momo_number text, bank_name text, bank_account_number text, account_name text, national_id text, national_id_name text, name_match_score numeric, name_mismatch_tokens jsonb, status text, decision_reason text, call_outcome text, decided_by_name text, decided_at timestamp with time zone, first_seen_at timestamp with time zone, withdrawable_balance numeric, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text := lower(coalesce(nullif(btrim(p_status),''), 'waiting'));
  v_q text := nullif(btrim(coalesce(p_search,'')), '');
  v_sort text := lower(coalesce(nullif(btrim(p_sort),''), 'newest'));
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
    CASE WHEN v_sort = 'balance' THEN b.bal END DESC NULLS LAST,
    CASE WHEN v_sort = 'newest' THEN coalesce(b.national_id_submitted_at, b.first_seen_at) END DESC NULLS LAST,
    b.first_seen_at ASC
  LIMIT greatest(1, least(coalesce(p_limit,20), 100))
  OFFSET greatest(0, coalesce(p_offset,0));
END;
$function$;