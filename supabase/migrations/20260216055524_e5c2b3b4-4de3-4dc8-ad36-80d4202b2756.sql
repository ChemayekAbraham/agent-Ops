
-- ============================================================
-- FIX 1: Profiles - Remove unauthenticated public access
-- ============================================================
DROP POLICY IF EXISTS "Public can view profiles" ON public.profiles;

-- ============================================================
-- FIX 2: Receipt numbers - Remove overly permissive update policy
-- ============================================================
DROP POLICY IF EXISTS "Vendors can update own receipts with PIN" ON public.receipt_numbers;

-- ============================================================
-- FIX 3: Wallets - Remove client-side update/insert policies
-- ============================================================
DROP POLICY IF EXISTS "System can update own wallet" ON public.wallets;
DROP POLICY IF EXISTS "System can insert wallets" ON public.wallets;

ALTER TABLE public.wallets ADD CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0);

-- ============================================================
-- FIX 4: User receipts - Remove permissive system update policy
-- ============================================================
DROP POLICY IF EXISTS "System can update receipts" ON public.user_receipts;

CREATE POLICY "Managers can update receipts"
ON public.user_receipts FOR UPDATE
USING (has_role(auth.uid(), 'manager'::app_role))
WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

-- ============================================================
-- FIX 5: Supporter invites - Restrict SELECT to not expose credentials
-- ============================================================
DROP POLICY IF EXISTS "Anyone can view invite by token" ON public.supporter_invites;

CREATE POLICY "Authorized users can view invites"
ON public.supporter_invites FOR SELECT
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR auth.uid() = created_by
  OR auth.uid() = activated_user_id
);

-- ============================================================
-- FIX 6: Payment proofs storage - Make private
-- ============================================================
UPDATE storage.buckets SET public = false WHERE id = 'payment-proofs';

DROP POLICY IF EXISTS "Anyone can view payment proofs" ON storage.objects;

CREATE POLICY "Authenticated users view payment proofs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'payment-proofs'
  AND auth.role() = 'authenticated'
);

-- ============================================================
-- FIX 7: Add pin_hash column to vendors and clear plaintext PINs
-- ============================================================
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS pin_hash text;

UPDATE public.vendors SET pin = NULL WHERE pin IS NOT NULL AND pin_hash IS NOT NULL;
