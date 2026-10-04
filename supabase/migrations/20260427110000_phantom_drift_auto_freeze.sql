-- ════════════════════════════════════════════════════════════════════
-- PHANTOM DRIFT AUTO-FREEZE
-- ════════════════════════════════════════════════════════════════════
-- "Every shilling on a wallet that is not in the ledger is frozen."
--
-- Definition of phantom drift:
--   wallets.balance > SUM(ledger cash_in - cash_out) where ledger_scope='wallet'
--
-- The ledger is the only source of financial truth. If a wallet shows
-- more money than the ledger can account for, that surplus must NOT be
-- spendable. We move it into wallets.locked_balance immediately.
--
-- This migration:
--   1. Adds a SECURITY DEFINER helper that computes a user's ledger total.
--   2. Adds a trigger function that runs AFTER any wallet update and locks
--      any phantom surplus the moment it appears (forward-looking guard).
--   3. Adds a CFO-only release function (release_phantom_lock).
--   4. Performs a historical sweep — anyone currently holding unbacked
--      money has it frozen automatically (LUKODDA JOSEPH today).
--
-- Locked funds remain visible in wallets.locked_balance but are excluded
-- from any spend path that uses withdrawable / float / advance.
-- The freeze is fully reversible by CFO once the underlying ledger gap
-- is investigated and reconciled.
-- ════════════════════════════════════════════════════════════════════


-- ── 1. Ledger total helper ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_wallet_ledger_total(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(
    CASE WHEN direction = 'cash_in'  THEN amount
         WHEN direction = 'cash_out' THEN -amount
         ELSE 0 END
  ), 0)::numeric
  FROM general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet';
$$;

COMMENT ON FUNCTION public.compute_wallet_ledger_total IS
  'Source of financial truth for a user wallet. Sum of all wallet-scope ledger entries (credits − debits). Used by phantom-drift detection.';


-- ── 2. Auto-freeze trigger function ────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_freeze_phantom_drift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ledger_total   numeric;
  v_drift          numeric;
  v_already_locked numeric;
  v_new_locked     numeric;
  v_recursion_guard text;
BEGIN
  -- Prevent infinite recursion: this trigger updates the same row.
  v_recursion_guard := current_setting('phantom_freeze.in_progress', true);
  IF v_recursion_guard = 'true' THEN
    RETURN NEW;
  END IF;

  v_ledger_total := public.compute_wallet_ledger_total(NEW.user_id);
  v_already_locked := COALESCE(NEW.locked_balance, 0);

  -- Effective spendable balance = wallet.balance − already-locked.
  -- Drift = spendable that the ledger cannot back.
  v_drift := COALESCE(NEW.balance, 0) - v_already_locked - v_ledger_total;

  -- Tolerance: only act on drift > 1 UGX. Negative drift (wallet < ledger)
  -- is a different problem (user is owed money) — out of scope here.
  IF v_drift <= 1 THEN
    RETURN NEW;
  END IF;

  v_new_locked := v_already_locked + v_drift;

  -- Re-enter the same row to apply the lock. Set both session flags so
  -- enforce_wallet_ledger_only allows the bucket touch and our own
  -- recursion guard so this trigger doesn't loop.
  PERFORM set_config('phantom_freeze.in_progress', 'true', true);
  PERFORM set_config('wallet.sync_authorized',     'true', true);

  UPDATE public.wallets
  SET locked_balance = v_new_locked,
      updated_at     = now()
  WHERE id = NEW.id;

  PERFORM set_config('phantom_freeze.in_progress', 'false', true);

  -- Audit row — visible to CFO immediately.
  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    NEW.user_id,
    'phantom_drift_auto_locked',
    'wallets',
    NEW.id,
    jsonb_build_object(
      'wallet_balance',        NEW.balance,
      'ledger_total',          v_ledger_total,
      'drift_amount',          v_drift,
      'previously_locked',     v_already_locked,
      'now_locked_total',      v_new_locked,
      'reason', 'wallet.balance exceeds ledger truth — surplus auto-frozen until CFO reconciliation'
    )
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.auto_freeze_phantom_drift IS
  'AFTER UPDATE trigger on wallets. Locks any wallet surplus that the ledger does not back. Phantom money is physically un-spendable.';


