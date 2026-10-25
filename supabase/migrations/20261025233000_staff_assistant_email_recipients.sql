-- =============================================================================
-- Migration: 20261025233000_staff_assistant_email_recipients.sql
-- Purpose:   Staff email recipient lookup and verification helpers for Zoe
--            (My Space AI Assistant):
--              1. public.staff_assistant_email_recipients(p_search text)
--              2. public.staff_assistant_is_staff_email(p_email text)
--
-- Safety:
--   - Read-only (STABLE), SECURITY DEFINER, SET search_path = public.
--   - Granted EXECUTE to authenticated only (revoked from PUBLIC, anon, service_role).
--   - Returns nothing / false unless the caller passes public.staff_assistant_has_access().
--   - Filters strictly to profiles with an enabled staff role and a non-empty
--     deliverable profile email (excluding synthetic phone-login placeholders).
--   - Does not modify any data or existing objects.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. public.staff_assistant_email_recipients(p_search text)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_email_recipients(
  p_search text DEFAULT NULL
)
RETURNS TABLE (
  staff_user_id uuid,
  full_name text,
  email text,
  roles text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q text := btrim(coalesce(p_search, ''));
BEGIN
  IF NOT public.staff_assistant_has_access() THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH eligible_staff AS (
    SELECT
      p.id AS staff_user_id,
      btrim(coalesce(p.full_name, '')) AS full_name,
      btrim(public.assistant_real_email(btrim(p.email))) AS email,
      ARRAY(
        SELECT DISTINCT ur.role::text
        FROM public.user_roles ur
        WHERE ur.user_id = p.id
          AND ur.enabled IS TRUE
          AND (
            ur.role NOT IN (
              'tenant'::public.app_role,
              'landlord'::public.app_role,
              'agent'::public.app_role,
              'supporter'::public.app_role
            )
            OR ur.role::text IN (
              'tenant_ops',
              'landlord_ops',
              'agent_ops',
              'financial_ops',
              'partner_ops',
              'hr',
              'access_admin'
            )
          )
        ORDER BY ur.role::text
      ) AS roles
    FROM public.profiles p
    WHERE nullif(btrim(coalesce(public.assistant_real_email(btrim(p.email)), '')), '') IS NOT NULL
      AND (
        public.is_welile_staff(p.id)
        OR EXISTS (
          SELECT 1
          FROM public.user_roles ur
          WHERE ur.user_id = p.id
            AND ur.enabled IS TRUE
            AND ur.role::text IN (
              'tenant_ops',
              'landlord_ops',
              'agent_ops',
              'financial_ops',
              'partner_ops',
              'hr',
              'access_admin'
            )
        )
      )
  )
  SELECT
    es.staff_user_id,
    es.full_name,
    es.email,
    es.roles
  FROM eligible_staff es
  WHERE v_q = ''
     OR es.full_name ILIKE '%' || v_q || '%'
     OR es.email ILIKE '%' || v_q || '%'
  ORDER BY
    CASE
      WHEN v_q <> '' AND (
        lower(es.full_name) = lower(v_q)
        OR lower(es.email) = lower(v_q)
      ) THEN 0
      WHEN v_q <> '' AND (
        lower(es.full_name) LIKE lower(v_q) || '%'
        OR lower(es.email) LIKE lower(v_q) || '%'
      ) THEN 1
      ELSE 2
    END,
    lower(es.full_name) ASC,
    lower(es.email) ASC,
    es.staff_user_id ASC
  LIMIT 10;
END;
$$;

COMMENT ON FUNCTION public.staff_assistant_email_recipients(text) IS
  'Returns up to 10 staff recipients (staff_user_id, full_name, email, roles) matching p_search by name or email, restricted to users with an enabled staff role and a non-empty real profile email. Returns no rows unless the caller passes staff_assistant_has_access().';

REVOKE ALL ON FUNCTION public.staff_assistant_email_recipients(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_email_recipients(text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. public.staff_assistant_is_staff_email(p_email text)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_is_staff_email(
  p_email text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean text := lower(btrim(coalesce(public.assistant_real_email(btrim(p_email)), '')));
BEGIN
  IF NOT public.staff_assistant_has_access() THEN
    RETURN false;
  END IF;

  IF v_clean = '' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE lower(btrim(coalesce(public.assistant_real_email(btrim(p.email)), ''))) = v_clean
      AND (
        public.is_welile_staff(p.id)
        OR EXISTS (
          SELECT 1
          FROM public.user_roles ur
          WHERE ur.user_id = p.id
            AND ur.enabled IS TRUE
            AND ur.role::text IN (
              'tenant_ops',
              'landlord_ops',
              'agent_ops',
              'financial_ops',
              'partner_ops',
              'hr',
              'access_admin'
            )
        )
      )
  );
END;
$$;

COMMENT ON FUNCTION public.staff_assistant_is_staff_email(text) IS
  'Returns true iff the caller passes staff_assistant_has_access() and p_email matches the non-empty real profile email of a user with an enabled staff role.';

REVOKE ALL ON FUNCTION public.staff_assistant_is_staff_email(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_is_staff_email(text) TO authenticated;

COMMIT;
