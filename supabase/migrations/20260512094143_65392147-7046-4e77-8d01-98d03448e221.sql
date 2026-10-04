CREATE TABLE IF NOT EXISTS public.cfo_debit_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  created_by uuid NOT NULL,
  auto_recover boolean NOT NULL DEFAULT false,
  recovered_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (recovered_amount >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_recovered','recovered','written_off','reversed')),
  ledger_reference_id text,
  ledger_group_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cfo_debit_obligations_user ON public.cfo_debit_obligations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_cfo_debit_obligations_ref ON public.cfo_debit_obligations(ledger_reference_id);

ALTER TABLE public.cfo_debit_obligations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cfo_debit_obligations_finance_read" ON public.cfo_debit_obligations;
CREATE POLICY "cfo_debit_obligations_finance_read"
  ON public.cfo_debit_obligations FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'operations')
    OR auth.uid() = user_id
  );

DROP POLICY IF EXISTS "cfo_debit_obligations_finance_write" ON public.cfo_debit_obligations;
CREATE POLICY "cfo_debit_obligations_finance_write"
  ON public.cfo_debit_obligations FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
  );

DROP POLICY IF EXISTS "cfo_debit_obligations_finance_update" ON public.cfo_debit_obligations;
CREATE POLICY "cfo_debit_obligations_finance_update"
  ON public.cfo_debit_obligations FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
  );

CREATE OR REPLACE FUNCTION public.touch_cfo_debit_obligations_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_touch_cfo_debit_obligations ON public.cfo_debit_obligations;
CREATE TRIGGER trg_touch_cfo_debit_obligations
  BEFORE UPDATE ON public.cfo_debit_obligations
  FOR EACH ROW EXECUTE FUNCTION public.touch_cfo_debit_obligations_updated_at();

CREATE OR REPLACE FUNCTION public.enforce_correction_classification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.category IN ('system_balance_correction','wallet_route_repair','admin_adjustment') THEN
    IF NEW.classification IS DISTINCT FROM 'admin_correction' THEN
      NEW.classification := 'admin_correction';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_correction_classification ON public.general_ledger;
CREATE TRIGGER trg_enforce_correction_classification
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.enforce_correction_classification();

CREATE OR REPLACE FUNCTION public.block_legacy_wallet_deduction()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.category = 'wallet_deduction' THEN
    RAISE EXCEPTION 'WALLET_DEDUCTION_RETIRED: category wallet_deduction was retired 2026-05. Use cfo-direct-credit (operation:debit) which posts a cfo_debit_obligations row.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_block_legacy_wallet_deduction ON public.general_ledger;
CREATE TRIGGER trg_block_legacy_wallet_deduction
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.block_legacy_wallet_deduction();