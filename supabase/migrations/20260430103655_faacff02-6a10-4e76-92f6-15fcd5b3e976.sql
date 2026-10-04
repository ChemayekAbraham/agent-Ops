CREATE OR REPLACE FUNCTION public.get_funder_approval_status(_user_id uuid)
 RETURNS TABLE(status text, rejection_reason text, approved_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_signup_source        text;
  v_funder_verified_at   timestamptz;
  v_funder_rejected_at   timestamptz;
  v_funder_rej_reason    text;
BEGIN
  SELECT p.signup_source, p.funder_verified_at, p.funder_rejected_at, p.funder_rejection_reason
    INTO v_signup_source, v_funder_verified_at, v_funder_rejected_at, v_funder_rej_reason
  FROM public.profiles p
  WHERE p.id = _user_id;

  IF v_signup_source = 'funder-onboarding' THEN
    IF v_funder_verified_at IS NOT NULL THEN
      RETURN QUERY SELECT 'approved'::text, NULL::text, v_funder_verified_at;
      RETURN;
    ELSIF v_funder_rejected_at IS NOT NULL THEN
      RETURN QUERY SELECT 'rejected'::text, v_funder_rej_reason, NULL::timestamptz;
      RETURN;
    ELSE
      RETURN QUERY SELECT 'pending'::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;

  -- Non self-registered users: previous proxy-assignment behavior.
  -- Aliased CTE columns to avoid ambiguity with the function's RETURNS TABLE columns
  -- (was raising "column reference 'rejection_reason' is ambiguous" 30+/hr).
  RETURN QUERY
  WITH ranked AS (
    SELECT
      paa.approval_status   AS r_status,
      paa.rejection_reason  AS r_reason,
      paa.approved_at       AS r_approved_at,
      paa.is_active         AS r_active,
      CASE
        WHEN paa.approval_status = 'approved' AND paa.is_active = true THEN 1
        WHEN paa.approval_status = 'pending'  THEN 2
        WHEN paa.approval_status = 'rejected' THEN 3
        ELSE 4
      END AS rank
    FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = _user_id
      AND paa.beneficiary_role = 'supporter'
    ORDER BY rank ASC, paa.created_at DESC
    LIMIT 1
  )
  SELECT
    COALESCE(
      CASE
        WHEN r.r_status = 'approved' AND r.r_active = true THEN 'approved'
        ELSE r.r_status
      END,
      'none'
    )::text,
    r.r_reason::text,
    r.r_approved_at
  FROM ranked r
  UNION ALL
  SELECT 'none'::text, NULL::text, NULL::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM ranked)
  LIMIT 1;
END;
$function$;