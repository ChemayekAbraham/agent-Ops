-- Welile Signages: new owner / agent / CFO rules and loophole fixes (2026-11-13).
--
-- Flow after this migration:
--   draft (agent, editable, may be incomplete)
--   → submitted (locked; GPS, owner and photo checks run here)
--   → Agent Ops review → awaiting_coo → COO approves → pending_installation
--   → agent posts the installation (photo + live GPS at the spot) → installation_verification
--   → CFO pays the agent's one-time UGX 3,000 to their wallet → active (CFO may decline instead)
--   → owner: nothing in the first month; from one month after activation the CFO pays
--     UGX 10,000 a month to the owner's Welile wallet, until the CFO terminates (→ removed).
-- Money moves only through the CFO RPCs below.
--
-- Loopholes closed:
--   * agents (and Ops) can no longer edit an application after submission;
--   * the owner's payout goes to the owner's own Welile account, never the agent's,
--     and is fixed to that account after the first payout;
--   * GPS accuracy (≤ 50 m) and freshness (≤ 60 min) are enforced at submission;
--   * spots within 25 m of another application are flagged for review;
--   * the CFO can decline an installation or terminate a contract;
--   * owner payouts are recorded as a marketing expense, not a customer deposit;
--   * unused installation functions and over-broad table grants removed.

-- ── New columns ────────────────────────────────────────────────────────────────
ALTER TABLE public.welile_signages
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_user_id uuid,
  ADD COLUMN IF NOT EXISTS nearby_signage_ref text,
  ADD COLUMN IF NOT EXISTS nearby_signage_m numeric,
  ADD COLUMN IF NOT EXISTS termination_reason text,
  ADD COLUMN IF NOT EXISTS terminated_by uuid;

-- Drafts may be saved before every field is known; completeness is enforced on submission.
ALTER TABLE public.welile_signages
  ALTER COLUMN property_name DROP NOT NULL,
  ALTER COLUMN property_type DROP NOT NULL,
  ALTER COLUMN owner_full_name DROP NOT NULL,
  ALTER COLUMN owner_phone DROP NOT NULL,
  ALTER COLUMN consenting_relation DROP NOT NULL,
  ALTER COLUMN owner_payment_number DROP NOT NULL,
  ALTER COLUMN owner_payment_name DROP NOT NULL,
  ALTER COLUMN gps_latitude DROP NOT NULL,
  ALTER COLUMN gps_longitude DROP NOT NULL,
  ALTER COLUMN gps_accuracy_meters DROP NOT NULL,
  ALTER COLUMN gps_captured_at DROP NOT NULL,
  ALTER COLUMN gps_captured_at DROP DEFAULT,
  ALTER COLUMN district_name DROP NOT NULL,
  ALTER COLUMN village_name DROP NOT NULL;

-- ── Helpers ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION signage_internal.last9(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT nullif(right(regexp_replace(coalesce(p,''),'[^0-9]','','g'),9),'')
$$;

CREATE OR REPLACE FUNCTION signage_internal.metres(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT (6371000*2*asin(sqrt(power(sin(radians(lat2-lat1)/2),2)
    + cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lng2-lng1)/2),2))))::numeric
$$;

-- The Welile account an owner payout goes to, or why there is none.
CREATE OR REPLACE FUNCTION signage_internal.owner_account(p_signage_id uuid)
RETURNS TABLE(account_id uuid, account_name text, issue text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE s public.welile_signages; v_ids uuid[];
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public._has_enabled_role(auth.uid(), ARRAY['cfo','super_admin']) OR public.welile_signages_ops_ok()) THEN
    RAISE EXCEPTION 'Not allowed to look up signage owner accounts' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM public.welile_signages WHERE id = p_signage_id;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, NULL::text, 'Signage not found'; RETURN; END IF;
  IF s.owner_user_id IS NOT NULL THEN
    RETURN QUERY SELECT p.id, p.full_name, CASE WHEN p.deleted_at IS NOT NULL THEN 'The owner''s Welile account was deleted' END
      FROM public.profiles p WHERE p.id = s.owner_user_id;
    IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, NULL::text, 'The owner''s Welile account no longer exists'; END IF;
    RETURN;
  END IF;
  -- The owner's own phone, or their mobile-money number. A bank account number is never matched to a phone.
  SELECT array_agg(DISTINCT p.id) INTO v_ids FROM public.profiles p
   WHERE p.deleted_at IS NULL AND signage_internal.last9(p.phone) IS NOT NULL
     AND (signage_internal.last9(p.phone) = signage_internal.last9(s.owner_phone)
       OR (s.owner_payment_method IN ('momo_mtn','momo_airtel') AND signage_internal.last9(p.phone) = signage_internal.last9(s.owner_payment_number)));
  IF coalesce(cardinality(v_ids),0) = 0 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'The owner has no Welile account yet. Register them in the app with phone '||coalesce(s.owner_phone,'');
  ELSIF cardinality(v_ids) > 1 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'More than one Welile account matches the owner''s numbers. Ops must resolve this first.';
  ELSIF v_ids[1] = s.agent_id THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'The owner''s number belongs to the agent who registered this spot. The owner must be paid on their own account.';
  ELSE
    RETURN QUERY SELECT p.id, p.full_name, NULL::text FROM public.profiles p WHERE p.id = v_ids[1];
  END IF;
END $$;

