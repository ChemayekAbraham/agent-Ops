-- Step A of the wallet performance/correctness plan: defer the wallet
-- projection recompute from write-time to read-time (dirty-flag pattern).
--
-- Root cause fixed: every general_ledger insert fires
-- tg_refresh_wallet_projection_on_ledger -> refresh_wallet_projection_for(),
-- which fully re-aggregates that user's ENTIRE lifetime ledger history
-- synchronously, inside the same transaction as the deposit/withdrawal/
-- transfer. This is O(n) per write. This migration changes the trigger to
-- mark the row dirty (O(1)) instead, and moves the recompute to the next
-- read (or a background sweep) for that one user only. The balance
-- sufficiency check inside enforce_no_negative_wallet_ledger is guaranteed
-- to never see a stale number.
--
-- refresh_wallet_projection_for(uuid) was locked down on 2026-07-23
-- (EXECUTE revoked from PUBLIC/authenticated/service_role) specifically so
-- the projection could only ever be touched inside the same transaction as
-- a ledger write -- a deliberate reaction to the OLDER pivot-based
-- reconcile_wallet_from_pivot/reconcile_wallets_batch mechanism
-- (supabase/migrations/20260603164504_...sql), which directly UPDATEd
-- wallets.withdrawable_balance/float_balance from a scheduled job outside
-- the ledger, and was neutered the very next day (20260724163151_...sql,
-- "GRANDFATHER MODE"). That original lockdown and its comment are left
-- untouched below. This migration instead adds a single, narrowly-scoped,
-- explicitly-documented wrapper, wallet_projection_read_repair(), as the
-- ONLY sanctioned additional caller -- it never writes anything that isn't
-- ledger-derived (it only ever calls refresh_wallet_projection_for), so it
-- does not reintroduce the direct-balance-mutation pattern the lockdown
-- exists to prevent.

-- Must be its own statement, no transaction wrapping.
ALTER TYPE public.system_event_type ADD VALUE IF NOT EXISTS 'wallet_projection_drift_detected';

-- =========================================================================
-- 1. Schema: dirty-flag columns on the projection table.
-- =========================================================================
ALTER TABLE public.wallet_balances_projection
  ADD COLUMN IF NOT EXISTS is_dirty boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dirty_since timestamptz;

CREATE INDEX IF NOT EXISTS idx_wallet_balances_projection_dirty
  ON public.wallet_balances_projection (dirty_since ASC)
  WHERE is_dirty = true;

