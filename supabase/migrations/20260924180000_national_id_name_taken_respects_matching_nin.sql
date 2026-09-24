-- national_id_name_taken() previously flagged a name collision purely on the
-- printed name matching another account, with no way to tell "someone typed
-- a real person's name+NIN to link to that person's existing ID" (legitimate
-- -- submit_national_id_details()'s duplicate-NIN branch already handles this
-- by offering a link request) apart from "someone typed a real person's name
-- with a different, made-up NIN" (the genuine collision this check exists
-- for). Since the live IdentityPhotoCapture.tsx pre-submit check hard-disables
-- the Continue button whenever this RPC returns taken=true, the legitimate
-- linking case was completely unreachable via the UI: the exact same name
-- match that should have been allowed through to the duplicate-NIN/link-offer
-- path was instead permanently blocking it before submission was even possible.
--
-- Fix: accept the NIN being typed and only treat it as a collision when the
-- existing name-holder's National ID does NOT match it (fuzzy-normalized,
-- same comparison submit_national_id_details() already uses). p_nin is
-- optional and defaults to NULL, preserving prior behaviour for any caller
-- that doesn't pass it yet.
CREATE OR REPLACE FUNCTION public.national_id_name_taken(p_name text, p_user_id uuid DEFAULT NULL::uuid, p_nin text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_self uuid := coalesce(p_user_id, auth.uid());
  v_key text := public.person_name_key(coalesce(p_name, ''));
  v_nin_norm text := nullif(public.normalize_national_id_fuzzy(coalesce(p_nin, '')), '');
  v_owner uuid;
BEGIN
  IF v_key IS NULL OR position(' ' IN v_key) = 0 THEN
    RETURN jsonb_build_object('taken', false, 'reason', 'need_two_names');
  END IF;

  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE (v_self IS NULL OR p.id IS DISTINCT FROM v_self)
     AND public.person_name_key(coalesce(nullif(btrim(p.national_id_name), ''), p.full_name)) = v_key
     AND nullif(btrim(coalesce(p.national_id, '')), '') IS NOT NULL
     -- A name that matches because the SAME National ID is being linked (not
     -- copied) is not a collision -- submit_national_id_details()'s duplicate-NIN
     -- path already handles that case by offering a link request, so this
     -- live pre-submit check must not pre-block it.
     AND (v_nin_norm IS NULL
          OR public.normalize_national_id_fuzzy(coalesce(p.national_id, '')) IS DISTINCT FROM v_nin_norm)
   ORDER BY p.created_at
   LIMIT 1;

  RETURN jsonb_build_object('taken', v_owner IS NOT NULL, 'name_key', v_key);
END
$function$;
