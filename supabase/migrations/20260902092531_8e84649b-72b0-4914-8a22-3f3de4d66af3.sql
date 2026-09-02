REVOKE EXECUTE ON FUNCTION public.landlord_agreement_actor_can_view(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.landlord_has_current_agreement(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.submit_landlord_agreement(uuid, text, text, text, text, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.landlord_agreement_history(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.guard_landlord_agreement_backed_changes() FROM anon;
REVOKE EXECUTE ON FUNCTION public.guard_landlord_agreement_immutability() FROM anon;
REVOKE EXECUTE ON FUNCTION public.landlord_agreements_touch_updated_at() FROM anon;
REVOKE EXECUTE ON FUNCTION public.landlord_agreement_set_current() FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_landlord_verification(uuid, text, text, text) FROM anon;