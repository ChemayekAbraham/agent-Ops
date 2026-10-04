-- Fix: drop plaintext verification code (only hashed value should exist)
ALTER TABLE public.cash_deposit_verifications DROP COLUMN IF EXISTS code_plain;

-- Fix: remove materialized views from the PostgREST Data API surface.
-- Frontend code doesn't query these directly; server-side / definer functions
-- can still read them via the postgres owner.
REVOKE ALL ON public.mv_ops_daily_summary FROM anon, authenticated;
REVOKE ALL ON public.mv_house_location_rollup FROM anon, authenticated;
REVOKE ALL ON public.platform_stats FROM anon, authenticated;