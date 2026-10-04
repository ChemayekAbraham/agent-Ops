-- ─────────────────────────────────────────────────────────────
-- 1. BACKFILL: verified flag set by the legacy request panel but
--    verification_status never updated (30 rows) — they were invisible
--    in every status-based list.
-- ─────────────────────────────────────────────────────────────
UPDATE public.lc1_chairpersons c
SET verification_status = 'verified',
    verification_reason = COALESCE(c.verification_reason, 'Backfill: verified via agent request queue (legacy panel did not set status)')
WHERE c.verified IS TRUE
  AND COALESCE(c.verification_status, 'pending') <> 'verified';

-- ─────────────────────────────────────────────────────────────
-- 2. BACKFILL: rejections that only ever landed on the request row.
--    Chairperson stayed "pending" forever with no rejected bucket.
-- ─────────────────────────────────────────────────────────────
WITH latest AS (
  SELECT DISTINCT ON (r.lc1_id)
    r.lc1_id, r.reject_comment, r.resolved_at
  FROM public.lc1_verification_requests r
  WHERE r.status = 'rejected'
  ORDER BY r.lc1_id, COALESCE(r.resolved_at, r.created_at) DESC
)
UPDATE public.lc1_chairpersons c
SET verification_status = 'rejected',
    verification_reason = COALESCE(c.verification_reason, latest.reject_comment,
      'Backfill: rejected in the agent request queue')
FROM latest
WHERE c.id = latest.lc1_id
  AND c.verified IS NOT TRUE
  AND COALESCE(c.verification_status, 'pending') = 'pending';

-- ─────────────────────────────────────────────────────────────
-- 3. UNIFIED INBOX VIEW — the single source for "Agents requesting
--    LC1 verification". Combines agent-raised requests with LC1
--    chairpersons that are awaiting/were decided without a request row,
--    so nothing can hide in a second queue.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_lc1_verification_inbox
WITH (security_invoker = true) AS
SELECT
  c.id                                            AS lc1_id,
  r.id                                            AS request_id,
  c.name                                          AS lc1_name,
  c.phone                                         AS lc1_phone,
  c.village                                       AS lc1_village,
  c.district                                      AS lc1_district,
  c.region                                        AS lc1_region,
  c.parish                                        AS lc1_parish,
  c.sub_county                                    AS lc1_sub_county,
  COALESCE(c.verification_status, 'pending')       AS status,
  c.verification_reason                            AS reason,
  c.verified                                       AS verified_flag,
  c.verified_at,
  c.verified_by,
  vp.full_name                                     AS reviewer_name,
  c.registered_by                                  AS agent_id,
  COALESCE(r.agent_name, ap.full_name)             AS agent_name,
  COALESCE(r.agent_phone, ap.phone)                AS agent_phone,
  r.note                                           AS agent_note,
  r.reject_comment,
  r.status                                         AS request_status,
  r.resolved_at,
  rp.full_name                                     AS resolved_by_name,
  CASE WHEN r.id IS NOT NULL THEN 'agent_request' ELSE 'registration' END AS source,
  COALESCE(r.created_at, c.registered_at, c.created_at) AS requested_at,
  c.created_at                                     AS lc1_created_at,
  c.verification_bonus_paid,
  (SELECT count(*) FROM public.landlords l WHERE l.phone IS NOT NULL AND l.phone = c.phone) AS linked_landlords
FROM public.lc1_chairpersons c
LEFT JOIN LATERAL (
  SELECT r2.*
  FROM public.lc1_verification_requests r2
  WHERE r2.lc1_id = c.id
  ORDER BY COALESCE(r2.resolved_at, r2.created_at) DESC
  LIMIT 1
) r ON TRUE
LEFT JOIN public.profiles ap ON ap.id = c.registered_by
LEFT JOIN public.profiles vp ON vp.id = c.verified_by
LEFT JOIN public.profiles rp ON rp.id = r.resolved_by;

