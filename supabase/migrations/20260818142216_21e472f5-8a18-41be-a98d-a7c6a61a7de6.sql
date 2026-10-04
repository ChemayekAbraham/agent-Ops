REVOKE ALL ON FUNCTION public.guard_platform_wallet_correction() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.block_platform_wallet_correction_mutation() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_wallet_correction_evidence() FROM anon, authenticated;