-- ── One state machine for the whole workflow ──────────────────────────────────
-- Replaces the agent-transition, COO, evidence and CFO-activation guards.
DROP TRIGGER IF EXISTS trg_signages_agent_transition_guard ON public.welile_signages;
DROP TRIGGER IF EXISTS trg_signages_coo_workflow ON public.welile_signages;
DROP TRIGGER IF EXISTS trg_signages_evidence_guard ON public.welile_signages;
DROP TRIGGER IF EXISTS trg_zzz_signages_cfo_activation ON public.welile_signages;
DROP FUNCTION IF EXISTS public._welile_signages_agent_transition_guard();
DROP FUNCTION IF EXISTS public._welile_signages_coo_guard();
DROP FUNCTION IF EXISTS public._welile_signages_evidence_guard();
DROP FUNCTION IF EXISTS public._welile_signages_cfo_activation_guard();

CREATE OR REPLACE FUNCTION public._welile_signages_state_machine()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_service boolean := auth.uid() IS NULL;   -- migrations and service-role jobs
  v_agent boolean := auth.uid() IS NOT NULL AND auth.uid() = NEW.agent_id;
  v_ops boolean := public._has_enabled_role(auth.uid(), ARRAY['agent_ops','operations','manager','super_admin','admin','ceo']);
  v_coo boolean := public._has_enabled_role(auth.uid(), ARRAY['coo','super_admin']) AND public.staff_mfa_ok();
  v_install boolean := coalesce(current_setting('welile.signage_agent_install', true),'') = 'on';
  v_payout boolean := coalesce(current_setting('welile.signage_payout', true),'') = 'on';
  v_cfo text := coalesce(current_setting('welile.signage_cfo', true),'');
  v_submit boolean := false;
  v_agent_phone text;
  v_near record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft','submitted') THEN
      RAISE EXCEPTION 'A new signage application starts as a draft or a submission';
    END IF;
    NEW.coo_approved_by := NULL; NEW.coo_approved_at := NULL; NEW.coo_review_notes := NULL;
    NEW.owner_user_id := NULL; NEW.owner_rent_due_at := NULL; NEW.removal_effective_at := NULL;
    NEW.termination_reason := NULL; NEW.terminated_by := NULL; NEW.submitted_at := NULL;
    NEW.installed_at := NULL; NEW.installer_name := NULL; NEW.installation_photos := '[]'::jsonb;
    v_submit := NEW.status = 'submitted';
  ELSE
    -- Server-managed fields change only inside the matching RPC.
    IF NOT v_service THEN
      NEW.coo_approved_by := OLD.coo_approved_by; NEW.coo_approved_at := OLD.coo_approved_at;
      NEW.submitted_at := OLD.submitted_at; NEW.nearby_signage_ref := OLD.nearby_signage_ref;
      NEW.nearby_signage_m := OLD.nearby_signage_m; NEW.repeat_owner_phone := OLD.repeat_owner_phone;
      IF NOT v_payout THEN
        NEW.activated_at := OLD.activated_at; NEW.owner_rent_due_at := OLD.owner_rent_due_at;
        NEW.owner_user_id := OLD.owner_user_id; NEW.verified_by := OLD.verified_by; NEW.verified_at := OLD.verified_at;
      END IF;
      IF v_cfo <> 'terminate' THEN
        NEW.removal_effective_at := OLD.removal_effective_at; NEW.termination_reason := OLD.termination_reason;
        NEW.terminated_by := OLD.terminated_by;
      END IF;
      IF NOT v_install THEN
        NEW.installed_at := OLD.installed_at; NEW.installer_name := OLD.installer_name;
        NEW.installation_photos := OLD.installation_photos; NEW.installation_submitted_at := OLD.installation_submitted_at;
      END IF;
      IF NOT v_install AND v_cfo <> 'decline' AND NOT (v_coo AND OLD.status = 'awaiting_coo') THEN
        NEW.installation_started_at := OLD.installation_started_at; NEW.installation_decline_reason := OLD.installation_decline_reason;
      END IF;
    END IF;

    -- After submission the application is locked for everyone, Ops included.
    -- Only the agent may edit: a draft, or an application Ops returned for changes.
    IF NOT v_service AND NOT (v_agent AND (OLD.status = 'draft'
         OR (OLD.status = 'changes_required' AND NEW.status IN ('changes_required','submitted')))) THEN
      IF (NEW.property_name, NEW.property_type, NEW.business_category, NEW.owner_full_name, NEW.owner_phone,
          NEW.owner_alt_phone, NEW.consenting_relation, NEW.permission_confirmed, NEW.owner_payment_method,
          NEW.owner_payment_number, NEW.owner_payment_name, NEW.gps_latitude, NEW.gps_longitude,
          NEW.gps_accuracy_meters, NEW.gps_captured_at, NEW.gps_source, NEW.district_name, NEW.county_name,
          NEW.sub_county_name, NEW.parish_name, NEW.village_name, NEW.plot_or_landmark, NEW.foot_traffic,
          NEW.road_visibility, NEW.operating_hours, NEW.nearby_landmarks, NEW.proposed_surface,
          NEW.proposed_dimensions, NEW.accessibility_notes, NEW.photos, NEW.agent_name, NEW.agent_phone)
        IS DISTINCT FROM
         (OLD.property_name, OLD.property_type, OLD.business_category, OLD.owner_full_name, OLD.owner_phone,
          OLD.owner_alt_phone, OLD.consenting_relation, OLD.permission_confirmed, OLD.owner_payment_method,
          OLD.owner_payment_number, OLD.owner_payment_name, OLD.gps_latitude, OLD.gps_longitude,
          OLD.gps_accuracy_meters, OLD.gps_captured_at, OLD.gps_source, OLD.district_name, OLD.county_name,
          OLD.sub_county_name, OLD.parish_name, OLD.village_name, OLD.plot_or_landmark, OLD.foot_traffic,
          OLD.road_visibility, OLD.operating_hours, OLD.nearby_landmarks, OLD.proposed_surface,
          OLD.proposed_dimensions, OLD.accessibility_notes, OLD.photos, OLD.agent_name, OLD.agent_phone) THEN
        RAISE EXCEPTION 'This application is locked after submission. Only a draft, or an application returned for changes, can be edited.';
      END IF;
    END IF;

    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      IF NOT v_service AND NEW.coo_review_notes IS DISTINCT FROM OLD.coo_review_notes THEN
        RAISE EXCEPTION 'COO notes change only with a COO decision';
      END IF;
      IF NOT v_service AND OLD.status IN ('active','removed')
         AND (NEW.review_notes, NEW.rejection_reason) IS DISTINCT FROM (OLD.review_notes, OLD.rejection_reason) THEN
        RAISE EXCEPTION 'Active and terminated signages are read-only';
      END IF;
      RETURN NEW;
    END IF;

    IF NOT v_service THEN
      IF v_agent AND OLD.status IN ('draft','changes_required') AND NEW.status = 'submitted' THEN
        v_submit := true;
      ELSIF v_agent AND OLD.status IN ('draft','submitted','pending','changes_required','rejected') AND NEW.status = 'cancelled' THEN
        NULL;
      ELSIF v_ops AND OLD.status IN ('submitted','pending','under_review','changes_required')
            AND NEW.status IN ('awaiting_coo','approved_for_installation','changes_required','rejected') THEN
        IF NEW.status = 'approved_for_installation' THEN NEW.status := 'awaiting_coo'; END IF;
        NEW.reviewed_by := v_uid; NEW.reviewed_at := now();
      ELSIF v_coo AND OLD.status = 'awaiting_coo'
            AND NEW.status IN ('pending_installation','approved_for_installation','awaiting_cfo','changes_required','rejected') THEN
        IF NEW.status IN ('pending_installation','approved_for_installation','awaiting_cfo') THEN
          NEW.status := 'pending_installation';
          NEW.coo_approved_by := v_uid; NEW.coo_approved_at := now(); NEW.installation_started_at := now();
        END IF;
      ELSIF v_install AND v_agent AND OLD.status = 'pending_installation' AND NEW.status = 'installation_verification' THEN
        NULL;
      ELSIF v_payout AND OLD.status = 'installation_verification' AND NEW.status = 'active' THEN
        NULL;
      ELSIF v_cfo = 'decline' AND OLD.status = 'installation_verification' AND NEW.status = 'pending_installation' THEN
        NULL;
      ELSIF v_cfo = 'terminate' AND NEW.status = 'removed'
            AND OLD.status IN ('awaiting_cfo','pending_installation','installation_verification','active','temporarily_inactive','payment_on_hold') THEN
        NULL;
      ELSE
        RAISE EXCEPTION 'A signage application cannot move from % to % this way', OLD.status, NEW.status;
      END IF;
    END IF;
  END IF;

  IF v_submit THEN
    IF coalesce(btrim(NEW.property_name),'') = '' OR NEW.property_type IS NULL OR coalesce(btrim(NEW.owner_full_name),'') = ''
       OR signage_internal.last9(NEW.owner_phone) IS NULL OR coalesce(btrim(NEW.consenting_relation),'') = ''
       OR coalesce(btrim(NEW.owner_payment_number),'') = '' OR coalesce(btrim(NEW.owner_payment_name),'') = ''
       OR coalesce(btrim(NEW.district_name),'') = '' OR coalesce(btrim(NEW.village_name),'') = '' THEN
      RAISE EXCEPTION 'Complete the property, owner, payment and location details before submitting.';
    END IF;
    IF NOT coalesce(NEW.permission_confirmed, false) THEN
      RAISE EXCEPTION 'The owner''s permission must be confirmed before submitting.';
    END IF;
    IF jsonb_typeof(NEW.photos) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.photos) < 1 THEN
      RAISE EXCEPTION 'Add at least one photo of the spot before submitting.';
    END IF;
    IF NEW.gps_source IS DISTINCT FROM 'device' OR NEW.gps_latitude IS NULL OR NEW.gps_longitude IS NULL
       OR NEW.gps_latitude NOT BETWEEN -90 AND 90 OR NEW.gps_longitude NOT BETWEEN -180 AND 180
       OR NEW.gps_accuracy_meters IS NULL OR NEW.gps_accuracy_meters < 0 OR NEW.gps_captured_at IS NULL THEN
      RAISE EXCEPTION 'Real device GPS is required. Stand at the property and capture GPS again.';
    END IF;
    IF NEW.gps_accuracy_meters > 50 THEN
      RAISE EXCEPTION 'GPS accuracy is ±% m. Move to open sky and capture again until it is 50 m or better.', round(NEW.gps_accuracy_meters);
    END IF;
    IF NEW.gps_captured_at < now() - interval '60 minutes' OR NEW.gps_captured_at > now() + interval '5 minutes' THEN
      RAISE EXCEPTION 'The GPS reading is too old. Stand at the property and capture GPS again before submitting.';
    END IF;
    SELECT p.phone INTO v_agent_phone FROM public.profiles p WHERE p.id = NEW.agent_id;
    IF signage_internal.last9(v_agent_phone) IS NOT NULL AND (
         signage_internal.last9(v_agent_phone) = signage_internal.last9(NEW.owner_phone)
      OR (NEW.owner_payment_method IN ('momo_mtn','momo_airtel') AND signage_internal.last9(v_agent_phone) = signage_internal.last9(NEW.owner_payment_number))) THEN
      RAISE EXCEPTION 'The owner''s phone or payment number is your own number. Enter the owner''s details.';
    END IF;
    NEW.submitted_at := now();
    NEW.repeat_owner_phone := EXISTS (
      SELECT 1 FROM public.welile_signages s WHERE s.id <> NEW.id AND s.status NOT IN ('draft','cancelled')
        AND signage_internal.last9(s.owner_phone) = signage_internal.last9(NEW.owner_phone));
    SELECT s.reference_no, signage_internal.metres(NEW.gps_latitude, NEW.gps_longitude, s.gps_latitude, s.gps_longitude) AS m
      INTO v_near FROM public.welile_signages s
     WHERE s.id <> NEW.id AND s.status NOT IN ('draft','cancelled','rejected','removed') AND s.gps_latitude IS NOT NULL
     ORDER BY 2 LIMIT 1;
    IF FOUND AND v_near.m <= 25 THEN
      NEW.nearby_signage_ref := v_near.reference_no; NEW.nearby_signage_m := round(v_near.m);
    ELSE
      NEW.nearby_signage_ref := NULL; NEW.nearby_signage_m := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_zzz_signages_state_machine ON public.welile_signages;
