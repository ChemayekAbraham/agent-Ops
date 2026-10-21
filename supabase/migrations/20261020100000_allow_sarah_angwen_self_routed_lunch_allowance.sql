-- Allow the CFO, Sarah Angwen, to post her own Daily lunch allowance (doc 247).
--
-- NOT APPLIED. Josh applies this by hand.
--
-- CFO Direct Credit refused her own 3,000 lunch allowance with
-- WALLET_CORRECTION_SELF_BLOCKED. That error comes from the trigger
-- guard_platform_wallet_correction on platform_wallet_corrections: a correction
-- whose author is also its target is refused unless the author passes
-- wallet_self_route_allowed(), which reads wallet_self_route_allowed__impl().
-- The allowlist there is hard-coded to four people (Joshua Wanda, Nankambo
-- sharimah, Bayo Mercy, Mercy Bayo). Staff are paid the same allowance through
-- the same tool; only the CFO's own is blocked.
--
-- Change: add SARAH ANGWEN (29a0cfa8-1eaf-453c-874c-0fc72fa4f74b) to the list.
-- Nothing else changes: the trigger, the CFO/Financial Ops role gate, the
-- 20-character evidence floor and the self_authored_operator metadata marker
-- all stay. Self-authored rows stay identifiable by that marker.
--
-- Scope warning: this allowlist is not limited by amount or category. It lets
-- her post ANY self-credit through this guard, not only the lunch allowance.
-- A narrower rule (credit only, 3,000 or less) was offered and not chosen.
--
-- The live definition is checked before it is replaced. If it no longer holds
-- exactly the four expected ids (someone edited it by hand), this aborts and
-- changes nothing.
-- Neither wallet_self_route_allowed__impl nor guard_platform_wallet_correction
-- is in critical_function_baselines (checked 2026-10-20), so no re-baseline.

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.wallet_self_route_allowed__impl(uuid)'::regprocedure);
BEGIN
  IF v_def NOT LIKE '%cb798acb-68bc-4b4e-a414-a3d374e030b6%'
     OR v_def NOT LIKE '%59d45ad2-0d44-433c-b4ec-20927a25c281%'
     OR v_def NOT LIKE '%cfa56623-e6cb-4023-b601-3dbd4fdbc027%'
     OR v_def NOT LIKE '%6b7d9eee-4bc8-47ac-a2e6-b84cbaac8bb4%' THEN
    RAISE EXCEPTION 'wallet_self_route_allowed__impl no longer matches the expected four-person list; not replacing it';
  END IF;
  IF v_def LIKE '%29a0cfa8-1eaf-453c-874c-0fc72fa4f74b%' THEN
    RAISE EXCEPTION 'Sarah Angwen is already on the self-route allowlist; nothing to do';
  END IF;
END
$mig$;

CREATE OR REPLACE FUNCTION public.wallet_self_route_allowed__impl(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IN (
    'cb798acb-68bc-4b4e-a414-a3d374e030b6'::uuid, -- JOSHUA WANDA
    '59d45ad2-0d44-433c-b4ec-20927a25c281'::uuid, -- Nankambo sharimah
    'cfa56623-e6cb-4023-b601-3dbd4fdbc027'::uuid, -- Bayo Mercy
    '6b7d9eee-4bc8-47ac-a2e6-b84cbaac8bb4'::uuid, -- Mercy Bayo
    '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'::uuid  -- SARAH ANGWEN (CFO), daily lunch allowance
  );
$function$;

-- Verify (read-only):
--   SELECT public.wallet_self_route_allowed__impl('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'); -- true
--   SELECT public.wallet_self_route_allowed__impl('98ee118b-06d1-47a4-aa2b-76bd12170b70'); -- false
-- Rollback: re-run the CREATE OR REPLACE above without the SARAH ANGWEN line.
