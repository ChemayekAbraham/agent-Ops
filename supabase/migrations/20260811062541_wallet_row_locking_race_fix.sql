-- Step B of the wallet performance/correctness plan: close the
-- concurrent-debit race with row-level locking.
--
-- Root cause fixed: create_ledger_transaction takes
-- pg_advisory_xact_lock(idempotency_key), which only blocks literal replay
-- of the same key, not two different concurrent debits for the same user.
-- Neither create_ledger_transaction nor enforce_no_negative_wallet_ledger
-- (the stricter gate, fires on every general_ledger insert regardless of
-- caller) took a row lock before reading the cached balance, so two
-- concurrent withdrawals for the same user could both read the same
-- balance and both pass.
--
-- Feature-flagged independently of Step A (dirty-flag deferral, shipped
-- 2026-08-11 in 20260811050458_...sql): locking changes can introduce
-- deadlocks/timeouts even when the balance math is untouched, so this
-- ships disabled by default and is canaried by explicit user_id allowlist
-- (internal accounts, then low-volume, then agents) before flipping the
-- all_users switch.

-- =========================================================================
-- 1. Rollout control: default OFF. wallet_row_locking_applies(user_id)
--    is the single gate both call sites below check before acquiring a
--    lock, so enabling/disabling or growing the canary cohort never
--    requires another migration.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.wallet_row_locking_rollout (
  id integer PRIMARY KEY DEFAULT 1,
  enabled boolean NOT NULL DEFAULT false,
  all_users boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT wallet_row_locking_rollout_singleton CHECK (id = 1)
);

INSERT INTO public.wallet_row_locking_rollout (id, enabled, all_users)
VALUES (1, false, false)
ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON public.wallet_row_locking_rollout TO authenticated;
GRANT ALL ON public.wallet_row_locking_rollout TO service_role;
ALTER TABLE public.wallet_row_locking_rollout ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Finance leadership reads locking rollout" ON public.wallet_row_locking_rollout;
CREATE POLICY "Finance leadership reads locking rollout"
  ON public.wallet_row_locking_rollout FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'cto'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
  );

DROP POLICY IF EXISTS "CFO updates locking rollout" ON public.wallet_row_locking_rollout;
CREATE POLICY "CFO updates locking rollout"
  ON public.wallet_row_locking_rollout FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE TABLE IF NOT EXISTS public.wallet_row_locking_canary_users (
  user_id uuid PRIMARY KEY,
  cohort text NOT NULL DEFAULT 'internal',
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid
);

GRANT SELECT ON public.wallet_row_locking_canary_users TO authenticated;
GRANT ALL ON public.wallet_row_locking_canary_users TO service_role;
ALTER TABLE public.wallet_row_locking_canary_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Finance leadership reads locking canary" ON public.wallet_row_locking_canary_users;
CREATE POLICY "Finance leadership reads locking canary"
  ON public.wallet_row_locking_canary_users FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'cto'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
  );