CREATE TRIGGER trg_zzz_signages_state_machine BEFORE INSERT OR UPDATE ON public.welile_signages
  FOR EACH ROW EXECUTE FUNCTION public._welile_signages_state_machine();

-- The older guard keeps reference numbers and payout fields server-managed; it must not
-- re-stamp review fields for statuses the state machine now owns.
CREATE OR REPLACE FUNCTION public._welile_signages_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
begin
  if tg_op = 'INSERT' then
    new.reference_no := 'SGN-' || to_char(now(), 'YYYY') || '-' || nextval('public.welile_signage_seq');
    new.reviewed_by := null; new.reviewed_at := null; new.verified_by := null; new.verified_at := null;
    new.activated_at := null; new.agent_reward_status := 'not_eligible'; new.owner_rent_status := 'not_due';
    new.agent_reward_tx_ref := null; new.agent_reward_disbursed_at := null; new.agent_reward_disbursed_by := null;
    new.owner_rent_tx_ref := null; new.owner_rent_disbursed_at := null; new.owner_rent_disbursed_by := null;
    new.installation_started_at := null; new.installation_submitted_at := null; new.installation_decline_reason := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  if new.agent_id <> old.agent_id or new.reference_no <> old.reference_no or new.created_at <> old.created_at then
    raise exception 'Signage owner, reference and creation date cannot change';
  end if;
  if coalesce(current_setting('welile.signage_payout', true), '') <> 'on' then
    new.agent_reward_status := old.agent_reward_status; new.agent_reward_tx_ref := old.agent_reward_tx_ref;
    new.agent_reward_disbursed_at := old.agent_reward_disbursed_at; new.agent_reward_disbursed_by := old.agent_reward_disbursed_by;
    new.owner_rent_status := old.owner_rent_status; new.owner_rent_tx_ref := old.owner_rent_tx_ref;
    new.owner_rent_disbursed_at := old.owner_rent_disbursed_at; new.owner_rent_disbursed_by := old.owner_rent_disbursed_by;
  end if;
  if auth.uid() is not null and not public.welile_signages_ops_ok() then
    if (new.reviewed_by, new.reviewed_at, new.review_notes, new.rejection_reason)
       is distinct from (old.reviewed_by, old.reviewed_at, old.review_notes, old.rejection_reason) then
      raise exception 'Only Agent Ops can record review details';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $function$;

