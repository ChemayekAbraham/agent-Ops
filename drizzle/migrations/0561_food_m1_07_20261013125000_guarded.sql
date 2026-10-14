DO $fm1guard_outer$
DECLARE
  s text := $fm1guard$-- Food M1 — staff eligibility includes Platform Sales Officers.
--
-- NOT APPLIED TO PRODUCTION. Applies after 20261013120001.
--
-- PROBLEM. Every Food staff check required an enabled `employee` role:
-- canteen access (food_is_canteen_user), the coordinator successor lookup
-- (food_coordinator_candidates), the handover (food_transfer_coordinator) and
-- the first appointment (food_bootstrap_coordinator). Platform Sales Officers
-- are identified by HR, not by that role: public.v_pso_officers is active
-- hr_staff with a current "Platform Sales Officer" assignment. A PSO officer
-- without an `employee` role could therefore not order, could not be offered
-- as a successor, and could not be appointed.
--
-- FIX. One predicate, food_is_staff(user): a live profile AND (an enabled
-- `employee` role OR a current PSO officer). The four functions use it, so the
-- picker and the server-side checks can never disagree about who is staff.
-- Bodies are otherwise unchanged from 20261012120000 / 20261009160000 /
-- 20261009130001; grants are kept by CREATE OR REPLACE.
--
-- Nothing here touches money, wallets, the ledger, payment status or any
-- non-Food object. v_pso_officers is only read.
--
-- ROLLBACK: re-run the four definitions from 20261012120000 (canteen user,
-- bootstrap), 20261009160000 (candidates) and 20261009130001 (handover), then
-- their ALTER ... SET search_path = public, pg_temp from 20261012120000, then
-- DROP FUNCTION public.food_is_staff(uuid).

-- ═══════════════ the one staff predicate ═══════════════
-- Internal helper: not granted to anyone; called only from definer functions.
CREATE FUNCTION public.food_is_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT _user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = _user_id AND p.deleted_at IS NULL)
     AND (EXISTS (SELECT 1 FROM public.user_roles ur
                   WHERE ur.user_id = _user_id
                     AND ur.role = 'employee'::public.app_role
                     AND COALESCE(ur.enabled, true))
          OR EXISTS (SELECT 1 FROM public.v_pso_officers o
                      WHERE o.user_id = _user_id));
$$;
REVOKE ALL ON FUNCTION public.food_is_staff(uuid) FROM PUBLIC, anon, authenticated;