DROP POLICY IF EXISTS "CFO manages locking canary" ON public.wallet_row_locking_canary_users;
CREATE POLICY "CFO manages locking canary"
  ON public.wallet_row_locking_canary_users FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE OR REPLACE FUNCTION public.wallet_row_locking_applies(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_all boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT enabled, all_users INTO v_enabled, v_all
  FROM public.wallet_row_locking_rollout
  WHERE id = 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN false;
  END IF;

  IF COALESCE(v_all, false) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.wallet_row_locking_canary_users WHERE user_id = p_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.wallet_row_locking_applies(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wallet_row_locking_applies(uuid) TO service_role;

COMMENT ON FUNCTION public.wallet_row_locking_applies(uuid)
  IS 'Feature-flag gate for the Step B concurrent-debit row lock (2026-08-11). Default off. Enable globally via wallet_row_locking_rollout.enabled + all_users, or stage a canary cohort via wallet_row_locking_canary_users (internal accounts, then low-volume, then agents). Checked independently by create_ledger_transaction and enforce_no_negative_wallet_ledger -- both must agree a user is in-scope before either acquires a lock for them.';

-- =========================================================================
-- 2. create_ledger_transaction: lock every distinct user_id with a
--    cash_out entry, in a fixed sort order, before evaluating any entry.
--    Sorting is what prevents a deadlock between two concurrent multi-user
--    calls (e.g. transfers) touching the same two users in opposite order --
--    the per-user feature-flag check does not break this guarantee, since
--    a sorted sequence's gated subsequence is still sorted the same way in
--    every call. pg_advisory_xact_lock(idempotency_key) is untouched --
--    it solves replay safety, a different problem.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL::text, skip_balance_check boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id uuid;
  v_entry jsonb;
  v_total_in numeric := 0;
  v_total_out numeric := 0;
  v_user_balance numeric;
  v_cached_withdrawable numeric;
  v_anchor_at timestamptz;
  v_lock_key bigint;
  v_lock_user_id uuid;
  v_wallet_id uuid;
  v_recipient_type text;
  v_category text;
  v_scope text;
  v_effective_bucket text;
BEGIN
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN
    RAISE EXCEPTION 'entries must be a JSON array, got: %', COALESCE(jsonb_typeof(entries), 'NULL');
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    v_lock_key := abs(hashtext(idempotency_key));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT transaction_group_id INTO v_group_id
    FROM public.general_ledger
    WHERE general_ledger.idempotency_key = create_ledger_transaction.idempotency_key
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_group_id IS NOT NULL THEN
      RETURN v_group_id;
    END IF;
  END IF;

  -- Deterministic lock ordering: acquire a row lock on every distinct user
  -- this transaction will debit, sorted, before evaluating any entry. This
  -- closes the concurrent-debit race (two simultaneous calls debiting the
  -- same user can no longer both read the same stale balance).
  FOR v_lock_user_id IN
    SELECT DISTINCT (e->>'user_id')::uuid
    FROM jsonb_array_elements(entries) e
    WHERE e->>'direction' = 'cash_out' AND (e->>'user_id') IS NOT NULL
    ORDER BY 1
  LOOP
    IF public.wallet_row_locking_applies(v_lock_user_id) THEN
      PERFORM 1 FROM public.wallet_balances_projection
      WHERE user_id = v_lock_user_id
      FOR UPDATE;
    END IF;
  END LOOP;

  v_group_id := gen_random_uuid();

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    IF (v_entry->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'All amounts must be positive, got: %', v_entry->>'amount';
    END IF;

    v_category       := v_entry->>'category';
    v_scope          := COALESCE(v_entry->>'ledger_scope', 'wallet');
    v_recipient_type := NULLIF(v_entry->>'recipient_type', '');

    IF v_scope = 'wallet' AND v_category IN (
      'agent_repayment','agent_advance_repayment','salary_advance_repayment','debt_recovery'
    ) THEN
      IF v_recipient_type IS NULL THEN
        BEGIN
          INSERT INTO public.wallet_routing_violations (
            user_id, category, direction, amount, recipient_type, reason, context
          ) VALUES (
            NULLIF(v_entry->>'user_id','')::uuid,
            v_category, v_entry->>'direction',
            (v_entry->>'amount')::numeric, NULL,
            'RECIPIENT_TYPE_REQUIRED',
            jsonb_build_object('source','create_ledger_transaction','rule','advance_recovery_isolation')
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RAISE EXCEPTION 'agent_repayment requires explicit recipient_type on the wallet leg' USING ERRCODE = 'check_violation';
      END IF;

      BEGIN
        PERFORM public.assert_routing_compatible(v_category, v_recipient_type);
      EXCEPTION WHEN check_violation THEN
        BEGIN
          INSERT INTO public.wallet_routing_violations (
            user_id, category, direction, amount, recipient_type, reason, context
          ) VALUES (
            NULLIF(v_entry->>'user_id','')::uuid,
            v_category, v_entry->>'direction',
            (v_entry->>'amount')::numeric, v_recipient_type,
            SQLERRM,
            jsonb_build_object('source','create_ledger_transaction','rule','advance_recovery_isolation')
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RAISE;
      END;
    END IF;

    IF v_entry->>'direction' = 'cash_in' THEN
      v_total_in := v_total_in + (v_entry->>'amount')::numeric;
    ELSIF v_entry->>'direction' = 'cash_out' THEN
      v_total_out := v_total_out + (v_entry->>'amount')::numeric;

      -- Resolve the effective wallet bucket the way the BEFORE INSERT trigger
      -- (trg_set_wallet_bucket_from_recipient_type) will: an explicit
      -- wallet_bucket wins, otherwise recipient_type decides
      -- (operational_wallet -> float, user -> withdrawable). Without this,
      -- float legs that rely on recipient_type were defaulting to
      -- 'withdrawable' and getting wrongly gated against the agent's tiny
      -- withdrawable balance instead of their float.
      v_effective_bucket := COALESCE(
        NULLIF(v_entry->>'wallet_bucket', ''),
        CASE
          WHEN v_recipient_type = 'operational_wallet' THEN 'float'
          WHEN v_recipient_type = 'user' THEN 'withdrawable'
          ELSE 'withdrawable'
        END
      );

      IF NOT skip_balance_check
         AND v_scope = 'wallet'
         AND (v_entry->>'user_id') IS NOT NULL
         AND v_effective_bucket = 'withdrawable' THEN

        SELECT anchor_at INTO v_anchor_at
        FROM public.wallet_fresh_start_anchors
        WHERE user_id = (v_entry->>'user_id')::uuid;

        WITH category_routed AS (
          SELECT COALESCE(SUM(CASE WHEN r.bucket = 'withdrawable' THEN r.sign * gl.amount ELSE 0 END), 0) AS net
          FROM public.general_ledger gl
          CROSS JOIN LATERAL public.wallet_route_for_category(gl.user_id, gl.category, gl.direction) r
          WHERE gl.user_id = (v_entry->>'user_id')::uuid
            AND gl.ledger_scope = 'wallet'
            AND (gl.classification IS NULL OR gl.classification = 'production')
            AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
            AND gl.wallet_bucket IS NULL
        ), explicit_routed AS (
          SELECT COALESCE(SUM(
            CASE
              WHEN wallet_bucket = 'withdrawable' AND direction IN ('cash_in','credit') THEN amount
              WHEN wallet_bucket = 'withdrawable' AND direction IN ('cash_out','debit') THEN -amount
              ELSE 0
            END
          ), 0) AS net
          FROM public.general_ledger
          WHERE user_id = (v_entry->>'user_id')::uuid
            AND ledger_scope = 'wallet'
            AND (classification IS NULL OR classification = 'production')
            AND (v_anchor_at IS NULL OR created_at >= v_anchor_at)
            AND wallet_bucket IS NOT NULL
        )
        SELECT category_routed.net + explicit_routed.net
        INTO v_user_balance
        FROM category_routed, explicit_routed;

        SELECT COALESCE(withdrawable_balance, 0)
        INTO v_cached_withdrawable
        FROM public.wallets
        WHERE user_id = (v_entry->>'user_id')::uuid;

        v_user_balance := GREATEST(0,
          LEAST(COALESCE(v_cached_withdrawable, 0), GREATEST(0, COALESCE(v_user_balance, 0)))
        );

        IF v_user_balance < (v_entry->>'amount')::numeric THEN
          RAISE EXCEPTION 'Insufficient ledger balance for user %. Available: %, Required: %',
            v_entry->>'user_id', v_user_balance, v_entry->>'amount';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in or cash_out', v_entry->>'direction';
    END IF;
  END LOOP;

  IF v_total_in <> v_total_out THEN
    RAISE EXCEPTION 'Transaction not balanced. Total cash_in (%) <> total cash_out (%)', v_total_in, v_total_out;
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    v_wallet_id := NULL;
    IF (v_entry->>'user_id') IS NOT NULL THEN
      SELECT id INTO v_wallet_id
      FROM public.wallets
      WHERE user_id = (v_entry->>'user_id')::uuid;
    END IF;

    INSERT INTO public.general_ledger (
      user_id, wallet_id, ledger_scope, direction, category, amount, currency,
      description, source_table, source_id, transaction_group_id,
      idempotency_key, transaction_date, linked_party, reference_id, account,
      classification, recipient_type, wallet_bucket, routing_source,
      solvency_bypass_reason
    ) VALUES (
      (v_entry->>'user_id')::uuid,
      v_wallet_id,
      COALESCE(v_entry->>'ledger_scope', 'wallet'),
      v_entry->>'direction',
      v_entry->>'category',
      (v_entry->>'amount')::numeric,
      COALESCE(v_entry->>'currency', 'UGX'),
      v_entry->>'description',
      COALESCE(v_entry->>'source_table', 'ledger_transaction'),
      (v_entry->>'source_id')::uuid,
      v_group_id,
      create_ledger_transaction.idempotency_key,
      COALESCE((v_entry->>'transaction_date')::timestamptz, now()),
      v_entry->>'linked_party',
      v_entry->>'reference_id',
      v_entry->>'account',
      COALESCE(v_entry->>'classification', 'production'),
      NULLIF(v_entry->>'recipient_type', ''),
      NULLIF(v_entry->>'wallet_bucket', ''),
      NULLIF(v_entry->>'routing_source', ''),
      NULLIF(v_entry->>'solvency_bypass_reason', '')::public.solvency_bypass_reason
    );
  END LOOP;

  RETURN v_group_id;
END;
$function$;

-- =========================================================================
-- 3. enforce_no_negative_wallet_ledger: the actual stricter gate, fires on
--    every general_ledger insert regardless of caller. Needs the identical
--    lock on the same row before trusting float_balance / calling
--    get_user_available_balance(), or a caller bypassing
--    create_ledger_transaction's own lock (or a future direct-insert path)
--    could still race. Locked once, before either balance branch, so both
--    the float-path and withdrawable-path checks below share it.
-- =========================================================================
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

  IF public.wallet_row_locking_applies(NEW.user_id) THEN
    PERFORM 1 FROM public.wallet_balances_projection
    WHERE user_id = NEW.user_id
    FOR UPDATE;
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