-- ── 3. Install the trigger ─────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_auto_freeze_phantom_drift ON public.wallets;

CREATE TRIGGER trg_auto_freeze_phantom_drift
AFTER INSERT OR UPDATE OF balance, withdrawable_balance, float_balance, advance_balance
ON public.wallets
FOR EACH ROW
EXECUTE FUNCTION public.auto_freeze_phantom_drift();


-- ── 4. CFO release function ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.release_phantom_lock(
  p_user_id uuid,
  p_amount  numeric,
  p_reason  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller       uuid := auth.uid();
  v_is_cfo       boolean;
  v_is_manager   boolean;
  v_current_lock numeric;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'release_phantom_lock requires an authenticated caller';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'cfo')
    INTO v_is_cfo;
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'manager')
    INTO v_is_manager;

  IF NOT (v_is_cfo OR v_is_manager) THEN
    RAISE EXCEPTION 'Only CFO or manager can release phantom locks';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Release amount must be positive';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT locked_balance INTO v_current_lock
  FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_current_lock IS NULL THEN
    RAISE EXCEPTION 'No wallet found for user %', p_user_id;
  END IF;

  IF v_current_lock < p_amount THEN
    RAISE EXCEPTION 'Cannot release % — only % is currently locked', p_amount, v_current_lock;
  END IF;

  PERFORM set_config('phantom_freeze.in_progress', 'true', true);
  PERFORM set_config('wallet.sync_authorized',     'true', true);

  UPDATE public.wallets
  SET locked_balance = locked_balance - p_amount,
      updated_at     = now()
  WHERE user_id = p_user_id;

  PERFORM set_config('phantom_freeze.in_progress', 'false', true);

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    v_caller,
    'phantom_lock_released',
    'wallets',
    p_user_id,
    jsonb_build_object(
      'target_user_id', p_user_id,
      'amount_released', p_amount,
      'lock_before',    v_current_lock,
      'lock_after',     v_current_lock - p_amount,
      'reason',         p_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'lock_before', v_current_lock,
    'lock_after',  v_current_lock - p_amount
  );
END;
$$;

COMMENT ON FUNCTION public.release_phantom_lock IS
  'CFO/manager-only. Reduces wallets.locked_balance by p_amount with mandatory reason and audit trail. Use ONLY after the ledger gap has been reconciled.';


-- ── 5. Historical sweep ────────────────────────────────────────────
DO $$
DECLARE
  v_row             record;
  v_ledger_total    numeric;
  v_drift           numeric;
  v_already_locked  numeric;
  v_total_locked    numeric := 0;
  v_wallets_locked  int     := 0;
BEGIN
  PERFORM set_config('phantom_freeze.in_progress', 'true', true);
  PERFORM set_config('wallet.sync_authorized',     'true', true);

  FOR v_row IN
    SELECT id, user_id, balance, locked_balance
    FROM public.wallets
    WHERE user_id IS NOT NULL
  LOOP
    v_ledger_total := public.compute_wallet_ledger_total(v_row.user_id);
    v_already_locked := COALESCE(v_row.locked_balance, 0);
    v_drift := COALESCE(v_row.balance, 0) - v_already_locked - v_ledger_total;

    IF v_drift > 1 THEN
      UPDATE public.wallets
      SET locked_balance = v_already_locked + v_drift,
          updated_at     = now()
      WHERE id = v_row.id;

      INSERT INTO public.audit_logs (
        user_id, action_type, table_name, record_id, metadata
      ) VALUES (
        v_row.user_id,
        'phantom_drift_historical_lock',
        'wallets',
        v_row.id,
        jsonb_build_object(
          'wallet_balance',    v_row.balance,
          'ledger_total',      v_ledger_total,
          'drift_amount',      v_drift,
          'previously_locked', v_already_locked,
          'now_locked_total',  v_already_locked + v_drift,
          'source',            'phantom_drift_auto_freeze migration historical sweep'
        )
      );

      v_total_locked := v_total_locked + v_drift;
      v_wallets_locked := v_wallets_locked + 1;
    END IF;
  END LOOP;

  PERFORM set_config('phantom_freeze.in_progress', 'false', true);

  RAISE NOTICE 'Historical phantom-drift sweep: locked UGX % across % wallet(s)',
    v_total_locked, v_wallets_locked;
END
$$;