-- ── Row-level security: drafts, and no edits after submission ─────────────────
DROP POLICY IF EXISTS "signages agent insert own" ON public.welile_signages;
CREATE POLICY "signages agent insert own" ON public.welile_signages FOR INSERT TO authenticated
  WITH CHECK (agent_id = (select auth.uid()) AND status IN ('draft','submitted'));

DROP POLICY IF EXISTS "signages agent update own pending" ON public.welile_signages;
CREATE POLICY "signages agent update own pending" ON public.welile_signages FOR UPDATE TO authenticated
  USING (agent_id = (select auth.uid()) AND status IN ('draft','submitted','pending','changes_required','rejected'))
  WITH CHECK (agent_id = (select auth.uid()) AND status IN ('draft','submitted','pending','changes_required','cancelled'));

DROP POLICY IF EXISTS "signages ops read all" ON public.welile_signages;
CREATE POLICY "signages ops read all" ON public.welile_signages FOR SELECT TO authenticated
  USING ((select public.welile_signages_ops_ok()) AND status <> 'draft');

DROP POLICY IF EXISTS "signages ops update" ON public.welile_signages;
CREATE POLICY "signages ops update" ON public.welile_signages FOR UPDATE TO authenticated
  USING ((select public.welile_signages_ops_ok()) AND status <> 'draft')
  WITH CHECK ((select public.welile_signages_ops_ok()) AND status <> 'draft');