GRANT SELECT ON public.v_lc1_verification_inbox TO authenticated;
GRANT SELECT ON public.v_lc1_verification_inbox TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 4. Every ops decision leaves a request trail, even when no agent
--    raised one — so the inbox history is complete.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_lc1_verification(p_lc1_id uuid, p_status text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text;
  v_phone text;
  v_village text;
  v_registered_by uuid;
  v_reason text := btrim(p_reason);
  v_title text;
  v_message text;
  v_type text;
  v_charge_amount integer := 2000;
  v_agent_charged boolean := false;
  v_touched int := 0;
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_status NOT IN ('pending','verified','rejected') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  UPDATE public.lc1_chairpersons
  SET verification_status = p_status,
      verification_reason = v_reason,
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END
  WHERE id = p_lc1_id
  RETURNING name, phone, village, registered_by INTO v_name, v_phone, v_village, v_registered_by;
  IF NOT FOUND THEN RAISE EXCEPTION 'LC1 chairperson not found'; END IF;

  UPDATE public.lc1_verification_requests
  SET status = p_status,
      reject_comment = CASE WHEN p_status = 'rejected' THEN v_reason ELSE reject_comment END,
      resolved_by = v_actor,
      resolved_at = now()
  WHERE lc1_id = p_lc1_id AND status = 'pending';
  GET DIAGNOSTICS v_touched = ROW_COUNT;

  -- No open agent request: write the decision trail so the unified inbox
  -- keeps a complete history of who decided what and why.
  IF v_touched = 0 AND p_status <> 'pending' THEN
    INSERT INTO public.lc1_verification_requests
      (lc1_id, lc1_name, lc1_phone, lc1_village, requested_by, note, status, reject_comment, resolved_by, resolved_at)
    VALUES
      (p_lc1_id, v_name, v_phone, v_village, COALESCE(v_registered_by, v_actor),
       'Ops-initiated review (no agent request on file)', p_status,
       CASE WHEN p_status = 'rejected' THEN v_reason ELSE NULL END, v_actor, now());
  END IF;

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'lc1_verification_status_set', 'lc1_chairpersons', p_lc1_id,
    jsonb_build_object('status', p_status, 'reason', v_reason));

  IF p_status = 'verified' THEN
    v_type := 'success'; v_title := 'LC1 chairperson verified';
    v_message := 'Your LC1 chairperson' || COALESCE(' (' || v_name || ')', '') || ' has been verified. You can now request a loan.';
  ELSIF p_status = 'rejected' THEN
    v_type := 'error'; v_title := 'LC1 verification rejected';
    v_message := 'Your LC1 chairperson' || COALESCE(' (' || v_name || ')', '') || ' verification was rejected. Reason: ' || v_reason;
  ELSE
    v_type := 'info'; v_title := 'LC1 verification pending';
    v_message := 'Your LC1 chairperson' || COALESCE(' (' || v_name || ')', '') || ' verification is under review. ' || v_reason;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT p.id, v_title, v_message, v_type,
    jsonb_build_object('kind', 'lc1_verification', 'lc1_id', p_lc1_id, 'status', p_status, 'reason', v_reason)
  FROM public.profiles p
  WHERE p.borrower_lc1_id = p_lc1_id;

  IF p_status = 'rejected' AND v_registered_by IS NOT NULL THEN
    BEGIN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_registered_by, 'amount', v_charge_amount, 'direction', 'cash_out',
            'category', 'listing_rejection_penalty', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable',
            'source_table', 'lc1_chairpersons', 'source_id', p_lc1_id::text,
            'description', 'LC1 chairperson rejection charge — ' || COALESCE(v_name, 'LC1'), 'currency', 'UGX'),
          jsonb_build_object('amount', v_charge_amount, 'direction', 'cash_in',
            'category', 'listing_rejection_recovery', 'ledger_scope', 'platform',
            'source_table', 'lc1_chairpersons', 'source_id', p_lc1_id::text,
            'description', 'Recovery: LC1 chairperson rejection charge — ' || COALESCE(v_name, 'LC1'), 'currency', 'UGX')
        ),
        'lc1_rejection_charge:' || p_lc1_id::text,
        true
      );
      v_agent_charged := true;
    EXCEPTION WHEN OTHERS THEN v_agent_charged := false;
    END;

    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_registered_by, '🚫 LC1 Chairperson Rejected',
      'The LC1 chairperson "' || COALESCE(v_name, 'chairperson') || '" you registered was rejected. Reason: ' || v_reason ||
        CASE WHEN v_agent_charged THEN '. A UGX ' || v_charge_amount || ' charge was applied to your wallet.' ELSE '' END,
      'warning',
      jsonb_build_object('kind', 'lc1_rejection_penalty', 'lc1_id', p_lc1_id, 'lc1_name', v_name,
        'reason', v_reason, 'charge', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END, 'action', 'lc1_rejected'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'lc1_id', p_lc1_id, 'status', p_status,
    'agent_id', v_registered_by, 'agent_charged', v_agent_charged,
    'charge_amount', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_lc1_verification(uuid, text, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 5. REPORT SOURCE — comprehensive, filterable export feed.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ops_lc1_verification_report(
  p_status text DEFAULT 'verified',
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit int DEFAULT 3000
)
RETURNS SETOF public.v_lc1_verification_inbox
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  RETURN QUERY
  SELECT * FROM public.v_lc1_verification_inbox v
  WHERE (p_status IS NULL OR p_status = 'all' OR v.status = p_status)
    AND (p_from IS NULL OR COALESCE(v.verified_at, v.resolved_at, v.requested_at) >= p_from)
    AND (p_to IS NULL OR COALESCE(v.verified_at, v.resolved_at, v.requested_at) <= p_to)
    AND (
      v_search IS NULL
      OR v.lc1_name ILIKE '%' || v_search || '%'
      OR v.lc1_phone ILIKE '%' || v_search || '%'
      OR v.lc1_village ILIKE '%' || v_search || '%'
      OR v.lc1_district ILIKE '%' || v_search || '%'
      OR v.agent_name ILIKE '%' || v_search || '%'
    )
  ORDER BY COALESCE(v.verified_at, v.resolved_at, v.requested_at) DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 3000), 20000));
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_lc1_verification_report(text, timestamptz, timestamptz, text, int) TO authenticated;