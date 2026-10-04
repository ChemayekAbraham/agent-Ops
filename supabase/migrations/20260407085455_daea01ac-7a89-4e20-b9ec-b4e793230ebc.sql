
-- Add receipt tracking to investor_portfolios
ALTER TABLE investor_portfolios 
  ADD COLUMN IF NOT EXISTS investment_reference TEXT,
  ADD COLUMN IF NOT EXISTS receipt_file_url TEXT,
  ADD COLUMN IF NOT EXISTS cfo_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cfo_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cfo_verified_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS cfo_rejection_reason TEXT;

-- Private bucket for investment receipts
INSERT INTO storage.buckets (id, name, public) 
VALUES ('investment-receipts', 'investment-receipts', false)
ON CONFLICT (id) DO NOTHING;

-- Agents upload to their own folder
CREATE POLICY "Agents upload investment receipts"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'investment-receipts' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Agents can view their own receipts
CREATE POLICY "Agents view own investment receipts"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'investment-receipts' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Staff can view all investment receipts
CREATE POLICY "Staff view all investment receipts"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'investment-receipts' 
  AND EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = auth.uid() 
    AND role IN ('manager', 'cfo', 'coo', 'super_admin', 'cto', 'operations')
  )
);