-- Over-broad grants: agents cancel instead of deleting; anonymous visitors see nothing.
REVOKE ALL ON public.welile_signages FROM anon;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.welile_signages FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.welile_signages TO authenticated;
GRANT ALL ON public.welile_signages TO service_role;

-- ── COO: approval now sends the spot for installation ─────────────────────────
CREATE OR REPLACE FUNCTION public.coo_decide_signage(p_signage_id uuid, p_decision text, p_notes text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE v_row public.welile_signages; v_status text;
BEGIN
 IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(), ARRAY['coo','super_admin']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the COO can decide signage applications'; END IF;
 IF p_decision NOT IN ('approve','return','reject') OR p_decision IS NULL THEN RAISE EXCEPTION 'Invalid signage decision'; END IF;
 IF p_decision IN ('return','reject') AND length(trim(coalesce(p_notes,''))) < 10 THEN RAISE EXCEPTION 'Please enter a reason of at least 10 characters'; END IF;
 SELECT * INTO v_row FROM public.welile_signages WHERE id = p_signage_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signage application not found'; END IF;
 IF v_row.status <> 'awaiting_coo' THEN RAISE EXCEPTION 'This application is no longer awaiting COO approval. Refresh the queue.'; END IF;
 v_status := CASE p_decision WHEN 'approve' THEN 'pending_installation' WHEN 'return' THEN 'changes_required' ELSE 'rejected' END;
 UPDATE public.welile_signages SET status=v_status, coo_review_notes=nullif(trim(p_notes),''), review_notes=coalesce(nullif(trim(p_notes),''),review_notes),
   rejection_reason=CASE WHEN p_decision='reject' THEN trim(p_notes) ELSE NULL END WHERE id=p_signage_id RETURNING * INTO v_row;
 RETURN jsonb_build_object('id',v_row.id,'status',v_row.status);
END; $function$;

-- ── Agent posts the installation (photo + live GPS at the spot) ───────────────
DROP FUNCTION IF EXISTS public.agent_submit_signage_installation(uuid, date, text, text);
DROP FUNCTION IF EXISTS public.ops_decide_signage_installation(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.my_signage_installations_due();

CREATE OR REPLACE FUNCTION public.agent_submit_signage_installation(
  p_signage_id uuid, p_photo_url text, p_gps_latitude numeric, p_gps_longitude numeric,
  p_gps_accuracy numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.welile_signages; v_name text; v_m numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in to post the installation' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_s FROM public.welile_signages WHERE id = p_signage_id FOR UPDATE;
  IF NOT FOUND OR v_s.agent_id <> v_uid THEN RAISE EXCEPTION 'Only the agent who registered this spot can post its installation'; END IF;
  IF v_s.status <> 'pending_installation' THEN RAISE EXCEPTION 'This signage is not waiting for an installation. Refresh.'; END IF;
  IF coalesce(p_photo_url,'') !~ '^(data:image/(webp|jpeg|png);base64,|https://)' THEN RAISE EXCEPTION 'Add a photo of the installed board'; END IF;
  IF p_gps_latitude IS NULL OR p_gps_longitude IS NULL OR p_gps_accuracy IS NULL OR p_gps_accuracy < 0 THEN
    RAISE EXCEPTION 'Capture live GPS at the spot to post the installation';
  END IF;
  IF p_gps_accuracy > 50 THEN RAISE EXCEPTION 'GPS accuracy is ±% m. Capture again until it is 50 m or better.', round(p_gps_accuracy); END IF;
  v_m := signage_internal.metres(v_s.gps_latitude, v_s.gps_longitude, p_gps_latitude, p_gps_longitude);
  IF v_m > 100 THEN
    RAISE EXCEPTION 'You are % m from the registered spot. Post the installation while standing at the property.', round(v_m);
  END IF;
  SELECT coalesce(nullif(trim(full_name),''), v_s.agent_name) INTO v_name FROM public.profiles WHERE id = v_uid;
  PERFORM set_config('welile.signage_agent_install','on',true);
  UPDATE public.welile_signages SET status = 'installation_verification',
    installed_at = (now() AT TIME ZONE 'Africa/Kampala')::date, installer_name = v_name,
    installation_submitted_at = now(), installation_decline_reason = NULL,
    installation_photos = jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'url', p_photo_url,
      'category', 'installed_signage', 'caption', coalesce(nullif(trim(p_note),''), 'installed signage'), 'taken_at', now(),
      'gps_latitude', p_gps_latitude, 'gps_longitude', p_gps_longitude, 'gps_accuracy_meters', p_gps_accuracy, 'metres_from_spot', round(v_m)))
   WHERE id = p_signage_id RETURNING * INTO v_s;
  PERFORM set_config('welile.signage_agent_install','',true);
  RETURN jsonb_build_object('id', v_s.id, 'status', v_s.status);
END $$;

-- ── CFO: pay agent (activates), pay owner monthly, decline, terminate ─────────
CREATE OR REPLACE FUNCTION signage_internal.cfo_disburse_signage(p_signage_id uuid, p_payout_type text, p_period_index integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.welile_signages; v_payment public.welile_signage_payments;
  v_recipient uuid; v_issue text; v_amount numeric; v_ref text; v_group uuid; v_next integer;
  v_flag text := coalesce(current_setting('welile.signage_payout',true),''); v_due timestamptz; v_existing boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public._has_enabled_role(v_uid,ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO can disburse signage payments' USING ERRCODE='42501';
  END IF;
  IF p_payout_type IS NULL OR p_payout_type NOT IN ('agent_reward','owner_rent') OR p_period_index IS NULL OR p_period_index < 0
     OR (p_payout_type = 'agent_reward' AND p_period_index <> 0) THEN
    RAISE EXCEPTION 'Invalid signage payout type or period';
  END IF;
  SELECT * INTO v_s FROM public.welile_signages WHERE id = p_signage_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Signage application not found'; END IF;

  IF p_payout_type = 'agent_reward' THEN
    IF v_s.status = 'active' THEN
      SELECT * INTO v_payment FROM public.welile_signage_payments WHERE signage_id = p_signage_id AND payout_type = 'agent_reward' AND period_index = 0;
      RETURN jsonb_build_object('signage_id',v_s.id,'status',v_s.status,'amount_ugx',3000,'reference_id',v_payment.reference_id,
        'recipient_id',v_payment.recipient_id,'ledger_group_id',v_payment.ledger_group_id,'already_paid',true);
    END IF;
    IF v_s.status <> 'installation_verification' OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(coalesce(v_s.installation_photos,'[]'::jsonb)) e WHERE e->>'category' = 'installed_signage') THEN
      RAISE EXCEPTION 'The agent is paid once, after posting the installation. This signage has no installation waiting for payment.';
    END IF;
    v_recipient := v_s.agent_id; v_amount := 3000;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_recipient AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'The agent''s Welile account is unavailable';
    END IF;
  ELSE
    IF v_s.status <> 'active' OR v_s.activated_at IS NULL OR v_s.removal_effective_at IS NOT NULL THEN
      RAISE EXCEPTION 'Owner payouts are for active signages whose contract has not been terminated';
    END IF;
    SELECT coalesce(max(period_index)+1, 0) INTO v_next FROM public.welile_signage_payments
     WHERE signage_id = p_signage_id AND payout_type = 'owner_rent';
    IF p_period_index <> v_next THEN RAISE EXCEPTION 'Owner payout month has changed. Refresh the queue.'; END IF;
    v_due := coalesce(v_s.owner_rent_due_at,
      ((v_s.activated_at AT TIME ZONE 'Africa/Kampala') + make_interval(months => v_next + 1)) AT TIME ZONE 'Africa/Kampala');
    IF v_due > now() THEN
      RAISE EXCEPTION 'The owner''s next payout is due on %. The first month after activation is not paid.', to_char(v_due AT TIME ZONE 'Africa/Kampala','DD Mon YYYY');
    END IF;
    SELECT account_id, issue INTO v_recipient, v_issue FROM signage_internal.owner_account(p_signage_id);
    IF v_issue IS NOT NULL OR v_recipient IS NULL THEN RAISE EXCEPTION '%', coalesce(v_issue, 'The owner''s Welile account could not be found'); END IF;
    IF v_recipient = v_s.agent_id THEN RAISE EXCEPTION 'The owner must be paid on their own account, not the agent''s'; END IF;
    v_amount := 10000;
  END IF;

  SELECT * INTO v_payment FROM public.welile_signage_payments
   WHERE signage_id = p_signage_id AND payout_type = p_payout_type AND period_index = p_period_index;
  v_existing := FOUND;
  IF NOT v_existing THEN
    v_ref := 'signage:'||p_signage_id||':'||p_payout_type||':'||p_period_index;
    v_group := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id',v_recipient,'amount',v_amount,'direction','cash_in',
        'category',CASE WHEN p_payout_type='agent_reward' THEN 'agent_bonus' ELSE 'marketing_expense' END,
        'ledger_scope','wallet','recipient_type','user','wallet_bucket','withdrawable','source_table','welile_signage_payments',
        'source_id',p_signage_id,'reference_id',v_ref,'currency','UGX',
        'description',CASE WHEN p_payout_type='agent_reward' THEN 'Welile Signages one-time agent reward for '||v_s.reference_no
          ELSE 'Welile Signages owner payout, month '||(p_period_index+2)||', '||v_s.reference_no END),
      jsonb_build_object('user_id',v_recipient,'amount',v_amount,'direction','cash_out','category','marketing_expense','ledger_scope','platform',
        'source_table','welile_signage_payments','source_id',p_signage_id,'reference_id',v_ref,'currency','UGX',
        'description','Welile Signages '||p_payout_type||' for '||v_s.reference_no)
    ), v_ref);
    IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = v_group AND user_id = v_recipient
                     AND ledger_scope = 'wallet' AND direction = 'cash_in' AND amount = v_amount AND reference_id = v_ref) THEN
      RAISE EXCEPTION 'Wallet disbursement could not be confirmed';
    END IF;
    PERFORM set_config('welile.signage_payout','on',true);
    INSERT INTO public.welile_signage_payments(signage_id,payout_type,period_index,recipient_id,amount_ugx,ledger_group_id,reference_id,paid_by)
      VALUES (p_signage_id,p_payout_type,p_period_index,v_recipient,v_amount,v_group,v_ref,v_uid) RETURNING * INTO v_payment;
    INSERT INTO public.system_events(event_type,user_id,related_entity_type,related_entity_id,metadata,actor_id)
      VALUES ('welile_signage_payment_disbursed',v_recipient,'welile_signages',p_signage_id,
        jsonb_build_object('payout_type',p_payout_type,'amount_ugx',v_amount,'period_index',p_period_index,'reference_id',v_ref,'ledger_group_id',v_group),v_uid);
    INSERT INTO public.audit_logs(user_id,action_type,table_name,record_id,reason,new_values,performed_by)
      VALUES (v_uid,'signage_payment_disbursed','welile_signages',p_signage_id,'CFO authorized signage wallet disbursement',
        jsonb_build_object('payout_type',p_payout_type,'amount_ugx',v_amount,'reference_id',v_ref,'recipient_id',v_recipient),v_uid);
  END IF;
  -- An agent reward paid before these rules (status was awaiting CFO) is not paid twice; it just activates.

  PERFORM set_config('welile.signage_payout','on',true);
  IF p_payout_type = 'agent_reward' THEN
    UPDATE public.welile_signages SET status = 'active', activated_at = now(), verified_by = v_uid, verified_at = now(),
      owner_rent_due_at = ((now() AT TIME ZONE 'Africa/Kampala') + interval '1 month') AT TIME ZONE 'Africa/Kampala',
      owner_rent_status = 'not_due',
      agent_reward_status = 'paid', agent_reward_tx_ref = v_payment.reference_id,
      agent_reward_disbursed_at = coalesce(agent_reward_disbursed_at, now()), agent_reward_disbursed_by = coalesce(agent_reward_disbursed_by, v_uid)
     WHERE id = p_signage_id RETURNING * INTO v_s;
  ELSE
    UPDATE public.welile_signages SET owner_user_id = v_recipient, owner_rent_status = 'paid', owner_rent_tx_ref = v_payment.reference_id,
      owner_rent_disbursed_at = now(), owner_rent_disbursed_by = v_uid,
      owner_rent_due_at = ((v_due AT TIME ZONE 'Africa/Kampala') + interval '1 month') AT TIME ZONE 'Africa/Kampala'
     WHERE id = p_signage_id RETURNING * INTO v_s;
  END IF;
  PERFORM set_config('welile.signage_payout',v_flag,true);
  PERFORM public.recompute_trust_score(v_recipient);
  RETURN jsonb_build_object('signage_id',v_s.id,'status',v_s.status,'amount_ugx',v_amount,'recipient_id',v_recipient,
    'reference_id',v_payment.reference_id,'ledger_group_id',v_payment.ledger_group_id,'already_paid',v_existing,
    'owner_rent_due_at',v_s.owner_rent_due_at);
