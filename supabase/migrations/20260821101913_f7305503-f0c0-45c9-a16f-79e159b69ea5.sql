DROP FUNCTION IF EXISTS public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid);

REVOKE ALL ON FUNCTION public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid, uuid) TO service_role;