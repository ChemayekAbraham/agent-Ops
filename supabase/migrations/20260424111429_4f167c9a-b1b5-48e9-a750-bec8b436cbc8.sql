-- ============================================================
-- Gate funder/partner capabilities behind active proxy assignments
-- ============================================================

-- 0. Dedupe agent_capabilities so we can add the unique index.
--    Keep the most-recently-granted active row; if none active, keep newest.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY agent_id, capability
           ORDER BY (status = 'active') DESC, granted_at DESC, created_at DESC, id DESC
         ) AS rn
  FROM public.agent_capabilities
)
DELETE FROM public.agent_capabilities ac
USING ranked r
WHERE ac.id = r.id AND r.rn > 1;

-- Add unique constraint (now safe)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_capabilities_agent_capability_uniq'
  ) THEN
    ALTER TABLE public.agent_capabilities
      ADD CONSTRAINT agent_capabilities_agent_capability_uniq
      UNIQUE (agent_id, capability);
  END IF;
END $$;

-- 1. Update default agent kit: REMOVE capture_supporters
CREATE OR REPLACE FUNCTION public.grant_default_agent_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.role = 'agent' AND NEW.enabled = true THEN
    INSERT INTO public.agent_capabilities (agent_id, capability)
    SELECT NEW.user_id, cap
    FROM unnest(ARRAY[
      'collect_rent','onboard_tenants','onboard_landlords',
      'view_agent_dashboard','request_float',
      'manage_subagents','approve_subagents','view_subagent_data'
    ]) AS cap
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. Trigger function: sync proxy caps from proxy_agent_assignments
CREATE OR REPLACE FUNCTION public.sync_proxy_agent_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _agent_id uuid;
  _has_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    _agent_id := OLD.agent_id;
  ELSE
    _agent_id := NEW.agent_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.proxy_agent_assignments
    WHERE agent_id = _agent_id
      AND is_active = true
      AND approval_status = 'approved'
  ) INTO _has_active;

  IF _has_active THEN
    INSERT INTO public.agent_capabilities (agent_id, capability, status, granted_at, revoked_at, revoked_by)
    SELECT _agent_id, cap, 'active', now(), NULL, NULL
    FROM unnest(ARRAY['act_as_proxy','capture_supporters']) AS cap
    ON CONFLICT (agent_id, capability) DO UPDATE
      SET status = 'active', revoked_at = NULL, revoked_by = NULL, granted_at = now();
  ELSE
    UPDATE public.agent_capabilities
       SET status = 'revoked', revoked_at = now()
     WHERE agent_id = _agent_id
       AND capability IN ('act_as_proxy','capture_supporters')
       AND status = 'active';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.agent_id IS DISTINCT FROM NEW.agent_id THEN
    SELECT EXISTS (
      SELECT 1 FROM public.proxy_agent_assignments
      WHERE agent_id = OLD.agent_id
        AND is_active = true
        AND approval_status = 'approved'
    ) INTO _has_active;
    IF NOT _has_active THEN
      UPDATE public.agent_capabilities
         SET status = 'revoked', revoked_at = now()
       WHERE agent_id = OLD.agent_id
         AND capability IN ('act_as_proxy','capture_supporters')
         AND status = 'active';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_proxy_agent_capabilities ON public.proxy_agent_assignments;
CREATE TRIGGER trg_sync_proxy_agent_capabilities
AFTER INSERT OR UPDATE OF is_active, approval_status, agent_id
       OR DELETE
ON public.proxy_agent_assignments
FOR EACH ROW
EXECUTE FUNCTION public.sync_proxy_agent_capabilities();

-- 3. Backfill: revoke proxy-only caps from agents without active proxy assignments
UPDATE public.agent_capabilities ac
   SET status = 'revoked', revoked_at = now()
 WHERE ac.capability IN ('capture_supporters','act_as_proxy')
   AND ac.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM public.proxy_agent_assignments paa
     WHERE paa.agent_id = ac.agent_id
       AND paa.is_active = true
       AND paa.approval_status = 'approved'
   );

-- 4. Backfill: ensure all active proxy agents DO have both caps
INSERT INTO public.agent_capabilities (agent_id, capability, status)
SELECT DISTINCT paa.agent_id, cap, 'active'
FROM public.proxy_agent_assignments paa
CROSS JOIN unnest(ARRAY['act_as_proxy','capture_supporters']) AS cap
WHERE paa.is_active = true
  AND paa.approval_status = 'approved'
ON CONFLICT (agent_id, capability) DO UPDATE
  SET status = 'active', revoked_at = NULL, revoked_by = NULL;