-- ═══════════════ canteen access ═══════════════
CREATE OR REPLACE FUNCTION public.food_is_canteen_user(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT _user_id IS NOT NULL AND (
    public.food_is_staff(_user_id)
    OR EXISTS (SELECT 1 FROM public.food_coordinator_assignments a
                WHERE a.coordinator_id = _user_id AND a.revoked_at IS NULL));
$$;

-- ═══════════════ successor lookup (active coordinator only) ═══════════════
-- The candidate set is drawn from the two staff sources first, so this never
-- scans every profile; each candidate then passes the same food_is_staff test
-- the handover applies.
CREATE OR REPLACE FUNCTION public.food_coordinator_candidates()
RETURNS TABLE(user_id uuid, full_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_food_coordinator(auth.uid()) THEN
    RAISE EXCEPTION 'Only the active Food Coordinator may look up a successor'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.id,
         coalesce(nullif(btrim(p.full_name), ''), 'Staff member') AS full_name
    FROM public.profiles p
   WHERE p.id IN (SELECT ur.user_id FROM public.user_roles ur
                   WHERE ur.role = 'employee'::public.app_role
                  UNION
                  SELECT o.user_id FROM public.v_pso_officers o)
     AND public.food_is_staff(p.id)
     -- a handover to yourself is refused by food_transfer_coordinator; do not
     -- offer it in the first place
     AND p.id <> auth.uid()
   ORDER BY 2;
END;
$$;

-- ═══════════════ handover ═══════════════
CREATE OR REPLACE FUNCTION public.food_transfer_coordinator(
  p_to_user_id uuid, p_mode text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator(); v_name text;
BEGIN
  IF p_mode NOT IN ('full_transfer','transfer_with_backup') THEN
    RAISE EXCEPTION 'Handover mode must be full_transfer or transfer_with_backup' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required' USING ERRCODE='22023'; END IF;
  IF p_to_user_id = v_actor THEN
    RAISE EXCEPTION 'Cannot hand over to yourself' USING ERRCODE='22023'; END IF;

  -- Eligibility is decided here, server-side, by the same predicate the
  -- picker uses (food_is_staff), so the two can never disagree.
  SELECT p.full_name INTO v_name
    FROM public.profiles p
   WHERE p.id = p_to_user_id
     AND public.food_is_staff(p.id);
  IF v_name IS NULL THEN
    -- Deliberately one message for every ineligible case. Distinguishing
    -- "no such profile" from "not staff" would let a coordinator probe the
    -- staff directory through this RPC.
    RAISE EXCEPTION 'Incoming coordinator is not an eligible employee account'
      USING ERRCODE='P0002',
            HINT='The recipient must be an enabled employee or a Platform Sales Officer with an active profile.';
  END IF;

  -- retire the outgoing assignment first so the one-active index is satisfied
  UPDATE public.food_coordinator_assignments
     SET revoked_at=now(), revoked_by=v_actor, handover_mode=p_mode, reason=p_reason
   WHERE coordinator_id=v_actor AND revoked_at IS NULL;

  -- and retire any prior (e.g. backup) assignment the incoming holder still has,
  -- so a handover can never leave one person with two live rows
  UPDATE public.food_coordinator_assignments
     SET revoked_at=now(), revoked_by=v_actor, reason='Superseded by handover'
   WHERE coordinator_id=p_to_user_id AND revoked_at IS NULL;

  INSERT INTO public.food_coordinator_assignments
    (coordinator_id, access_level, assigned_by, handover_mode, reason)
  VALUES (p_to_user_id, 'active', v_actor, p_mode, p_reason);

  IF p_mode='transfer_with_backup' THEN
    INSERT INTO public.food_coordinator_assignments
      (coordinator_id, access_level, assigned_by, handover_mode, reason)
    VALUES (v_actor, 'backup', v_actor, p_mode, 'Retained read-only backup access');
  END IF;

  PERFORM public.food_audit_write('coordinator', p_to_user_id, 'handover_'||p_mode,
    jsonb_build_object('from', v_actor), jsonb_build_object('to', p_to_user_id, 'mode', p_mode),
    p_reason, v_actor);

  RETURN jsonb_build_object('status','transferred','from',v_actor,'to',p_to_user_id,
                            'to_name',v_name,'mode',p_mode);
END $$;

-- ═══════════════ first appointment (service role only) ═══════════════
CREATE OR REPLACE FUNCTION public.food_bootstrap_coordinator(p_user_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.food_coordinator_assignments
              WHERE revoked_at IS NULL AND access_level = 'active') THEN
    RAISE EXCEPTION 'A Food Coordinator is already seated; use the handover instead'
      USING ERRCODE='22023'; END IF;
  IF NOT public.food_is_staff(p_user_id) THEN
    RAISE EXCEPTION 'The appointee is not an eligible employee account' USING ERRCODE='P0002'; END IF;

  -- the partial unique index food_one_active_coordinator settles a race between
  -- two bootstrap calls: exactly one INSERT can succeed
  INSERT INTO public.food_coordinator_assignments (coordinator_id, access_level, assigned_by, reason)
  VALUES (p_user_id, 'active', NULL, v_reason);

  PERFORM public.food_audit_write('coordinator', p_user_id, 'bootstrap_appointed', NULL,
    jsonb_build_object('to', p_user_id), v_reason, p_user_id);
  RETURN jsonb_build_object('status', 'appointed', 'coordinator_id', p_user_id);
END $$;
$fm1guard$;
  h text := encode(sha256(convert_to(s, 'UTF8')), 'hex');
BEGIN
  IF h <> '0f35f3de0ea023261805f5138c2a8a00134964411edb925607c1e8b04f3b5d2e' THEN
    RAISE EXCEPTION 'food m1 guard: 20261013125000 checksum mismatch, got %', h;
  END IF;
  EXECUTE s;
END
$fm1guard_outer$;