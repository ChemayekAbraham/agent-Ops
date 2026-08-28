-- Remove the over-broad policy that exposed every verified landlord's banking
-- details and payout PINs to any agent on the platform.
DROP POLICY IF EXISTS "Agents can view all verified landlords" ON public.landlords;