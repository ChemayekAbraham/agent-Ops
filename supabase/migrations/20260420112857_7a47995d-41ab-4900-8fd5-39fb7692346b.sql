-- Receipt tracking columns on landlord_payouts
ALTER TABLE public.landlord_payouts
  ADD COLUMN IF NOT EXISTS receipt_number text,
  ADD COLUMN IF NOT EXISTS receipt_image_url text,
  ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_receipt_pending
  ON public.landlord_payouts (agent_id, finops_disbursed_at)
  WHERE status = 'awaiting_agent_receipt' AND receipt_image_url IS NULL;

-- Private storage bucket for receipts
INSERT INTO storage.buckets (id, name, public)
VALUES ('landlord-payout-receipts', 'landlord-payout-receipts', false)
ON CONFLICT (id) DO NOTHING;

-- Helper: which staff roles can read all receipts
CREATE OR REPLACE FUNCTION public.can_read_landlord_payout_receipts(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role IN ('manager', 'cfo', 'coo', 'super_admin', 'operations')
  )
$$;

-- Storage RLS: agents read/write own folder, staff read all
DROP POLICY IF EXISTS "Agents upload own landlord receipts" ON storage.objects;
CREATE POLICY "Agents upload own landlord receipts"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'landlord-payout-receipts'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Agents update own landlord receipts" ON storage.objects;
CREATE POLICY "Agents update own landlord receipts"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'landlord-payout-receipts'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Agents read own landlord receipts" ON storage.objects;
CREATE POLICY "Agents read own landlord receipts"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'landlord-payout-receipts'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Staff read all landlord receipts" ON storage.objects;
CREATE POLICY "Staff read all landlord receipts"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'landlord-payout-receipts'
    AND public.can_read_landlord_payout_receipts(auth.uid())
  );