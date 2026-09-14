-- Face check on agent-posted rent requests.
--
-- WHY
-- `verify-passport-photo` already grades a passport photo and records its
-- SHA-256 in `identity_photo_fingerprints`. It was written for tenant
-- self-onboarding, where the person in the photo IS the signed-in caller, so
-- the row is filed under `auth.uid()`.
--
-- When an AGENT registers a tenant the caller is the agent and the face is the
-- tenant's, and at the moment the photo is taken the tenant usually has no
-- account yet. Two things are therefore needed:
--
--   1. `checked_by` - who ran the check, kept separately from `user_id`
--      (whose face it is). Without it, every agent-captured fingerprint would
--      pile up on the agent's own identity.
--   2. `link_identity_photo_fingerprint` - once the rent request exists and the
--      tenant's account id is known, move the agent's capture-time row onto the
--      tenant and stamp the request it belongs to.
--
-- And for review: `identity_photo_checks_for_request` gives the ops panels the
-- hashes and verdicts behind a request, plus how many OTHER people were checked
-- with the exact same image - the one thing a hash is uniquely good at telling
-- you, and a strong signal that one photo is being reused across registrations.
--
-- Reference data only. No wallet, ledger or financial record is touched here.

ALTER TABLE public.identity_photo_fingerprints
  ADD COLUMN IF NOT EXISTS checked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.identity_photo_fingerprints.user_id IS
  'Whose face the photo is. For agent registrations this is the tenant, not the agent.';
COMMENT ON COLUMN public.identity_photo_fingerprints.checked_by IS
  'Who ran the check. Equal to user_id for self-onboarding; the agent for agent-posted requests.';

CREATE INDEX IF NOT EXISTS identity_photo_fingerprints_checked_by_idx
  ON public.identity_photo_fingerprints (checked_by, checked_at DESC);
CREATE INDEX IF NOT EXISTS identity_photo_fingerprints_request_idx
  ON public.identity_photo_fingerprints (rent_request_id);


