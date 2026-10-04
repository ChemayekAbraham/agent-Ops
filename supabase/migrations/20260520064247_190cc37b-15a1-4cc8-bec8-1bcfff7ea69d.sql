-- 1) Trigger function: when an assignment becomes active for a beneficiary,
-- deactivate every other active assignment for the same beneficiary.
CREATE OR REPLACE FUNCTION public.deactivate_stale_proxy_assignments()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active = true AND NEW.approval_status = 'approved' THEN
    UPDATE public.proxy_agent_assignments
       SET is_active = false,
           updated_at = now()
     WHERE beneficiary_id = NEW.beneficiary_id
       AND id <> NEW.id
       AND is_active = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deactivate_stale_proxy_assignments ON public.proxy_agent_assignments;
CREATE TRIGGER trg_deactivate_stale_proxy_assignments
AFTER INSERT OR UPDATE OF is_active, agent_id, approval_status
ON public.proxy_agent_assignments
FOR EACH ROW
EXECUTE FUNCTION public.deactivate_stale_proxy_assignments();

-- 2) Backfill: for every beneficiary with >1 active assignment, keep only the newest active.
WITH ranked AS (
  SELECT id,
         beneficiary_id,
         ROW_NUMBER() OVER (
           PARTITION BY beneficiary_id
           ORDER BY created_at DESC, updated_at DESC
         ) AS rn
    FROM public.proxy_agent_assignments
   WHERE is_active = true
)
UPDATE public.proxy_agent_assignments p
   SET is_active = false,
       updated_at = now()
  FROM ranked r
 WHERE p.id = r.id
   AND r.rn > 1;