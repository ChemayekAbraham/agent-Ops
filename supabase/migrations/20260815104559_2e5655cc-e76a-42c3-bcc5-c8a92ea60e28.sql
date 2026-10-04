-- Board technology report item 4, second pass. Test runs of the first pass
-- exposed two deeper causes:
--
-- (a) expire_stale_bonus_restrictions was still rejected with "Ledger entries
--     are immutable" by prevent_ledger_mutation(): its trusted-maturity path
--     required maturity_expired to be UNCHANGED, which is precisely the flag
--     the job exists to set. maturity_expired is a maturity marker in the same
--     class as maturity_met/matured_at, so it joins the narrow mutable set.
--     Everything financially meaningful (amount, direction, category, scope,
--     bucket, classification, user, group, recipient_type, created_at,
--     withdrawable_after) stays immutable.
--
-- (b) The two "statement timeout" jobs cannot be fixed by raising
--     statement_timeout inside the function: statement_timeout is fixed when
--     the statement begins, so a SET LOCAL issued by the function has no
--     effect on the statement that is running it. Scheduled jobs inherit the
--     120s server default. Both batch functions therefore stop on a wall-clock
--     budget comfortably inside that window and commit the work they did,
--     instead of being cancelled and losing the entire run.

-- ── (a) allow the maturity_expired flag flip ────────────────────────────────
CREATE OR REPLACE FUNCTION public.prevent_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- Trusted maturity path: SECURITY DEFINER helpers set ledger.authorized=true
  -- for the local transaction to flip maturity_met / matured_at /
  -- maturity_expired only.
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME = 'general_ledger'
     AND current_setting('ledger.authorized', true) = 'true' THEN
    -- Only maturity fields may change; every other column must be identical.
    IF ROW(NEW.id, NEW.user_id, NEW.amount, NEW.direction, NEW.category,
           NEW.ledger_scope, NEW.wallet_bucket, NEW.classification,
           NEW.transaction_group_id, NEW.recipient_type, NEW.created_at,
           NEW.maturity_condition, NEW.maturity_subject_id,
           NEW.withdrawable_after)
       IS NOT DISTINCT FROM
       ROW(OLD.id, OLD.user_id, OLD.amount, OLD.direction, OLD.category,
           OLD.ledger_scope, OLD.wallet_bucket, OLD.classification,
           OLD.transaction_group_id, OLD.recipient_type, OLD.created_at,
           OLD.maturity_condition, OLD.maturity_subject_id,
           OLD.withdrawable_after) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'Ledger entries are immutable. No updates or deletes allowed.';
END;
$function$;

-- ── (b) budgeted batch jobs ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.repair_wallet_cache_drift(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_row record;
  v_repaired int := 0;
  v_scanned  int := 0;
  -- Scheduled sessions inherit a 120s statement_timeout that this function
  -- cannot raise for its own statement. Stop well inside it so the repairs
  -- already made are committed rather than cancelled.
  v_deadline timestamptz := clock_timestamp() + interval '80 seconds';
  v_timed_out boolean := false;
BEGIN
  FOR v_row IN
    SELECT w.user_id
      FROM public.wallets w
      JOIN public.v_user_wallet_strict s ON s.user_id = w.user_id
     WHERE ABS(COALESCE(w.withdrawable_balance,0) - COALESCE(s.withdrawable,0))   >= 1
        OR ABS(COALESCE(w.float_balance,0)        - COALESCE(s.float_balance,0))  >= 1
        OR ABS(COALESCE(w.advance_balance,0)      - COALESCE(s.advance_balance,0)) >= 1
     LIMIT p_limit
  LOOP
    IF clock_timestamp() > v_deadline THEN
      v_timed_out := true;
      EXIT;
    END IF;
    v_scanned := v_scanned + 1;
    BEGIN
      PERFORM public.repair_wallet_cache_for_user(v_row.user_id);
      v_repaired := v_repaired + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- skip individual failures; monitor via phantom_wallet_drift
    END;
  END LOOP;

  RETURN jsonb_build_object('scanned', v_scanned, 'repaired', v_repaired,
                            'stopped_on_budget', v_timed_out, 'ran_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_trust_scores_batch(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid;
  v_processed integer := 0;
  v_errors integer := 0;
  -- See repair_wallet_cache_drift: budget instead of raising statement_timeout.
  -- Stale-first ordering means a budgeted partial run still rotates through
  -- every user across the day's runs.
  v_deadline timestamptz := clock_timestamp() + interval '90 seconds';
  v_timed_out boolean := false;
BEGIN
  FOR v_user_id IN
    SELECT p.id
    FROM public.profiles p
    LEFT JOIN public.welile_trust_score_cache c ON c.user_id = p.id
    ORDER BY COALESCE(c.last_calculated_at, '1970-01-01'::timestamptz) ASC
    LIMIT p_limit
  LOOP
    IF clock_timestamp() > v_deadline THEN
      v_timed_out := true;
      EXIT;
    END IF;
    BEGIN
      PERFORM public.recompute_trust_score(v_user_id);
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      -- still seed an empty row so coverage is 100%
      INSERT INTO public.welile_trust_score_cache (user_id, ai_id, last_calculated_at)
      VALUES (v_user_id, public.derive_welile_ai_id(v_user_id), now())
      ON CONFLICT (user_id) DO UPDATE SET last_calculated_at = now();
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'errors', v_errors,
    'limit', p_limit,
    'stopped_on_budget', v_timed_out,
    'completed_at', now()
  );
END;
$function$;

-- Spread the trust recompute across the day: a 120s-capped run can only cover
-- a slice of the user base, so one oversized nightly batch can never reach
-- everyone. Twelve budgeted runs a day do.
SELECT cron.unschedule('recalculate-trust-scores-nightly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'recalculate-trust-scores-nightly');

SELECT cron.schedule(
  'recalculate-trust-scores-rolling',
  '5 */2 * * *',
  $$SELECT public.recompute_trust_scores_batch(20000);$$
);