-- The tenant must be told when a PERSON cancels their Rent Plan, not only a cron
--
-- Found by the section 9 smoke test on 25 September 2026, run as a real
-- Landlord Ops account against production in a rolled-back transaction.
--
-- 20260925170000 added `manual_recalled` as an outcome — the "Return the float
-- now" button on the new Landlord Ops queue. The tenant cancellation notice
-- (T2) was written in 20260925140000, before that button existed, and filters
-- on `outcome = 'auto_recalled'` alone.
--
-- So: the cron cancels a plan and the tenant is texted "nothing is owed by
-- you". A human cancels the same plan through the new button and the tenant is
-- told **nothing at all** — and the tenant is the one person in the chain who
-- most needs to hear it, because their rent has just been unwound through no
-- fault of theirs. Every one of the 27 backlog cases would have gone out
-- silently.
--
-- Verified by re-running the smoke test after this patch: 1 T2 message queued,
-- addressed to the right tenant, where before the fix it was 0.
--
-- Second fix in the same CTE. The message quotes `rent_requests.rent_amount`,
-- and **4 of the 42 open cases carry rent_amount = 0** — old plans from before
-- pricing was enforced. Those tenants would have received "the Rent Plan for
-- your rent of UGX 0 could not be completed", which is worse than saying
-- nothing. It now falls back to the allocation amount, which is the money that
-- was actually released for that tenant's rent.
--
-- Applied as anchored patches for the usual reason: the function is a large
-- SQL body assembled by two previous migrations and retyping it is how that
-- gets broken. Each replace() is asserted, so drift fails loudly.

DO $do$
DECLARE src text; before text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='rent_plan_transition_notices_pending';

  IF src IS NULL THEN RAISE EXCEPTION 'rent_plan_transition_notices_pending not found'; END IF;

  -- (a) cover the manual recall
  IF position('manual_recalled' in src) = 0 THEN
    before := src;
    src := replace(src,
      'WHERE a.outcome = ''auto_recalled''',
      'WHERE a.outcome IN (''auto_recalled'',''manual_recalled'')');
    IF src = before THEN RAISE EXCEPTION 'anchor (a) cancelled-notice predicate missing'; END IF;
  ELSE
    RAISE NOTICE 'manual_recalled already covered';
  END IF;

  -- (b) never quote UGX 0 at a tenant
  IF position('NULLIF(rr.rent_amount,0)' in src) = 0 THEN
    before := src;
    src := replace(src,
      '''rent_amount'',rr.rent_amount,''landlord_name'',a.landlord_name',
      '''rent_amount'',COALESCE(NULLIF(rr.rent_amount,0), a.amount),''landlord_name'',a.landlord_name');
    IF src = before THEN RAISE EXCEPTION 'anchor (b) rent_amount projection missing'; END IF;
  ELSE
    RAISE NOTICE 'rent_amount fallback already applied';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.rent_plan_transition_notices_pending(p_lookback_hours integer DEFAULT 48)
     RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''public'' AS %L', src);
END
$do$;