-- =========================================================================
-- 2. refresh_wallet_projection_for: unchanged lockdown, but now clears the
--    dirty flag on every recompute (required for the dirty-flag scheme to
--    ever settle -- without this every subsequent read would read-repair
--    forever).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.refresh_wallet_projection_for(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_withdrawable_raw numeric := 0;
  v_float_raw numeric := 0;
  v_advance_raw numeric := 0;
  v_restricted_held numeric := 0;
  v_pending_holds numeric := 0;
  v_withdrawable numeric := 0;
  v_float_balance numeric := 0;
  v_advance_balance numeric := 0;
  v_total_visible numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  WITH anchor AS (
    SELECT a.anchor_at
    FROM public.wallet_fresh_start_anchors a
    WHERE a.user_id = p_user_id
    LIMIT 1
  ), ledger AS (
    SELECT
      gl.user_id,
      gl.category,
      gl.direction,
      gl.amount,
      gl.wallet_bucket,
      gl.maturity_met,
      gl.maturity_expired,
      gl.withdrawable_after
    FROM public.general_ledger gl
    LEFT JOIN anchor a ON true
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction = ANY (ARRAY['debit','cash_out'])
        )
      )
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      AND NOT (
        gl.source_table = 'commission_engine'
        AND EXISTS (
          SELECT 1
          FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = gl.user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
            AND cal.source_id = gl.source_id::text
        )
      )
      AND NOT (
        gl.source_table = 'commission_engine_reversal'
        AND gl.classification = 'admin_correction'
        AND gl.category = 'system_balance_correction'
        AND gl.amount = 10000
        AND EXISTS (
          SELECT 1
          FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = gl.user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
        )
      )
  ), routed_explicit AS (
    SELECT
      l.user_id,
      l.amount,
      l.wallet_bucket AS bucket,
      CASE
        WHEN l.direction = ANY (ARRAY['cash_in','credit']) THEN 1
        WHEN l.direction = ANY (ARRAY['cash_out','debit']) THEN -1
        ELSE 0
      END AS sign,
      l.maturity_met,
      l.maturity_expired,
      l.withdrawable_after,
      l.direction,
      l.category
    FROM ledger l
    WHERE l.wallet_bucket = ANY (ARRAY['withdrawable','float','advance_credit','advance_repayment'])
  ), routed_category AS (
    SELECT
      l.user_id,
      l.amount,
      r.bucket,
      r.sign,
      l.maturity_met,
      l.maturity_expired,
      l.withdrawable_after,
      l.direction,
      l.category
    FROM ledger l
    CROSS JOIN LATERAL public.wallet_route_for_category(l.user_id, l.category, l.direction) AS r(bucket, sign)
    WHERE l.wallet_bucket IS NULL
  ), routed AS (
    SELECT * FROM routed_explicit
    UNION ALL
    SELECT * FROM routed_category
  )
  SELECT
    COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = ANY (ARRAY['advance_credit','advance_repayment']) THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN bucket = 'withdrawable'
       AND direction = ANY (ARRAY['cash_in','credit'])
       AND (
         maturity_expired = true
         OR (maturity_met = false AND now() <= COALESCE(withdrawable_after, now()))
       )
      THEN amount
      ELSE 0
    END), 0)
  INTO v_withdrawable_raw, v_float_raw, v_advance_raw, v_restricted_held
  FROM routed;

  SELECT COALESCE(SUM(wr.amount), 0)
  INTO v_pending_holds
  FROM public.withdrawal_requests wr
  WHERE (
      CASE
        WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
        ELSE wr.user_id
      END
    ) = p_user_id
    AND wr.status = ANY (ARRAY['pending','requested','manager_approved','processing','approved'])
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
    AND NOT EXISTS (
      SELECT 1
      FROM public.general_ledger g
      WHERE g.source_table = 'withdrawal_requests'
        AND g.source_id = wr.id
        AND g.ledger_scope = 'wallet'
        AND g.direction = ANY (ARRAY['cash_out','debit'])
    );

  v_withdrawable := GREATEST(0, v_withdrawable_raw - v_restricted_held - v_pending_holds);
  v_float_balance := GREATEST(0, v_float_raw);
  v_advance_balance := GREATEST(0, v_advance_raw);
  v_total_visible := v_withdrawable + v_float_balance;

  INSERT INTO public.wallet_balances_projection AS w (
    user_id,
    withdrawable,
    float_balance,
    advance_balance,
    pending_holds,
    restricted_held,
    total_visible,
    ledger_version,
    is_dirty,
    dirty_since,
    updated_at
  ) VALUES (
    p_user_id,
    v_withdrawable,
    v_float_balance,
    v_advance_balance,
    v_pending_holds,
    v_restricted_held,
    v_total_visible,
    1,
    false,
    NULL,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET withdrawable = EXCLUDED.withdrawable,
        float_balance = EXCLUDED.float_balance,
        advance_balance = EXCLUDED.advance_balance,
        pending_holds = EXCLUDED.pending_holds,
        restricted_held = EXCLUDED.restricted_held,
        total_visible = EXCLUDED.total_visible,
        ledger_version = w.ledger_version + 1,
        is_dirty = false,
        dirty_since = NULL,
        updated_at = now();
END;
$function$;

-- =========================================================================
-- 3. Sanctioned deferred-recompute entry point. This is the ONLY additional
--    caller of refresh_wallet_projection_for besides the existing triggers.
--    It never writes anything that isn't ledger-derived.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.wallet_projection_read_repair(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.refresh_wallet_projection_for(p_user_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.wallet_projection_read_repair(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wallet_projection_read_repair(uuid) TO service_role;

COMMENT ON FUNCTION public.wallet_projection_read_repair(uuid)
  IS 'Sanctioned deferred-recompute entry point (added 2026-08-11 for the dirty-flag pattern). Callable from get_user_wallet_view / get_user_available_balance / get_wallets_batch / enforce_no_negative_wallet_ledger, and the flush_dirty_wallet_projections sweep cron. Only ever re-derives from the ledger via refresh_wallet_projection_for -- never writes a number that is not ledger-backed. refresh_wallet_projection_for itself remains trigger-only; route any new caller through this wrapper instead of widening its own grants.';

COMMENT ON FUNCTION public.refresh_wallet_projection_for(uuid)
  IS 'INTERNAL ONLY. Callable exclusively from ledger/withdrawal-request triggers within the same transaction as the ledger write, and from wallet_projection_read_repair() (the sanctioned deferred-recompute entry point added 2026-08-11 for the dirty-flag pattern). Never grant broader access or call directly from a new edge function, RPC, or scheduled job -- go through wallet_projection_read_repair() instead.';

-- =========================================================================
-- 4. Ledger write trigger: mark dirty (O(1)) instead of a synchronous full
--    recompute. Maturity-flip and withdrawal-request triggers are
--    unaffected by this change -- they fire far less often than every
--    ledger write and are out of scope for this step.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.tg_refresh_wallet_projection_on_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NEW.ledger_scope = 'wallet' THEN
    INSERT INTO public.wallet_balances_projection AS w (user_id, is_dirty, dirty_since)
    VALUES (NEW.user_id, true, now())
    ON CONFLICT (user_id) DO UPDATE
      SET is_dirty = true,
          dirty_since = COALESCE(w.dirty_since, now());
  END IF;
  RETURN NEW;
END;
$$;

-- =========================================================================
-- 5. Read paths: check is_dirty (or missing row) and read-repair via the
--    sanctioned wrapper before returning a value, so none of these can
--    ever surface a stale number.
-- =========================================================================

-- 5a. get_user_wallet_view
CREATE OR REPLACE FUNCTION public.get_user_wallet_view(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_dirty boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', NULL, 'withdrawable', 0, 'float_balance', 0,
      'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
      'restricted_held', 0
    );
  END IF;

  SELECT p.is_dirty INTO v_dirty
  FROM public.wallet_balances_projection p
  WHERE p.user_id = p_user_id;

  -- Missing row (never computed) or marked dirty by a recent ledger write:
  -- read-repair synchronously so this read never returns a stale/absent value.
  IF v_dirty IS NULL OR v_dirty THEN
    PERFORM public.wallet_projection_read_repair(p_user_id);
  END IF;

  SELECT jsonb_build_object(
    'user_id', p.user_id,
    'withdrawable', p.withdrawable,
    'float_balance', p.float_balance,
    'advance_balance', p.advance_balance,
    'pending_holds', p.pending_holds,
    'total_visible', p.total_visible,
    'restricted_held', p.restricted_held,
    'updated_at', p.updated_at
  )
  INTO v
  FROM public.wallet_balances_projection p
  WHERE p.user_id = p_user_id;

  RETURN COALESCE(v, jsonb_build_object(
    'user_id', p_user_id, 'withdrawable', 0, 'float_balance', 0,
    'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
    'restricted_held', 0
  ));
END;
$function$;

-- 5b. get_user_available_balance (converted from a plain SQL function to
--     plpgsql so it can read-repair before returning)
CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dirty boolean;
  v_withdrawable numeric;
BEGIN
  SELECT p.is_dirty INTO v_dirty
  FROM public.wallet_balances_projection p
  WHERE p.user_id = p_user_id;

  IF v_dirty IS NULL OR v_dirty THEN
    PERFORM public.wallet_projection_read_repair(p_user_id);
  END IF;

  SELECT withdrawable INTO v_withdrawable
  FROM public.wallet_balances_projection
  WHERE user_id = p_user_id;

  RETURN COALESCE(v_withdrawable, 0::numeric);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_user_available_balance(uuid) TO authenticated, service_role;

-- 5c. get_wallets_batch (converted from a plain SQL function to plpgsql so
--     each requested user can be read-repaired before the batch is returned)
CREATE OR REPLACE FUNCTION public.get_wallets_batch(p_user_ids uuid[])
RETURNS TABLE (
  user_id uuid,
  withdrawable numeric,
  float_balance numeric,
  advance_balance numeric,
  pending_holds numeric,
  restricted_held numeric,
  total_visible numeric,
  updated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid;
BEGIN
  FOREACH v_uid IN ARRAY p_user_ids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.wallet_balances_projection w
      WHERE w.user_id = v_uid AND w.is_dirty = false
    ) THEN
      PERFORM public.wallet_projection_read_repair(v_uid);
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT
    w.user_id,
    w.withdrawable,
    w.float_balance,
    w.advance_balance,
    w.pending_holds,
    w.restricted_held,
    w.total_visible,
    w.updated_at
  FROM public.wallet_balances_projection w
  WHERE w.user_id = ANY(p_user_ids);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_wallets_batch(uuid[]) TO authenticated, service_role;

-- 5d. enforce_no_negative_wallet_ledger -- the actual stricter debit gate.
--     Its withdrawable-path check already goes through
--     get_user_available_balance (5b), so it benefits automatically. Its
--     float-path check reads wallet_balances_projection inline and needs
--     its own is_dirty check added directly.
CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_available numeric := 0;
  v_float numeric := 0;
  v_float_dirty boolean := false;
  v_current_hold numeric := 0;
  v_effective_bucket text := 'withdrawable';
  v_is_admin_bypass boolean := false;
  v_is_writeoff_bypass boolean := false;
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.direction NOT IN ('cash_out', 'debit') THEN
    RETURN NEW;
  END IF;

  v_is_admin_bypass := COALESCE(NEW.classification, '') = 'admin_correction';
  v_is_writeoff_bypass := COALESCE(NEW.category, '') = 'platform_loss_writeoff';

  IF v_is_admin_bypass OR v_is_writeoff_bypass THEN
    IF NEW.solvency_bypass_reason IS NULL THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_REASON_REQUIRED: cash_out leg classified % / category % must include a solvency_bypass_reason code',
        COALESCE(NEW.classification, '(null)'), COALESCE(NEW.category, '(null)')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.solvency_bypass_reason = 'other_with_note'
       AND length(COALESCE(NEW.description, '')) < 30 THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_NOTE_REQUIRED: reason code other_with_note requires a description of at least 30 characters'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.category, '') = 'system_balance_correction' THEN
    RETURN NEW;
  END IF;

  v_effective_bucket := COALESCE(
    NULLIF(NEW.wallet_bucket, ''),
    CASE
      WHEN NEW.recipient_type = 'operational_wallet' THEN 'float'
      WHEN NEW.recipient_type = 'user' THEN 'withdrawable'
      ELSE NULL
    END,
    (
      SELECT r.bucket
      FROM public.wallet_route_for_category(NEW.user_id, NEW.category, NEW.direction) r
      LIMIT 1
    ),
    'withdrawable'
  );

  -- Float / operational-wallet debits: use the maintained projection cache
  -- (indexed PK lookup, sub-millisecond) instead of recomputing the strict
  -- view from the full ledger on every insert. Read-repair first if the
  -- row is dirty or missing, so this never trusts a stale float figure.
  IF v_effective_bucket = 'float'
     OR COALESCE(NEW.recipient_type, '') = 'operational_wallet' THEN
    SELECT float_balance, is_dirty INTO v_float, v_float_dirty
    FROM public.wallet_balances_projection
    WHERE user_id = NEW.user_id;

    IF v_float_dirty IS NULL OR v_float_dirty THEN
      PERFORM public.wallet_projection_read_repair(NEW.user_id);
      SELECT float_balance INTO v_float
      FROM public.wallet_balances_projection
      WHERE user_id = NEW.user_id;
    END IF;

    IF v_float IS NULL THEN
      SELECT COALESCE(float_balance, 0) INTO v_float
      FROM public.v_user_wallet_strict
      WHERE user_id = NEW.user_id;
    END IF;

    IF COALESCE(v_float, 0) < NEW.amount THEN
      RAISE EXCEPTION 'NEGATIVE_FLOAT_BLOCKED: user % cannot debit % from float (ledger-backed float balance is %)',
        NEW.user_id, NEW.amount, COALESCE(v_float, 0)
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_table = 'withdrawal_requests' AND NEW.source_id IS NOT NULL THEN
    SELECT COALESCE(wr.amount, 0)
      INTO v_current_hold
    FROM public.withdrawal_requests wr
    WHERE wr.id = NEW.source_id
      AND wr.status IN ('pending', 'requested', 'manager_approved', 'processing', 'approved')
      AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
      AND (
        CASE
          WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
          ELSE wr.user_id
        END
      ) = NEW.user_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.general_ledger g
        WHERE g.source_table = 'withdrawal_requests'
          AND g.source_id = wr.id
          AND g.ledger_scope = 'wallet'
          AND g.direction IN ('cash_out', 'debit')
      )
    LIMIT 1;
  END IF;

  v_available := COALESCE(public.get_user_available_balance(NEW.user_id), 0) + COALESCE(v_current_hold, 0);

  IF v_available < NEW.amount THEN
    RAISE EXCEPTION 'LEDGER_BACKING_REQUIRED: user % cannot debit % from withdrawable funds (ledger-backed available is %)',
      NEW.user_id, NEW.amount, v_available
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- =========================================================================
-- 6. Background sweep: proactively flush dirty rows every 2 minutes so
--    read-repair is the rare fallback, not the norm.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.flush_dirty_wallet_projections(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT user_id FROM public.wallet_balances_projection
    WHERE is_dirty = true
    ORDER BY dirty_since ASC
    LIMIT p_limit
  LOOP
    PERFORM public.wallet_projection_read_repair(r.user_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.flush_dirty_wallet_projections(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.flush_dirty_wallet_projections(integer) TO service_role;

DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'flush-dirty-wallet-projections';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'flush-dirty-wallet-projections',
  '*/2 * * * *',
  $$SELECT public.flush_dirty_wallet_projections();$$
);

-- =========================================================================
-- 7. Rollout safety: detect_wallet_projection_drift exists but was never
--    actually scheduled anywhere (confirmed -- no cron.job row, no caller
--    in src/** or supabase/functions/** besides the generated types file).
--    Schedule it now at a tight cadence for the Step A bake-in window, and
--    make it raise a visible system_events row (not just a silent table
--    insert) when it finds drift, since "watch drift alerts during
--    rollout" requires something to actually be watching.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.detect_wallet_projection_drift(p_sample_size integer DEFAULT 500)
RETURNS TABLE (
  users_checked bigint,
  users_drifted bigint,
  auto_healed bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_checked bigint := 0;
  v_drifted bigint := 0;
BEGIN
  WITH sampled AS (
    SELECT user_id
    FROM public.wallet_balances_projection
    ORDER BY updated_at ASC
    LIMIT p_sample_size
  ),
  compared AS (
    SELECT
      p.user_id,
      p.withdrawable AS p_w, p.float_balance AS p_f, p.advance_balance AS p_a,
      s.withdrawable AS s_w, s.float_balance AS s_f, s.advance_balance AS s_a
    FROM public.wallet_balances_projection p
    JOIN sampled ON sampled.user_id = p.user_id
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = p.user_id
  ),
  divergent AS (
    SELECT * FROM compared
    WHERE (COALESCE(p_w,0) - COALESCE(s_w,0)) <> 0
       OR (COALESCE(p_f,0) - COALESCE(s_f,0)) <> 0
       OR (COALESCE(p_a,0) - COALESCE(s_a,0)) <> 0
  ),
  logged AS (
    INSERT INTO public.wallet_projection_drift_alerts
      (user_id, projection_withdrawable, ledger_withdrawable,
       projection_float, ledger_float, projection_advance, ledger_advance, auto_healed)
    SELECT user_id, p_w, COALESCE(s_w,0), p_f, COALESCE(s_f,0), p_a, COALESCE(s_a,0), false
    FROM divergent
    RETURNING user_id
  )
  SELECT
    (SELECT count(*) FROM sampled),
    (SELECT count(*) FROM divergent)
  INTO v_checked, v_drifted;

  -- No auto-heal. Ledger is source of truth; drift must be investigated,
  -- not silently overwritten outside a ledger transaction.
  IF v_drifted > 0 THEN
    INSERT INTO public.system_events (event_type, related_entity_type, metadata)
    VALUES (
      'wallet_projection_drift_detected',
      'wallet_balances_projection',
      jsonb_build_object('users_checked', v_checked, 'users_drifted', v_drifted, 'detected_at', now())
    );
  END IF;

  RETURN QUERY SELECT v_checked, v_drifted, 0::bigint;
END;
$$;

DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'detect-wallet-projection-drift';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'detect-wallet-projection-drift',
  '*/5 * * * *',
  $$SELECT public.detect_wallet_projection_drift();$$
);
