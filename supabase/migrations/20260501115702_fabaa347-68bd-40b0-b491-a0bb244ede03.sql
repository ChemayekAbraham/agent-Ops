DROP TRIGGER IF EXISTS trg_validate_operational_float_allocations ON public.deposit_requests;

COMMENT ON FUNCTION public.validate_operational_float_allocations() IS 'Deprecated 2026-05-01: operational float deposits are no longer blocked when no per-tenant allocation breakdown is supplied.';