END $function$;

-- Activation now happens only when the CFO pays the agent for a posted installation.
CREATE OR REPLACE FUNCTION signage_internal.cfo_approve_signage(p_signage_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'Signages become active when the CFO pays the agent for a posted installation.';
END $$;

CREATE OR REPLACE FUNCTION signage_internal.cfo_decline_signage_installation(p_signage_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_s public.welile_signages; v_flag text := coalesce(current_setting('welile.signage_cfo',true),'');
BEGIN
  IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO can decline an installation' USING ERRCODE='42501';
  END IF;
  IF length(trim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'Please give a reason of at least 10 characters'; END IF;
  SELECT * INTO v_s FROM public.welile_signages WHERE id = p_signage_id FOR UPDATE;
  IF NOT FOUND OR v_s.status <> 'installation_verification' THEN RAISE EXCEPTION 'This installation is no longer waiting for the CFO. Refresh.'; END IF;
  PERFORM set_config('welile.signage_cfo','decline',true);
  UPDATE public.welile_signages SET status = 'pending_installation', installation_decline_reason = trim(p_reason)
   WHERE id = p_signage_id RETURNING * INTO v_s;
  PERFORM set_config('welile.signage_cfo',v_flag,true);
  RETURN jsonb_build_object('signage_id',v_s.id,'status',v_s.status);
END $$;

CREATE OR REPLACE FUNCTION signage_internal.cfo_terminate_signage(p_signage_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_s public.welile_signages; v_flag text := coalesce(current_setting('welile.signage_cfo',true),'');
BEGIN
  IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO can terminate a signage contract' USING ERRCODE='42501';
  END IF;
  IF length(trim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'Please give a reason of at least 10 characters'; END IF;
  SELECT * INTO v_s FROM public.welile_signages WHERE id = p_signage_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Signage application not found'; END IF;
  IF v_s.status = 'removed' THEN RETURN jsonb_build_object('signage_id',v_s.id,'status',v_s.status,'already_terminated',true); END IF;
  PERFORM set_config('welile.signage_cfo','terminate',true);
  UPDATE public.welile_signages SET status = 'removed', removal_effective_at = now(), termination_reason = trim(p_reason), terminated_by = auth.uid()
   WHERE id = p_signage_id RETURNING * INTO v_s;
  PERFORM set_config('welile.signage_cfo',v_flag,true);
  RETURN jsonb_build_object('signage_id',v_s.id,'status',v_s.status,'already_terminated',false);
END $$;

CREATE OR REPLACE FUNCTION public.cfo_decline_signage_installation(p_signage_id uuid, p_reason text)
RETURNS jsonb LANGUAGE sql SET search_path TO 'public' AS $$ SELECT signage_internal.cfo_decline_signage_installation(p_signage_id, p_reason) $$;
CREATE OR REPLACE FUNCTION public.cfo_terminate_signage(p_signage_id uuid, p_reason text)
RETURNS jsonb LANGUAGE sql SET search_path TO 'public' AS $$ SELECT signage_internal.cfo_terminate_signage(p_signage_id, p_reason) $$;

-- ── CFO queue ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cfo_signages_queue()
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
BEGIN
 IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN
   RAISE EXCEPTION 'Only the CFO can view the signage disbursement queue' USING ERRCODE='42501';
 END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC),'[]'::jsonb) FROM (
  SELECT s.id,s.reference_no,s.agent_id,s.agent_name,s.agent_phone,s.property_name,s.property_type,s.owner_full_name,s.owner_phone,
   s.owner_payment_method,s.owner_payment_number,s.owner_payment_name,s.gps_latitude,s.gps_longitude,s.gps_accuracy_meters,
   s.district_name,s.sub_county_name,s.village_name,s.repeat_owner_phone,s.nearby_signage_ref,s.nearby_signage_m,s.status,
   s.installed_at,s.installer_name,s.installation_started_at,s.installation_submitted_at,s.installation_decline_reason,
   s.verified_by,s.verified_at,s.activated_at,s.coo_approved_at,s.removal_effective_at,s.termination_reason,
   s.agent_reward_status,s.agent_reward_disbursed_at,s.agent_reward_tx_ref,s.owner_rent_status,s.owner_rent_disbursed_at,
   s.owner_rent_tx_ref,s.created_at,s.updated_at,
   s.owner_rent_due_at,
   (SELECT count(*) FROM public.welile_signage_payments p WHERE p.signage_id=s.id AND p.payout_type='owner_rent')::int AS owner_rent_period_index,
   (s.status='active' AND s.removal_effective_at IS NULL AND s.owner_rent_due_at IS NOT NULL AND s.owner_rent_due_at<=now()) AS owner_rent_payable,
   (s.status='installation_verification') AS agent_reward_payable,
   oa.account_id AS owner_account_id, oa.account_name AS owner_account_name, oa.issue AS owner_account_issue
  FROM public.welile_signages s
  LEFT JOIN LATERAL signage_internal.owner_account(s.id) oa ON s.status IN ('installation_verification','active')
  WHERE s.status IN ('awaiting_cfo','pending_installation','installation_verification','active','removed')
 ) q);
END $function$;

-- ── Owner/business list: drafts are the agent's own work in progress ─────────
DO $$
DECLARE d text := pg_get_functiondef('public.signage_owner_business_list'::regproc); n text;
BEGIN
  n := replace(d, 'FROM public.welile_signages s GROUP BY 1,2', 'FROM public.welile_signages s WHERE s.status <> ''draft'' GROUP BY 1,2');
  IF n = d THEN RAISE EXCEPTION 'signage_owner_business_list: expected text not found, update this migration'; END IF;
  EXECUTE n;
END $$;

-- ── Grants (new functions are closed by default) ──────────────────────────────
REVOKE ALL ON FUNCTION signage_internal.owner_account(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION signage_internal.last9(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION signage_internal.metres(numeric,numeric,numeric,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION signage_internal.last9(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION signage_internal.metres(numeric,numeric,numeric,numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION signage_internal.owner_account(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_submit_signage_installation(uuid,text,numeric,numeric,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_submit_signage_installation(uuid,text,numeric,numeric,numeric,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION signage_internal.cfo_decline_signage_installation(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION signage_internal.cfo_terminate_signage(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION signage_internal.cfo_decline_signage_installation(uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION signage_internal.cfo_terminate_signage(uuid,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cfo_decline_signage_installation(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_terminate_signage(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_decline_signage_installation(uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cfo_terminate_signage(uuid,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public._welile_signages_state_machine() FROM PUBLIC, anon, authenticated;

-- ── Existing applications ─────────────────────────────────────────────────────
-- COO-approved spots now go to installation first (one agent reward was already paid
-- under the old rules; it is not paid again — posting the installation activates it).
UPDATE public.welile_signages SET status = 'pending_installation', installation_started_at = coalesce(installation_started_at, now()),
  owner_rent_due_at = NULL
 WHERE status IN ('awaiting_cfo','approved_for_installation','installation_in_progress');
-- Backfill submission time and the duplicate-spot flag for applications already in review.
UPDATE public.welile_signages s SET submitted_at = coalesce(s.submitted_at, s.created_at),
  nearby_signage_ref = n.reference_no, nearby_signage_m = round(n.m)
  FROM public.welile_signages s0
  LEFT JOIN LATERAL (
    SELECT o.reference_no, signage_internal.metres(s0.gps_latitude, s0.gps_longitude, o.gps_latitude, o.gps_longitude) m
      FROM public.welile_signages o
     WHERE o.id <> s0.id AND o.status NOT IN ('draft','cancelled','rejected','removed') AND o.gps_latitude IS NOT NULL
     ORDER BY 2 LIMIT 1) n ON n.m <= 25
 WHERE s.id = s0.id AND s.status NOT IN ('draft','cancelled');
