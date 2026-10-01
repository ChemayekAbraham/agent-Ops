ALTER FUNCTION public.refresh_wallet_totals_cache()        SET work_mem = '64MB';
ALTER FUNCTION public.repair_wallet_cache_drift(integer)   SET work_mem = '64MB';
ALTER FUNCTION public.detect_wallet_projection_drift(integer) SET work_mem = '64MB';