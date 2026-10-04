-- Dedicated landlord sub-ledger for annual payables/receivables.
-- This is SEPARATE from the financial general_ledger: it never drives
-- wallet balances or solvency reporting. It records, per placed tenant,
-- the annual rent payable to the landlord (monthly rent x 12) and leaves
-- room for the matching receivable (daily rent x 30 x 12).

CREATE TABLE IF NOT EXISTS public.landlord_account_ledger (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  landlord_id uuid NOT NULL,
  rent_request_id uuid NOT NULL,
  tenant_id uuid,
  entry_type text NOT NULL CHECK (entry_type IN ('payable', 'receivable')),
  monthly_rent numeric NOT NULL DEFAULT 0,
  daily_rent numeric NOT NULL DEFAULT 0,
  months integer NOT NULL DEFAULT 12,
  days_per_month integer NOT NULL DEFAULT 30,
  amount numeric NOT NULL DEFAULT 0,
  placement_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rent_request_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_landlord_account_ledger_landlord
  ON public.landlord_account_ledger (landlord_id, entry_type);

GRANT SELECT ON public.landlord_account_ledger TO authenticated;
GRANT ALL ON public.landlord_account_ledger TO service_role;

ALTER TABLE public.landlord_account_ledger ENABLE ROW LEVEL SECURITY;

-- Only ops staff may read this sub-ledger (admin-side accounting view).
CREATE POLICY "Ops can read landlord account ledger"
  ON public.landlord_account_ledger
  FOR SELECT
  TO authenticated
  USING (public.is_ops_role(auth.uid()));

-- keep updated_at fresh
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_landlord_account_ledger_updated_at ON public.landlord_account_ledger;
CREATE TRIGGER trg_landlord_account_ledger_updated_at
  BEFORE UPDATE ON public.landlord_account_ledger
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Idempotent generator: one payable row per placed rent placement.
-- Payable amount = monthly rent (rent_requests.rent_amount) x 12 months.
-- Re-running upserts (no duplicates) and refreshes amounts/status.
CREATE OR REPLACE FUNCTION public.generate_landlord_payables()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized: ops role required';
  END IF;

  INSERT INTO public.landlord_account_ledger
    (landlord_id, rent_request_id, tenant_id, entry_type,
     monthly_rent, daily_rent, months, days_per_month, amount, placement_status)
  SELECT
    rr.landlord_id,
    rr.id,
    rr.tenant_id,
    'payable',
    COALESCE(rr.rent_amount, 0),
    COALESCE(rr.daily_repayment, 0),
    12,
    30,
    COALESCE(rr.rent_amount, 0) * 12,
    rr.status
  FROM public.rent_requests rr
  WHERE rr.landlord_id IS NOT NULL
    AND rr.status IN ('funded', 'repaying', 'active', 'completed')
  ON CONFLICT (rent_request_id, entry_type) DO UPDATE SET
    landlord_id     = EXCLUDED.landlord_id,
    tenant_id       = EXCLUDED.tenant_id,
    monthly_rent    = EXCLUDED.monthly_rent,
    daily_rent      = EXCLUDED.daily_rent,
    amount          = EXCLUDED.amount,
    placement_status = EXCLUDED.placement_status,
    updated_at      = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_landlord_payables() TO authenticated;