-- ---------------------------------------------------------------------------
-- Attach a capture-time fingerprint to the tenant it actually belongs to.
--
-- Called by the agent's browser straight after the rent request is inserted.
-- The browser may only ASK: every condition is proved server-side.
--   * the caller must have run this very check (checked_by = auth.uid());
--   * the caller must be the agent on the request (or an ops reviewer);
--   * the subject must be the tenant named on that request.
-- Nothing here can move a fingerprint onto an arbitrary person.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_identity_photo_fingerprint(
  p_sha256 text,
  p_rent_request_id uuid,
  p_photo_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_agent uuid;
  v_assigned uuid;
  v_existing uuid;
  v_temp uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'not_signed_in');
  END IF;
  IF p_sha256 IS NULL OR p_rent_request_id IS NULL THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'missing_arguments');
  END IF;

  SELECT tenant_id, agent_id, assigned_agent_id
    INTO v_tenant, v_agent, v_assigned
    FROM public.rent_requests
   WHERE id = p_rent_request_id;

  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'request_not_found');
  END IF;

  IF v_uid <> COALESCE(v_agent, '00000000-0000-0000-0000-000000000000'::uuid)
     AND v_uid <> COALESCE(v_assigned, '00000000-0000-0000-0000-000000000000'::uuid)
     AND NOT (
       public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')
       OR public.has_role(v_uid, 'agent_ops') OR public.has_role(v_uid, 'tenant_ops')
     )
  THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'not_your_request');
  END IF;

  -- The row the caller's own check produced.
  SELECT id INTO v_temp
    FROM public.identity_photo_fingerprints
   WHERE sha256 = p_sha256 AND checked_by = v_uid
   ORDER BY checked_at DESC
   LIMIT 1;

  IF v_temp IS NULL THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'no_check_by_you');
  END IF;

  -- The tenant may already carry this exact photo (a re-registration, or the
  -- agent re-using the tenant's saved passport photo). Keep that row, enrich
  -- it, and drop the capture-time duplicate rather than violating the
  -- (user_id, sha256) uniqueness.
  SELECT id INTO v_existing
    FROM public.identity_photo_fingerprints
   WHERE user_id = v_tenant AND sha256 = p_sha256;

  IF v_existing IS NOT NULL AND v_existing <> v_temp THEN
    UPDATE public.identity_photo_fingerprints
       SET rent_request_id = COALESCE(rent_request_id, p_rent_request_id),
           photo_url       = COALESCE(p_photo_url, photo_url),
           checked_by      = COALESCE(checked_by, v_uid)
     WHERE id = v_existing;
    DELETE FROM public.identity_photo_fingerprints WHERE id = v_temp;
    RETURN jsonb_build_object('linked', true, 'merged', true, 'user_id', v_tenant);
  END IF;

  UPDATE public.identity_photo_fingerprints
     SET user_id         = v_tenant,
         rent_request_id = COALESCE(p_rent_request_id, rent_request_id),
         photo_url       = COALESCE(p_photo_url, photo_url)
   WHERE id = v_temp;

  RETURN jsonb_build_object('linked', true, 'merged', false, 'user_id', v_tenant);
END;
$function$;

COMMENT ON FUNCTION public.link_identity_photo_fingerprint(text, uuid, text) IS
  'Moves a passport-photo fingerprint from the agent who captured it onto the tenant named on the rent request. Caller must have run the check and be the agent on that request.';

GRANT EXECUTE ON FUNCTION public.link_identity_photo_fingerprint(text, uuid, text) TO authenticated;


-- ---------------------------------------------------------------------------
-- The photo checks behind one rent request, for the review panels.
--
-- SECURITY DEFINER because `also_on_other_people` has to look across every
-- user's fingerprints, which no reviewer may read directly. Only the COUNT
-- crosses the boundary - never another person's row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.identity_photo_checks_for_request(p_rent_request_id uuid)
RETURNS TABLE (
  sha256 text,
  source text,
  verdict text,
  score numeric,
  is_face boolean,
  is_passport_photo boolean,
  failures jsonb,
  photo_url text,
  checked_at timestamptz,
  checked_by_name text,
  also_on_other_people integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_agent uuid;
  v_assigned uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  SELECT rr.tenant_id, rr.agent_id, rr.assigned_agent_id
    INTO v_tenant, v_agent, v_assigned
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id;

  IF v_tenant IS NULL THEN RETURN; END IF;

  -- Everyone who reviews the rent pipeline, plus the agent who posted it.
  IF NOT (
    v_uid = COALESCE(v_agent, '00000000-0000-0000-0000-000000000000'::uuid)
    OR v_uid = COALESCE(v_assigned, '00000000-0000-0000-0000-000000000000'::uuid)
    OR v_uid = v_tenant
    OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'agent_ops') OR public.has_role(v_uid, 'tenant_ops')
    OR public.has_role(v_uid, 'landlord_ops') OR public.has_role(v_uid, 'partner_ops')
    OR public.has_role(v_uid, 'coo') OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'ceo') OR public.has_role(v_uid, 'cto')
    OR public.has_role(v_uid, 'operations')
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT f.sha256,
         f.source,
         f.verdict,
         f.score,
         f.is_face,
         f.is_passport_photo,
         f.failures,
         f.photo_url,
         f.checked_at,
         p.full_name AS checked_by_name,
         (SELECT COUNT(DISTINCT o.user_id)
            FROM public.identity_photo_fingerprints o
           WHERE o.sha256 = f.sha256
             AND o.user_id <> f.user_id)::int AS also_on_other_people
    FROM public.identity_photo_fingerprints f
    LEFT JOIN public.profiles p ON p.id = f.checked_by
   WHERE f.user_id = v_tenant
     AND (f.rent_request_id IS NULL OR f.rent_request_id = p_rent_request_id)
   ORDER BY f.checked_at DESC
   LIMIT 10;
END;
$function$;

COMMENT ON FUNCTION public.identity_photo_checks_for_request(uuid) IS
  'Passport-photo hashes and face verdicts behind one rent request, with a count of other people checked with the identical image.';

GRANT EXECUTE ON FUNCTION public.identity_photo_checks_for_request(uuid) TO authenticated;
