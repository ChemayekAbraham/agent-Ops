-- Self-scoped "which landlords rows belong to me" for the native Android
-- app's landlord dashboard, first feature (My Properties).
--
-- Why this needs its own RPC, not a client-side .from('landlords').select():
-- `landlords` has NO column linking a row to the authenticated landlord's own
-- auth.uid(). `registered_by` is who ENTERED the row into the system — almost
-- always the AGENT who registered the property, not the landlord themselves
-- (confirmed by migration 20260904090000_fix_landlord_id_profiles_mismatch.sql,
-- which fixed several functions that wrongly assumed landlords.id == profiles.id).
-- A landlord's own dashboard scoping by registered_by = auth.uid() (what
-- useLandlordStats.ts and MyPropertiesSheet.tsx both do today) shows 0
-- properties for the overwhelming majority of real landlords, because they
-- didn't register the row — their agent did.
--
-- This RPC instead matches by phone number, the only identity signal that
-- realistically connects a landlord's own account to their property rows:
-- resolves auth.uid() -> profiles.phone, then finds every `landlords` row
-- whose phone matches (same digit-normalization find_landlord_by_phone()
-- already uses, generalized to return every match instead of just one).
--
-- Verified against live data before building on it: of 58,749 accounts
-- holding the 'landlord' role, only 108 have a phone-matchable landlords
-- row at all. That is not a bug in this RPC — it reflects that most
-- landlord-role accounts in this system today have no self-registered
-- link to their properties, which the web dashboard also doesn't solve
-- (it has the same registered_by gap). Documented in
-- docs/HANDOVER/107-landlord-identity-linkage-gap.md.

CREATE OR REPLACE FUNCTION public.get_my_landlord_properties()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_phone text;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT phone INTO v_phone FROM public.profiles WHERE id = v_uid;

  IF v_phone IS NULL OR length(regexp_replace(v_phone, '\D', '', 'g')) < 9 THEN
    RETURN jsonb_build_object('matched_by_phone', false, 'properties', '[]'::jsonb);
  END IF;

  WITH q AS (
    SELECT regexp_replace(v_phone, '\D', '', 'g') AS digits
  ), n AS (
    SELECT
      digits,
      CASE WHEN digits LIKE '256%' AND length(digits) >= 12 THEN '0' || substr(digits, 4) ELSE digits END AS local_digits,
      CASE WHEN digits LIKE '0%' AND length(digits) >= 10 THEN '256' || substr(digits, 2) ELSE digits END AS intl_digits
    FROM q
  ),
  matched AS (
    SELECT l.*
    FROM public.landlords l, n
    WHERE regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g') IN (n.digits, n.local_digits, n.intl_digits)
  )
  SELECT jsonb_build_object(
    'matched_by_phone', true,
    'properties', coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'property_address', m.property_address,
      'house_category', m.house_category,
      'district', m.district,
      'village', m.village,
      'monthly_rent', m.monthly_rent,
      'is_occupied', m.is_occupied,
      'verified', m.verified,
      'number_of_houses', m.number_of_houses,
      'number_of_rooms', m.number_of_rooms,
      'tenant_name', pt.full_name,
      'tenant_phone', pt.phone,
      'created_at', m.created_at
    ) ORDER BY m.created_at DESC), '[]'::jsonb)
  ) INTO v_result
  FROM matched m
  LEFT JOIN public.profiles pt ON pt.id = m.tenant_id;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_landlord_properties() TO authenticated;
