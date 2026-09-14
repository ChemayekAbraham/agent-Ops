CREATE OR REPLACE FUNCTION public.finops_payout_status_timeline(
  p_user_id uuid,
  p_withdrawal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  occurred_at timestamptz,
  kind text,
  label text,
  detail text,
  actor_name text,
  badge text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'financial_ops') OR
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  WITH events AS (
    -- The payout request itself
    SELECT w.created_at AS occurred_at,
           'requested'::text AS kind,
           'Payout requested'::text AS label,
           ('UGX ' || to_char(w.amount, 'FM999,999,999,999') || ' · ' ||
             replace(coalesce(w.payout_method, 'payout'), '_', ' '))::text AS detail,
           NULL::text AS actor_name,
           'pending'::text AS badge
    FROM withdrawal_requests w
    WHERE w.user_id = p_user_id
      AND (p_withdrawal_id IS NULL OR w.id = p_withdrawal_id)

    UNION ALL
    -- Payout destination first seen (Pending starts here)
    SELECT v.first_seen_at,
           'destination_added',
           'Payout destination added',
           coalesce(
             nullif(concat_ws(' · ', v.provider, v.momo_number), ''),
             nullif(concat_ws(' · ', v.bank_name, v.bank_account_number), ''),
             v.destination_key
           ),
           NULL,
           'pending'
    FROM payout_destination_verifications v
    WHERE v.user_id = p_user_id AND v.first_seen_at IS NOT NULL

    UNION ALL
    -- National ID number submitted / resubmitted
    SELECT DISTINCT v.national_id_submitted_at,
           'national_id',
           'National ID submitted',
           nullif(concat_ws(' · ', v.national_id, v.national_id_name), ''),
           NULL,
           CASE WHEN coalesce(v.name_match_score, 1) < 0.5 THEN 'needs_review' ELSE 'pending' END
    FROM payout_destination_verifications v
    WHERE v.user_id = p_user_id AND v.national_id_submitted_at IS NOT NULL

    UNION ALL
    -- ID photo + selfie submitted
    SELECT p.identity_photos_submitted_at,
           'photos',
           'National ID photo and selfie submitted',
           'Ready for a Financial Ops decision',
           NULL,
           'needs_review'
    FROM profiles p
    WHERE p.id = p_user_id AND p.identity_photos_submitted_at IS NOT NULL

    UNION ALL
    -- Financial Ops decision
    SELECT v.decided_at,
           CASE WHEN v.status = 'verified' THEN 'verified' ELSE 'rejected' END,
           CASE WHEN v.status = 'verified' THEN 'Verified by Financial Ops'
                ELSE 'Rejected by Financial Ops' END,
           nullif(concat_ws(' · ', v.decision_reason, v.call_outcome), ''),
           d.full_name,
           CASE WHEN v.status = 'verified' THEN 'verified' ELSE 'needs_review' END
    FROM payout_destination_verifications v
    LEFT JOIN profiles d ON d.id = v.decided_by
    WHERE v.user_id = p_user_id AND v.decided_at IS NOT NULL

    UNION ALL
    -- Verification-related audit trail notes
    SELECT a.created_at,
           'note',
           replace(a.action_type, '_', ' '),
           nullif(a.reason, ''),
           act.full_name,
           NULL
    FROM audit_logs a
    LEFT JOIN profiles act ON act.id = a.user_id
    WHERE a.record_id = p_user_id::text
      AND a.action_type IN (
        'identity_photos_submitted',
        'verification_selfie_stored',
        'national_id_submitted',
        'payout_destination_verified',
        'payout_destination_rejected',
        'verified_selfie_set_as_avatar'
      )
  )
  SELECT e.occurred_at, e.kind, e.label, e.detail, e.actor_name, e.badge
  FROM events e
  WHERE e.occurred_at IS NOT NULL
  ORDER BY e.occurred_at DESC
  LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.finops_payout_status_timeline(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finops_payout_status_timeline(uuid, uuid) TO authenticated;