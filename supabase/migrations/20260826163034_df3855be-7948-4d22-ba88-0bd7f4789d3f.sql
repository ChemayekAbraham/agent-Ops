REVOKE EXECUTE ON FUNCTION public.get_verification_reversal_preview(text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reverse_verification(text, uuid, text) FROM PUBLIC, anon;