-- Detect a money-path function being rewritten in production, within minutes.
--
-- WHY THIS EXISTS
-- The 2026-09-15 collection runaway was not caused by a subtle bug. It was
-- caused by `agent_allocate_tenant_payment_internal` being rewritten directly
-- in production with no migration, no commit and no recorded author, and by
-- nothing noticing for 16 hours. That is the THIRD time:
--
--   2026-09-10 07:29 UTC  20260910100000 - overloads "deployed straight to
--                         production, with no migration in this repository"
--                         inverted both collection legs. 16 collections,
--                         UGX 6,064,036 of float wrongly credited.
--   2026-09-15 15:12 UTC  drizzle 0114 - float stopped being consumed and the
--                         repayment guard silently began reverting
--                         amount_repaid. 1,327 duplicate collections,
--                         UGX 105,425,606 phantom, UGX 10.5M of commission of
--                         which UGX 7.7M was withdrawn before anyone noticed.
--   (and the edge-function deploy workflow already carries its own note about
--   approve-deposit running defective code for a day while the revert sat in
--   git.)
--
-- 20260910100000 said it plainly and was right: "THIS IS A BACKSTOP, NOT A
-- SOLUTION. The real fix is that money-path RPCs and their guards must not be
-- deployed outside a reviewed migration." A rule nothing enforces is a wish.
-- This enforces it by watching.
--
-- WHAT IT DOES
-- `assert_money_path_intact()` reads the LIVE source of the money-path
-- functions and checks the invariants each must keep. It is deliberately a
-- check on production's own `pg_proc`, not on this repository, because the
-- repository was never the thing that drifted.
--
-- Every invariant below is one that, when it broke, cost real money:
--   * the float debit leg           - its removal is what uncapped collection
--   * recipient_type operational_wallet - the guard matches on it; without it
--                                     the guard silently reverts amount_repaid
--   * the post-update assertion     - without it a reverted repayment still
--                                     pays commission
--   * 10% / 8% commission           - the split has been altered by accident
--   * the A5 custody leg's ABSENCE  - its presence means 0114 was re-applied
--                                     and float is no longer consumed
--   * ALLOCATION_FROZEN absent      - the emergency stub left in place blocks
--                                     every agent, which is an outage
--
-- Read-only. Moves no money, changes no row.

CREATE OR REPLACE FUNCTION public.assert_money_path_intact()
RETURNS TABLE(check_name text, ok boolean, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_alloc text;
  v_guard text;
BEGIN
  SELECT p.prosrc INTO v_alloc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment_internal';

  SELECT p.prosrc INTO v_guard
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_rent_request_agent_updates';

  RETURN QUERY SELECT 'allocator_exists', v_alloc IS NOT NULL,
    coalesce('length ' || length(v_alloc)::text, 'MISSING');

  RETURN QUERY SELECT 'float_is_consumed',
    coalesce(position('agent_float_used_for_rent' in v_alloc) > 0, false),
    'the wallet float debit leg must be posted on every collection';

  RETURN QUERY SELECT 'float_leg_matches_guard',
    coalesce(position('''recipient_type'', ''operational_wallet''' in v_alloc) > 0, false),
    'guard_rent_request_agent_updates matches on recipient_type=operational_wallet';

  RETURN QUERY SELECT 'repayment_is_verified',
    coalesce(position('the repayment was not applied' in v_alloc) > 0, false),
    'the post-UPDATE assertion is what stops commission being paid for a repayment that was reverted';

  RETURN QUERY SELECT 'plan_row_is_locked',
    coalesce(position('FOR UPDATE' in v_alloc) > 0, false),
    'concurrent taps on one plan must queue, not both read the same outstanding';

  RETURN QUERY SELECT 'commission_rate_10_pct',
    coalesce(position('round(p_amount * 0.10, 2)' in v_alloc) > 0, false),
    'total commission is 10% of the collection';

  RETURN QUERY SELECT 'subagent_split_8_pct',
    coalesce(position('round(p_amount * 0.08, 2)' in v_alloc) > 0, false),
    'a sub-agent keeps 8%, the recruiting parent takes 2%';

  RETURN QUERY SELECT 'custody_leg_absent',
    coalesce(position('cash_receipt_in_transit' in v_alloc) = 0, false),
    'presence means drizzle 0114 was re-applied and float is no longer consumed';

  RETURN QUERY SELECT 'not_frozen',
    coalesce(position('ALLOCATION_FROZEN' in v_alloc) = 0, false),
    'the emergency stub blocks every agent - an outage, not a fix';

  RETURN QUERY SELECT 'guard_trusts_float_leg',
    coalesce(position('agent_float_used_for_rent' in v_guard) > 0, false),
    'the guard must still recognise the shape the allocator writes';

  RETURN QUERY SELECT 'single_overload',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal') = 1,
    'two overloads means an undeclared deploy added one alongside the reviewed version';
END;
$function$;

COMMENT ON FUNCTION public.assert_money_path_intact() IS
  'Live check that the rent-collection money path still holds its invariants. Returns one row per check; any ok=false means production has drifted from the reviewed shape.';

REVOKE ALL ON FUNCTION public.assert_money_path_intact() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_money_path_intact() TO authenticated;

-- A drift record, so a breakage that happens at 3am is still visible at 9am
-- rather than having to be caught live.
CREATE TABLE IF NOT EXISTS public.money_path_drift_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at  timestamptz NOT NULL DEFAULT now(),
  check_name   text NOT NULL,
  detail       text,
  resolved_at  timestamptz
);

ALTER TABLE public.money_path_drift_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS money_path_drift_read ON public.money_path_drift_events;
CREATE POLICY money_path_drift_read ON public.money_path_drift_events
  FOR SELECT USING (
    public.has_role(auth.uid(), 'cto'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  );

CREATE OR REPLACE FUNCTION public.record_money_path_drift()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_new integer := 0;
BEGIN
  INSERT INTO public.money_path_drift_events (check_name, detail)
  SELECT c.check_name, c.detail
    FROM public.assert_money_path_intact() c
   WHERE NOT c.ok
     AND NOT EXISTS (
       SELECT 1 FROM public.money_path_drift_events e
        WHERE e.check_name = c.check_name AND e.resolved_at IS NULL);

  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- Close anything that now passes again.
  UPDATE public.money_path_drift_events e
     SET resolved_at = now()
   WHERE e.resolved_at IS NULL
     AND EXISTS (SELECT 1 FROM public.assert_money_path_intact() c
                  WHERE c.check_name = e.check_name AND c.ok);

  RETURN v_new;
END;
$function$;

-- Every 10 minutes. The 2026-09-15 drift ran for roughly 16 hours before a
-- human noticed; this bounds that to minutes.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('money-path-drift-check')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'money-path-drift-check');
    PERFORM cron.schedule('money-path-drift-check', '*/10 * * * *',
                          $sql$SELECT public.record_money_path_drift();$sql$);
  ELSE
    RAISE NOTICE 'pg_cron not installed - schedule record_money_path_drift() by other means';
  END IF;
END $cron$;

-- Fail this migration if production is already drifted when it is applied.
DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(check_name || ' (' || detail || ')', '; ')
    INTO v_bad FROM public.assert_money_path_intact() WHERE NOT ok;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'money path has already drifted: %', v_bad;
  END IF;
  RAISE NOTICE 'money path intact - all checks pass';
END $verify$;
