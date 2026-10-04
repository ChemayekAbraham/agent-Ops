
CREATE TABLE IF NOT EXISTS public.phantom_freeze_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  wallet_id uuid,
  surplus_locked numeric NOT NULL,
  wallet_balance_before numeric NOT NULL,
  ledger_total_at_freeze numeric NOT NULL,
  previous_locked_balance numeric NOT NULL,
  new_locked_balance numeric NOT NULL,
  trigger_reason text NOT NULL DEFAULT 'auto_phantom_freeze',
  frozen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phantom_freeze_audit_user ON public.phantom_freeze_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_phantom_freeze_audit_frozen_at ON public.phantom_freeze_audit(frozen_at DESC);

ALTER TABLE public.phantom_freeze_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CFO can view phantom freeze audit" ON public.phantom_freeze_audit;
CREATE POLICY "CFO can view phantom freeze audit"
  ON public.phantom_freeze_audit FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.staff_permissions sp
      WHERE sp.user_id = auth.uid()
        AND sp.permitted_dashboard IN ('cfo','ceo','company-ops')
    )
  );

CREATE OR REPLACE FUNCTION public.compute_wallet_ledger_total(_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(
    CASE WHEN direction = 'cash_in' THEN amount
         WHEN direction = 'cash_out' THEN -amount
         ELSE 0 END
  ), 0)
  FROM public.general_ledger
  WHERE user_id = _user_id
    AND ledger_scope = 'wallet';
$$;

CREATE OR REPLACE FUNCTION public.auto_freeze_phantom_surplus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ledger_total numeric;
  v_spendable numeric;
  v_surplus numeric;
  v_prev_locked numeric;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_ledger_total := public.compute_wallet_ledger_total(NEW.user_id);
  v_spendable := COALESCE(NEW.balance,0) - COALESCE(NEW.locked_balance,0);

  IF v_spendable > v_ledger_total THEN
    v_surplus := v_spendable - v_ledger_total;
    v_prev_locked := COALESCE(NEW.locked_balance, 0);
    NEW.locked_balance := v_prev_locked + v_surplus;

    INSERT INTO public.phantom_freeze_audit (
      user_id, wallet_id, surplus_locked,
      wallet_balance_before, ledger_total_at_freeze,
      previous_locked_balance, new_locked_balance, trigger_reason
    ) VALUES (
      NEW.user_id, NEW.id, v_surplus,
      COALESCE(NEW.balance,0), v_ledger_total,
      v_prev_locked, NEW.locked_balance, 'auto_phantom_freeze'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_freeze_phantom_surplus ON public.wallets;
CREATE TRIGGER trg_auto_freeze_phantom_surplus
  BEFORE INSERT OR UPDATE OF balance, locked_balance ON public.wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_freeze_phantom_surplus();

CREATE OR REPLACE FUNCTION public.release_phantom_lock(
  _user_id uuid,
  _amount numeric,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed boolean;
  v_wallet_id uuid;
  v_locked numeric;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.staff_permissions
     WHERE user_id = auth.uid()
       AND permitted_dashboard IN ('cfo','ceo','company-ops')
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Only CFO/CEO/Company-Ops can release phantom locks';
  END IF;
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;
  IF COALESCE(_reason,'') = '' THEN
    RAISE EXCEPTION 'Reason is required for audit trail';
  END IF;

  SELECT id, locked_balance INTO v_wallet_id, v_locked
  FROM public.wallets WHERE user_id = _user_id FOR UPDATE;

  IF v_locked IS NULL OR v_locked < _amount THEN
    RAISE EXCEPTION 'Locked balance % is less than requested release %', COALESCE(v_locked,0), _amount;
  END IF;

  PERFORM set_config('wallet.sync_authorized','true', true);
  UPDATE public.wallets
     SET locked_balance = locked_balance - _amount,
         balance = balance - _amount
   WHERE id = v_wallet_id;

  INSERT INTO public.phantom_freeze_audit (
    user_id, wallet_id, surplus_locked,
    wallet_balance_before, ledger_total_at_freeze,
    previous_locked_balance, new_locked_balance, trigger_reason
  ) VALUES (
    _user_id, v_wallet_id, -_amount,
    0, public.compute_wallet_ledger_total(_user_id),
    v_locked, v_locked - _amount,
    'cfo_release: ' || _reason
  );

  RETURN jsonb_build_object('success', true, 'released', _amount);
END;
$$;

DO $$
DECLARE
  r RECORD;
  v_ledger_total numeric;
  v_spendable numeric;
  v_surplus numeric;
BEGIN
  FOR r IN SELECT id, user_id, balance, locked_balance FROM public.wallets LOOP
    v_ledger_total := public.compute_wallet_ledger_total(r.user_id);
    v_spendable := COALESCE(r.balance,0) - COALESCE(r.locked_balance,0);
    IF v_spendable > v_ledger_total THEN
      v_surplus := v_spendable - v_ledger_total;

      PERFORM set_config('wallet.sync_authorized','true', true);
      UPDATE public.wallets
         SET locked_balance = COALESCE(locked_balance,0) + v_surplus
       WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
