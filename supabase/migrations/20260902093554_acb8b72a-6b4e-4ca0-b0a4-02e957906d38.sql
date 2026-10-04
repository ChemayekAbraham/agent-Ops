REVOKE ALL ON FUNCTION public.landlord_agreement_actor_can_view(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_agreement_actor_can_view(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.landlord_has_current_agreement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_has_current_agreement(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.submit_landlord_agreement(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_landlord_agreement(uuid, text, text, text, text, text, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.landlord_agreement_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_agreement_history(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.landlord_agreements_touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_landlord_agreement_immutability() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_agreement_set_current() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_landlord_agreement_backed_changes() FROM PUBLIC, anon, authenticated;