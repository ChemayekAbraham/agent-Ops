-- 1) Promissory notes must never block portfolio creation / top-ups / compounding.
CREATE OR REPLACE FUNCTION public.assert_no_promissory_self_support(p_user uuid, p_path text)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Intentionally a no-op: a pending self-support promissory note is informational
  -- and must not block normal portfolio creation, top-up merges, compounding or renewals.
  RETURN;
END;
$function$;

-- 2) Remove the stale overload that made approve_promissory_note ambiguous.
DROP FUNCTION IF EXISTS public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid, uuid);