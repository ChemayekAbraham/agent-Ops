-- Add rent balance tracking to landlords table
-- rent_balance_due = how much rent the tenant still owes for current period
-- rent_last_paid_at = when they last paid
-- rent_last_paid_amount = last payment amount
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS rent_balance_due numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rent_last_paid_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS rent_last_paid_amount numeric;

-- Initialize rent_balance_due = monthly_rent for landlords that have a tenant assigned
UPDATE public.landlords
SET rent_balance_due = COALESCE(monthly_rent, 0)
WHERE tenant_id IS NOT NULL AND rent_balance_due = 0 AND monthly_rent IS NOT NULL;

-- Create a function to reduce rent balance when payment is made
CREATE OR REPLACE FUNCTION public.record_rent_payment(
  p_landlord_id uuid,
  p_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.landlords
  SET
    rent_balance_due = GREATEST(0, rent_balance_due - p_amount),
    rent_last_paid_at = now(),
    rent_last_paid_amount = p_amount,
    updated_at = now()  -- if column exists; safe if not via DO block
  WHERE id = p_landlord_id;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.record_rent_payment(uuid, numeric) TO authenticated;