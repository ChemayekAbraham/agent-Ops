-- ============================================================
-- Funder Approval Gate (retry — orphan-safe)
-- ============================================================

CREATE OR REPLACE FUNCTION public.ensure_supporter_pending_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role <> 'supporter' THEN
    RETURN NEW;
  END IF;
  IF NEW.enabled IS NOT NULL AND NEW.enabled = false THEN
    RETURN NEW;
  END IF;

  -- Skip if profile is missing (FK would fail).
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.user_id) THEN
    RETURN NEW;
  END IF;

  -- Skip if any assignment row already exists for this funder.
  IF EXISTS (
    SELECT 1 FROM public.proxy_agent_assignments
    WHERE beneficiary_id = NEW.user_id
      AND beneficiary_role = 'supporter'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.proxy_agent_assignments (
    agent_id, beneficiary_id, beneficiary_role,
    assigned_by, reason, approval_status, is_active, is_managed_account
  ) VALUES (
    NEW.user_id, NEW.user_id, 'supporter',
    NEW.user_id, 'Self-registered funder — awaiting Partner Ops verification',
    'pending', false, false
  )
  ON CONFLICT (agent_id, beneficiary_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_supporter_pending_approval_ins ON public.user_roles;
CREATE TRIGGER trg_ensure_supporter_pending_approval_ins
AFTER INSERT ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.ensure_supporter_pending_approval();

DROP TRIGGER IF EXISTS trg_ensure_supporter_pending_approval_upd ON public.user_roles;
CREATE TRIGGER trg_ensure_supporter_pending_approval_upd
AFTER UPDATE OF enabled ON public.user_roles
FOR EACH ROW
WHEN (NEW.role = 'supporter' AND (NEW.enabled IS NULL OR NEW.enabled = true))
EXECUTE FUNCTION public.ensure_supporter_pending_approval();

-- Backfill: only supporters with an existing profile.
INSERT INTO public.proxy_agent_assignments (
  agent_id, beneficiary_id, beneficiary_role,
  assigned_by, reason, approval_status, is_active, is_managed_account
)
SELECT ur.user_id, ur.user_id, 'supporter',
       ur.user_id, 'Backfilled self-pending — awaiting Partner Ops verification',
       'pending', false, false
FROM public.user_roles ur
JOIN public.profiles p ON p.id = ur.user_id
WHERE ur.role = 'supporter'
  AND (ur.enabled IS NULL OR ur.enabled = true)
  AND NOT EXISTS (
    SELECT 1 FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = ur.user_id
      AND paa.beneficiary_role = 'supporter'
  )
ON CONFLICT (agent_id, beneficiary_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_funder_approval_status(_user_id uuid)
RETURNS TABLE (
  status text,
  rejection_reason text,
  approved_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ranked AS (
    SELECT
      paa.approval_status,
      paa.rejection_reason,
      paa.approved_at,
      paa.is_active,
      CASE
        WHEN paa.approval_status = 'approved' AND paa.is_active = true THEN 1
        WHEN paa.approval_status = 'pending' THEN 2
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
        WHEN approval_status = 'approved' AND is_active = true THEN 'approved'
        ELSE approval_status
      END,
      'none'
    ) AS status,
    rejection_reason,
    approved_at
  FROM ranked
  UNION ALL
  SELECT 'none'::text, NULL::text, NULL::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM ranked)
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_funder_approval_status(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.is_funder_approved(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.proxy_agent_assignments
    WHERE beneficiary_id = _user_id
      AND beneficiary_role = 'supporter'
      AND approval_status = 'approved'
      AND is_active = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_funder_approved(uuid) TO authenticated;