-- Handover doc 120 — Landlord payout-number lock + four-stage change chain.
--
-- CEO P0 (2026-09-23 meeting): landlord phone numbers change after they were
-- submitted and approved; by the time Ops reached the landlord for a
-- withdrawal, the number had changed. This is a FRAUD PATH, not data hygiene:
-- the concern is agents withdrawing to numbers they swapped in.
--
-- What was still open after doc 112 (which made landlord_payouts pay only
-- landlords.verified_mobile_money_number):
--   1. landlords.phone / mobile_money_number stayed freely writable on a
--      VERIFIED landlord — by the registering/managing agent (RLS "Agents can
--      update managed landlords"), the tenant (RLS "Tenants can update own
--      landlords"), ops (ops_update_landlord, EditLandlordDialog),
--      agent_resubmit_rent_request, and service-role writers. The only guard,
--      guard_landlord_agreement_backed_changes, logs and by design never
--      blocks. Live: 124 phone/MoMo changes on 105 verified landlords
--      09-09..09-23, 36 by agents, 87 by an unattributed service-role writer.
--   2. Any later ad-hoc re-verification (set_landlord_verification with no
--      pending request) snapshots the CURRENT mobile_money_number into the
--      approved slot — so a swapped-in number is laundered into "approved"
--      the next time anyone clicks verify.
--   3. The one-stage "phone change request" (landlord_verification_requests
--      from AgentFloatPayoutWizard) put a NEW number straight into the
--      approved slot on a single Landlord Ops click — skipping service
--      centre, tenant ops and agent ops.
--   4. Pipeline auto-verify and service_mark_landlord_verified verify with no
--      approved-number snapshot at all (fail-safe, but inconsistent).
--
-- Fix, enforced at the database (not by hiding an edit button):
--   * trg_ab_lock_verified_landlord_numbers: once a landlord is verified (or
--     holds an approved number), NOBODY — agent, tenant, ops, service role —
--     can change phone / mobile_money_number by UPDATE. The attempted value
--     is reverted, audited, and turned into a change request.
--   * landlord_number_change_requests: the new number re-enters the chain
--     from the start: service centre -> tenant ops -> agent ops -> landlord
--     ops. Four distinct people, none of them the requester. Expires after
--     7 days. Only the final Landlord Ops approval applies the number and
--     moves the approved payout number with it.
--   * landlord_number_audit: append-only, one row per blocked edit, per
--     request transition, and per applied change, with old/new value + actor.
--   * set_landlord_verification: on an already-verified landlord it no longer
--     takes a new phone from a verification request into the approved slot;
--     that phone becomes a chain change request instead.
--   * landlord_verification_gate: any transition to verified snapshots the
--     approved number if the caller didn't; any transition away clears it.
--   * agent_landlord_payouts (legacy flow, dormant but still reachable from
--     AgentLandlordPayoutFlow.tsx) gets the same approved-number gate
--     landlord_payouts already has.
-- Acceptance tests: supabase/tests/landlord_number_lock_acceptance.sql
-- (written first; red on production before this migration).

-- ────────────────────────────────────────────────────────────── helpers
CREATE OR REPLACE FUNCTION public.landlord_number_norm(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT right(regexp_replace(COALESCE(p, ''), '\D', '', 'g'), 9)
$$;

CREATE OR REPLACE FUNCTION public._has_enabled_role(p_user uuid, p_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = p_user AND enabled AND role::text = ANY (p_roles))
$$;

-- ────────────────────────────────────────────────────────────── tables
CREATE TABLE IF NOT EXISTS public.landlord_number_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
  field text NOT NULL CHECK (field IN ('phone', 'mobile_money_number')),
  old_value text,
  new_value text NOT NULL,
  status text NOT NULL DEFAULT 'pending_service_centre' CHECK (status IN (
    'pending_service_centre', 'pending_tenant_ops', 'pending_agent_ops', 'pending_landlord_ops',
    'approved', 'rejected', 'expired', 'superseded', 'cancelled')),
  requested_by uuid,
  request_source text NOT NULL,
  request_note text,
  risk_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
  service_centre_reviewed_by uuid, service_centre_reviewed_at timestamptz,
  tenant_ops_reviewed_by uuid,     tenant_ops_reviewed_at timestamptz,
  agent_ops_reviewed_by uuid,      agent_ops_reviewed_at timestamptz,
  landlord_ops_reviewed_by uuid,   landlord_ops_reviewed_at timestamptz,
  decided_reason text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  closed_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.landlord_number_change_requests IS
  'Doc 120. A new phone/MoMo number for an already-verified landlord. Must pass service centre -> tenant ops -> agent ops -> landlord ops (4 distinct people, not the requester) within expires_at; only then is it written to landlords and, for the payout number, to verified_mobile_money_number. Write only via request_landlord_number_change / review_landlord_number_change.';

CREATE UNIQUE INDEX IF NOT EXISTS landlord_number_change_requests_one_open
  ON public.landlord_number_change_requests (landlord_id, field)
  WHERE status IN ('pending_service_centre', 'pending_tenant_ops', 'pending_agent_ops', 'pending_landlord_ops');
CREATE INDEX IF NOT EXISTS landlord_number_change_requests_status_idx
  ON public.landlord_number_change_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.landlord_number_audit (
  id bigserial PRIMARY KEY,
  landlord_id uuid NOT NULL,
  request_id uuid,
  field text,
  event text NOT NULL,
  from_status text,
  to_status text,
  old_value text,
  new_value text,
  actor uuid,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.landlord_number_audit IS
  'Doc 120. Append-only. One row per blocked direct edit, per change-request transition, and per applied number change. UPDATE/DELETE raise.';
CREATE INDEX IF NOT EXISTS landlord_number_audit_landlord_idx ON public.landlord_number_audit (landlord_id, created_at DESC);
CREATE INDEX IF NOT EXISTS landlord_number_audit_request_idx ON public.landlord_number_audit (request_id);

ALTER TABLE public.landlord_number_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landlord_number_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff and requester can view landlord number changes" ON public.landlord_number_change_requests;
CREATE POLICY "Staff and requester can view landlord number changes"
  ON public.landlord_number_change_requests FOR SELECT TO authenticated
  USING (requested_by = auth.uid()
         OR public.is_sensitive_field_editor(auth.uid())
         OR public.is_service_center_reviewer(auth.uid()));

DROP POLICY IF EXISTS "Staff can view landlord number audit" ON public.landlord_number_audit;
CREATE POLICY "Staff can view landlord number audit"
  ON public.landlord_number_audit FOR SELECT TO authenticated
  USING (public.is_sensitive_field_editor(auth.uid())
         OR public.is_service_center_reviewer(auth.uid()));
-- No INSERT/UPDATE/DELETE policies: every write goes through the
-- SECURITY DEFINER functions below.
REVOKE ALL ON public.landlord_number_change_requests FROM anon;
REVOKE ALL ON public.landlord_number_audit FROM anon;

-- ────────────────────────────────────────────────────────────── audit immutability
CREATE OR REPLACE FUNCTION public.landlord_number_audit_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'landlord_number_audit is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_landlord_number_audit_immutable ON public.landlord_number_audit;
CREATE TRIGGER trg_landlord_number_audit_immutable
  BEFORE UPDATE OR DELETE ON public.landlord_number_audit
  FOR EACH ROW EXECUTE FUNCTION public.landlord_number_audit_immutable();

-- ────────────────────────────────────────────────────────────── request row guard
-- Requests can only move forward along the chain, only from inside the
-- authorized RPCs, and the number/landlord/requester are frozen at creation.
CREATE OR REPLACE FUNCTION public.guard_landlord_number_change_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[];
  v_exits constant text[] := ARRAY['rejected', 'expired', 'superseded', 'cancelled'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Landlord number change requests cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(current_setting('landlord_numbers.change_authorized', true), '') <> 'true' THEN
    RAISE EXCEPTION 'Use review_landlord_number_change() to act on a landlord number change request'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.landlord_id IS DISTINCT FROM OLD.landlord_id OR NEW.field IS DISTINCT FROM OLD.field
     OR NEW.old_value IS DISTINCT FROM OLD.old_value OR NEW.new_value IS DISTINCT FROM OLD.new_value
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.request_source IS DISTINCT FROM OLD.request_source THEN
    RAISE EXCEPTION 'The number, landlord and requester of a change request are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status NOT LIKE 'pending_%' THEN
    RAISE EXCEPTION 'This change request is % and can no longer be changed', OLD.status USING ERRCODE = '42501';
  END IF;
  v_allowed := CASE OLD.status
    WHEN 'pending_service_centre' THEN ARRAY['pending_tenant_ops'] || v_exits
    WHEN 'pending_tenant_ops'     THEN ARRAY['pending_agent_ops'] || v_exits
    WHEN 'pending_agent_ops'      THEN ARRAY['pending_landlord_ops'] || v_exits
    WHEN 'pending_landlord_ops'   THEN ARRAY['approved'] || v_exits
  END;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (NEW.status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'Illegal change request transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_landlord_number_change_request ON public.landlord_number_change_requests;
CREATE TRIGGER trg_guard_landlord_number_change_request
  BEFORE UPDATE OR DELETE ON public.landlord_number_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_landlord_number_change_request();

-- Every transition writes an audit row — structurally, not by convention.
CREATE OR REPLACE FUNCTION public.audit_landlord_number_change_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_event text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := 'request_created';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    v_event := CASE NEW.status
      WHEN 'pending_tenant_ops'   THEN 'stage_service_centre_approved'
      WHEN 'pending_agent_ops'    THEN 'stage_tenant_ops_approved'
      WHEN 'pending_landlord_ops' THEN 'stage_agent_ops_approved'
      WHEN 'approved'             THEN 'stage_landlord_ops_approved'
      ELSE NEW.status END;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.landlord_number_audit
    (landlord_id, request_id, field, event, from_status, to_status, old_value, new_value, actor, comment)
  VALUES
    (NEW.landlord_id, NEW.id, NEW.field, v_event,
     CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
     NEW.old_value, NEW.new_value, auth.uid(),
     COALESCE(NULLIF(current_setting('landlord_numbers.comment', true), ''), NEW.request_note));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_audit_landlord_number_change_request ON public.landlord_number_change_requests;
CREATE TRIGGER trg_audit_landlord_number_change_request
  AFTER INSERT OR UPDATE OF status ON public.landlord_number_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.audit_landlord_number_change_request();

-- ────────────────────────────────────────────────────────────── request creation (internal)
CREATE OR REPLACE FUNCTION public._create_landlord_number_change_request(
  p_landlord_id uuid, p_field text, p_old text, p_new text,
  p_actor uuid, p_source text, p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_open public.landlord_number_change_requests;
  v_norm text := public.landlord_number_norm(p_new);
  v_flags text[] := ARRAY[]::text[];
  v_id uuid;
BEGIN
  SELECT * INTO v_open FROM public.landlord_number_change_requests
  WHERE landlord_id = p_landlord_id AND field = p_field AND status LIKE 'pending_%'
  FOR UPDATE;

  IF v_open.id IS NOT NULL AND public.landlord_number_norm(v_open.new_value) = v_norm THEN
    RETURN v_open.id;
  END IF;

  PERFORM set_config('landlord_numbers.change_authorized', 'true', true);
  IF v_open.id IS NOT NULL THEN
    PERFORM set_config('landlord_numbers.comment', 'Superseded by a newer number for the same field', true);
    UPDATE public.landlord_number_change_requests
       SET status = 'superseded', closed_at = now(), decided_reason = 'Superseded by a newer request'
     WHERE id = v_open.id;
  END IF;

  IF p_actor IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles
      WHERE id = p_actor AND public.landlord_number_norm(phone) = v_norm) THEN
    v_flags := v_flags || 'matches_requester_phone'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p JOIN public.user_roles ur ON ur.user_id = p.id
      WHERE ur.role IN ('agent', 'sub_agent', 'senior_agent') AND public.landlord_number_norm(p.phone) = v_norm) THEN
    v_flags := v_flags || 'matches_an_agent_phone'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.landlords
      WHERE id <> p_landlord_id
        AND (public.landlord_number_norm(phone) = v_norm OR public.landlord_number_norm(mobile_money_number) = v_norm)) THEN
    v_flags := v_flags || 'used_by_other_landlord'::text;
  END IF;

  PERFORM set_config('landlord_numbers.comment', '', true);
  INSERT INTO public.landlord_number_change_requests
    (landlord_id, field, old_value, new_value, requested_by, request_source, request_note, risk_flags)
  VALUES (p_landlord_id, p_field, p_old, btrim(p_new), p_actor, p_source, p_note, v_flags)
  RETURNING id INTO v_id;
  PERFORM set_config('landlord_numbers.change_authorized', 'false', true);
  RETURN v_id;
END;
$$;

-- ────────────────────────────────────────────────────────────── THE LOCK
CREATE OR REPLACE FUNCTION public.lock_verified_landlord_numbers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_field text;
  v_old text;
  v_new text;
  v_req uuid;
BEGIN
  -- Only the final Landlord Ops approval in review_landlord_number_change()
  -- sets this flag.
  IF COALESCE(current_setting('landlord_numbers.change_authorized', true), '') = 'true' THEN
    RETURN NEW;
  END IF;
  -- Before verification the number isn't approved yet; verification itself
  -- is the chain that approves it.
  IF NOT (COALESCE(OLD.verified, false) OR OLD.verified_mobile_money_number IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  FOREACH v_field IN ARRAY ARRAY['phone', 'mobile_money_number'] LOOP
    IF v_field = 'phone' THEN
      v_old := OLD.phone; v_new := NEW.phone;
      NEW.phone := OLD.phone;
    ELSE
      v_old := OLD.mobile_money_number; v_new := NEW.mobile_money_number;
      NEW.mobile_money_number := OLD.mobile_money_number;
    END IF;

    CONTINUE WHEN v_new IS NOT DISTINCT FROM v_old;
    -- formatting-only difference (0772… vs +256772…): keep the stored value
    CONTINUE WHEN public.landlord_number_norm(v_new) = public.landlord_number_norm(v_old)
                  AND public.landlord_number_norm(v_new) <> '';

    v_req := NULL;
    IF length(regexp_replace(COALESCE(v_new, ''), '\D', '', 'g')) BETWEEN 9 AND 15 THEN
      v_req := public._create_landlord_number_change_request(
        OLD.id, v_field, v_old, v_new, v_actor, 'direct_edit_blocked', NULL);
    END IF;

    INSERT INTO public.landlord_number_audit
      (landlord_id, request_id, field, event, old_value, new_value, actor, comment)
    VALUES (OLD.id, v_req, v_field, 'direct_edit_blocked', v_old, v_new, v_actor,
      CASE WHEN v_req IS NULL
        THEN 'Blocked: verified landlord number cannot be cleared or set to an invalid value'
        ELSE 'Blocked: verified landlord number is locked; change request created at service centre stage' END);
  END LOOP;

  RETURN NEW;
END;
$$;

-- Name sorts right after trg_aa_landlord_verification_gate and before
-- trg_guard_landlord_agreement_backed_changes, so that guard sees the
-- reverted value and does not log a phantom "change applied".
DROP TRIGGER IF EXISTS trg_ab_lock_verified_landlord_numbers ON public.landlords;
CREATE TRIGGER trg_ab_lock_verified_landlord_numbers
  BEFORE UPDATE OF phone, mobile_money_number ON public.landlords
  FOR EACH ROW EXECUTE FUNCTION public.lock_verified_landlord_numbers();

-- ────────────────────────────────────────────────────────────── public RPCs
CREATE OR REPLACE FUNCTION public.request_landlord_number_change(
  p_landlord_id uuid, p_field text, p_new_value text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_actor uuid := auth.uid();
  l public.landlords;
  v_current text;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_field NOT IN ('phone', 'mobile_money_number') THEN RAISE EXCEPTION 'Invalid field %', p_field; END IF;
  IF length(regexp_replace(COALESCE(p_new_value, ''), '\D', '', 'g')) NOT BETWEEN 9 AND 15 THEN
    RAISE EXCEPTION 'Enter a valid phone number';
  END IF;

  SELECT * INTO l FROM public.landlords WHERE id = p_landlord_id;
  IF l.id IS NULL THEN RAISE EXCEPTION 'Landlord not found'; END IF;
  -- COALESCE each comparison: a NULL column must not turn the whole check NULL
  -- (NOT NULL is NULL, and IF NULL silently skips the RAISE).
  IF NOT (COALESCE(l.registered_by = v_actor, false)
          OR COALESCE(l.managed_by_agent_id = v_actor, false)
          OR COALESCE(l.tenant_id = v_actor, false)
          OR COALESCE(public.is_sensitive_field_editor(v_actor), false)
          OR COALESCE(public.is_service_center_reviewer(v_actor), false)) THEN
    RAISE EXCEPTION 'Not authorized to request a change for this landlord' USING ERRCODE = '42501';
  END IF;
  IF NOT (COALESCE(l.verified, false) OR l.verified_mobile_money_number IS NOT NULL) THEN
    RAISE EXCEPTION 'This landlord is not verified yet — correct the number directly; it will be checked during verification.';
  END IF;

  v_current := CASE p_field WHEN 'phone' THEN l.phone ELSE l.mobile_money_number END;
  IF public.landlord_number_norm(v_current) = public.landlord_number_norm(p_new_value) THEN
    RAISE EXCEPTION 'That is already the number on file';
  END IF;

  v_id := public._create_landlord_number_change_request(
    p_landlord_id, p_field, v_current, p_new_value, v_actor, 'rpc', NULLIF(btrim(p_note), ''));
  RETURN jsonb_build_object('ok', true, 'request_id', v_id,
    'status', (SELECT status FROM public.landlord_number_change_requests WHERE id = v_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.review_landlord_number_change(
  p_request_id uuid, p_decision text, p_comment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_actor uuid := auth.uid();
  q public.landlord_number_change_requests;
  l public.landlords;
  v_comment text := btrim(COALESCE(p_comment, ''));
  v_can boolean;
  v_next text;
  v_is_payout boolean;
  v_prev_value text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'Decision must be approve or reject'; END IF;
  IF length(v_comment) < 10 THEN
    RAISE EXCEPTION 'Record what you confirmed (at least 10 characters), e.g. who you called and what they said';
  END IF;

  SELECT * INTO q FROM public.landlord_number_change_requests WHERE id = p_request_id FOR UPDATE;
  IF q.id IS NULL THEN RAISE EXCEPTION 'Change request not found'; END IF;
  IF q.status NOT LIKE 'pending_%' THEN
    RAISE EXCEPTION 'This change request is % and cannot be used', q.status USING ERRCODE = '42501';
  END IF;

  -- An expired approval cannot be used. Mark it (committed — we return, not
  -- raise) so the number has to re-enter the chain from the start.
  IF q.expires_at <= now() THEN
    PERFORM set_config('landlord_numbers.change_authorized', 'true', true);
    PERFORM set_config('landlord_numbers.comment', 'Expired before the chain completed', true);
    UPDATE public.landlord_number_change_requests
       SET status = 'expired', closed_at = now(), decided_reason = 'Expired before the chain completed'
     WHERE id = q.id;
    PERFORM set_config('landlord_numbers.change_authorized', 'false', true);
    RETURN jsonb_build_object('ok', false, 'status', 'expired', 'request_id', q.id,
      'error', 'This change request expired. Submit the number again to restart the chain.');
  END IF;

  -- Segregation of duties.
  IF v_actor = q.requested_by THEN
    RAISE EXCEPTION 'You cannot review a number change you requested' USING ERRCODE = '42501';
  END IF;
  IF v_actor IN (q.service_centre_reviewed_by, q.tenant_ops_reviewed_by, q.agent_ops_reviewed_by) THEN
    RAISE EXCEPTION 'You already approved an earlier stage of this change; a different person must review this stage'
      USING ERRCODE = '42501';
  END IF;

  v_can := CASE q.status
    WHEN 'pending_service_centre' THEN public.is_service_center_reviewer(v_actor)
      OR (q.requested_by IS NOT NULL AND v_actor = public.resolve_service_center_manager_for_agent(q.requested_by))
    WHEN 'pending_tenant_ops'   THEN public._has_enabled_role(v_actor, ARRAY['tenant_ops', 'coo', 'super_admin'])
    WHEN 'pending_agent_ops'    THEN public._has_enabled_role(v_actor, ARRAY['agent_ops', 'coo', 'super_admin'])
    WHEN 'pending_landlord_ops' THEN public._has_enabled_role(v_actor, ARRAY['landlord_ops', 'coo', 'super_admin'])
  END;
  IF NOT COALESCE(v_can, false) THEN
    RAISE EXCEPTION 'Your role cannot review the % stage', replace(replace(q.status, 'pending_', ''), '_', ' ')
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('landlord_numbers.change_authorized', 'true', true);
  PERFORM set_config('landlord_numbers.comment', v_comment, true);

  IF p_decision = 'reject' THEN
    UPDATE public.landlord_number_change_requests SET
      status = 'rejected', closed_at = now(), decided_reason = v_comment,
      service_centre_reviewed_by = CASE WHEN q.status = 'pending_service_centre' THEN v_actor ELSE service_centre_reviewed_by END,
      service_centre_reviewed_at = CASE WHEN q.status = 'pending_service_centre' THEN now() ELSE service_centre_reviewed_at END,
      tenant_ops_reviewed_by = CASE WHEN q.status = 'pending_tenant_ops' THEN v_actor ELSE tenant_ops_reviewed_by END,
      tenant_ops_reviewed_at = CASE WHEN q.status = 'pending_tenant_ops' THEN now() ELSE tenant_ops_reviewed_at END,
      agent_ops_reviewed_by = CASE WHEN q.status = 'pending_agent_ops' THEN v_actor ELSE agent_ops_reviewed_by END,
      agent_ops_reviewed_at = CASE WHEN q.status = 'pending_agent_ops' THEN now() ELSE agent_ops_reviewed_at END,
      landlord_ops_reviewed_by = CASE WHEN q.status = 'pending_landlord_ops' THEN v_actor ELSE landlord_ops_reviewed_by END,
      landlord_ops_reviewed_at = CASE WHEN q.status = 'pending_landlord_ops' THEN now() ELSE landlord_ops_reviewed_at END
    WHERE id = q.id;
    PERFORM set_config('landlord_numbers.change_authorized', 'false', true);
    RETURN jsonb_build_object('ok', true, 'status', 'rejected', 'request_id', q.id);
  END IF;

  v_next := CASE q.status
    WHEN 'pending_service_centre' THEN 'pending_tenant_ops'
    WHEN 'pending_tenant_ops'     THEN 'pending_agent_ops'
    WHEN 'pending_agent_ops'      THEN 'pending_landlord_ops'
    WHEN 'pending_landlord_ops'   THEN 'approved'
  END;

  UPDATE public.landlord_number_change_requests SET
    status = v_next,
    closed_at = CASE WHEN v_next = 'approved' THEN now() END,
    applied_at = CASE WHEN v_next = 'approved' THEN now() END,
    service_centre_reviewed_by = CASE WHEN q.status = 'pending_service_centre' THEN v_actor ELSE service_centre_reviewed_by END,
    service_centre_reviewed_at = CASE WHEN q.status = 'pending_service_centre' THEN now() ELSE service_centre_reviewed_at END,
    tenant_ops_reviewed_by = CASE WHEN q.status = 'pending_tenant_ops' THEN v_actor ELSE tenant_ops_reviewed_by END,
    tenant_ops_reviewed_at = CASE WHEN q.status = 'pending_tenant_ops' THEN now() ELSE tenant_ops_reviewed_at END,
    agent_ops_reviewed_by = CASE WHEN q.status = 'pending_agent_ops' THEN v_actor ELSE agent_ops_reviewed_by END,
    agent_ops_reviewed_at = CASE WHEN q.status = 'pending_agent_ops' THEN now() ELSE agent_ops_reviewed_at END,
    landlord_ops_reviewed_by = CASE WHEN q.status = 'pending_landlord_ops' THEN v_actor ELSE landlord_ops_reviewed_by END,
    landlord_ops_reviewed_at = CASE WHEN q.status = 'pending_landlord_ops' THEN now() ELSE landlord_ops_reviewed_at END
  WHERE id = q.id;

  IF v_next = 'approved' THEN
    SELECT * INTO l FROM public.landlords WHERE id = q.landlord_id FOR UPDATE;
    v_prev_value := CASE q.field WHEN 'phone' THEN l.phone ELSE l.mobile_money_number END;
    -- The payout number is mobile_money_number, falling back to phone when
    -- no MoMo number is on file (issue-landlord-payout-otp's resolution).
    v_is_payout := q.field = 'mobile_money_number'
                   OR (q.field = 'phone' AND NULLIF(btrim(COALESCE(l.mobile_money_number, '')), '') IS NULL);
    v_is_payout := v_is_payout AND l.verification_status = 'verified';

    IF v_is_payout THEN
      PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
    END IF;
    UPDATE public.landlords SET
      phone = CASE WHEN q.field = 'phone' THEN q.new_value ELSE phone END,
      mobile_money_number = CASE WHEN q.field = 'mobile_money_number' THEN q.new_value ELSE mobile_money_number END,
      verified_mobile_money_number = CASE WHEN v_is_payout THEN q.new_value ELSE verified_mobile_money_number END,
      verified_mobile_money_set_at = CASE WHEN v_is_payout THEN now() ELSE verified_mobile_money_set_at END,
      verified_mobile_money_source = CASE WHEN v_is_payout THEN 'number_change_request' ELSE verified_mobile_money_source END
    WHERE id = q.landlord_id;
    PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

    INSERT INTO public.landlord_number_audit
      (landlord_id, request_id, field, event, from_status, to_status, old_value, new_value, actor, comment)
    VALUES (q.landlord_id, q.id, q.field, 'applied', 'pending_landlord_ops', 'approved',
      v_prev_value, q.new_value, v_actor,
      CASE WHEN v_is_payout THEN 'Applied; approved payout number moved to the new number'
           ELSE 'Applied; approved payout number unchanged' END);
  END IF;

  PERFORM set_config('landlord_numbers.change_authorized', 'false', true);
  PERFORM set_config('landlord_numbers.comment', '', true);
  RETURN jsonb_build_object('ok', true, 'status', v_next, 'request_id', q.id,
    'applied', v_next = 'approved');
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_landlord_number_change_requests()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_n integer;
BEGIN
  PERFORM set_config('landlord_numbers.change_authorized', 'true', true);
  PERFORM set_config('landlord_numbers.comment', 'Expired before the chain completed', true);
  UPDATE public.landlord_number_change_requests
     SET status = 'expired', closed_at = now(), decided_reason = 'Expired before the chain completed'
   WHERE status LIKE 'pending_%' AND expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('landlord_numbers.change_authorized', 'false', true);
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public._create_landlord_number_change_request(uuid, text, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_landlord_number_change_requests() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._has_enabled_role(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_landlord_number_change(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_landlord_number_change(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_landlord_number_change(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_landlord_number_change(uuid, text, text) TO authenticated;

-- ────────────────────────────────────────────────────────────── verification gate
-- Unchanged from 20260922150000 except: every transition TO verified snapshots
-- the approved number when the caller didn't (pipeline auto-verify,
-- service_mark_landlord_verified), and every transition AWAY clears it.
CREATE OR REPLACE FUNCTION public.landlord_verification_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.verification_status := COALESCE(NULLIF(btrim(NEW.verification_status), ''), 'pending');
    IF NEW.verified IS TRUE AND NEW.verification_status = 'pending' THEN
      NEW.verification_status := 'verified';
    END IF;
    NEW.verified := (NEW.verification_status = 'verified');
    NEW.verification_source := COALESCE(NEW.verification_source, 'registration');
    NEW.verification_updated_at := COALESCE(NEW.verification_updated_at, now());
    RETURN NEW;
  END IF;

  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.verified IS DISTINCT FROM OLD.verified
     OR NEW.verification_reason IS DISTINCT FROM OLD.verification_reason
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verification_source IS DISTINCT FROM OLD.verification_source
     OR NEW.verified_mobile_money_number IS DISTINCT FROM OLD.verified_mobile_money_number
     OR NEW.verified_mobile_money_set_at IS DISTINCT FROM OLD.verified_mobile_money_set_at
     OR NEW.verified_mobile_money_source IS DISTINCT FROM OLD.verified_mobile_money_source THEN

    IF COALESCE(current_setting('landlord_verification.sync_authorized', true), '') <> 'true' THEN
      RAISE EXCEPTION 'Landlord verification is locked. Use set_landlord_verification() (landlord %)', OLD.id
        USING ERRCODE = '42501';
    END IF;

    NEW.verification_status := COALESCE(NULLIF(btrim(NEW.verification_status), ''), 'pending');
    NEW.verified := (NEW.verification_status = 'verified');
    NEW.verification_updated_at := now();

    IF NEW.verification_status <> 'verified' THEN
      NEW.verified_mobile_money_number := NULL;
      NEW.verified_mobile_money_set_at := NULL;
      NEW.verified_mobile_money_source := NULL;
    ELSIF COALESCE(OLD.verification_status, '') <> 'verified'
          AND NULLIF(btrim(COALESCE(NEW.verified_mobile_money_number, '')), '') IS NULL THEN
      NEW.verified_mobile_money_number := COALESCE(NULLIF(btrim(NEW.mobile_money_number), ''), NULLIF(btrim(NEW.phone), ''));
      NEW.verified_mobile_money_set_at := now();
      NEW.verified_mobile_money_source := 'auto_on_verify:' || COALESCE(NEW.verification_source, 'unknown');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ────────────────────────────────────────────────────────────── set_landlord_verification
-- Unchanged from the live body except the approved-number snapshot: on a
-- landlord that ALREADY has an approved number, a pending verification
-- request carrying a different phone no longer overwrites the approved
-- number on one click — it becomes a four-stage change request instead.
CREATE OR REPLACE FUNCTION public.set_landlord_verification(p_landlord_id uuid, p_status text, p_reason text, p_source text DEFAULT 'ops_manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_name text;
  v_registered_by uuid;
  v_reason text := btrim(p_reason);
  v_title text;
  v_message text;
  v_type text;
  v_charge_amount integer := 2000;
  v_agent_charged boolean := false;
  v_request_phone text;
  v_request_by uuid;
  v_locked_approved text;
  v_current_payout text;
  v_change_request uuid;
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_status NOT IN ('pending','verified','rejected','resubmitted') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  IF p_status = 'verified' THEN
    SELECT lvr.landlord_phone, lvr.requested_by INTO v_request_phone, v_request_by
    FROM public.landlord_verification_requests lvr
    WHERE lvr.landlord_id = p_landlord_id AND lvr.status = 'pending'
    ORDER BY lvr.created_at DESC
    LIMIT 1;

    SELECT NULLIF(btrim(verified_mobile_money_number), ''),
           COALESCE(NULLIF(btrim(mobile_money_number), ''), NULLIF(btrim(phone), ''))
      INTO v_locked_approved, v_current_payout
    FROM public.landlords WHERE id = p_landlord_id;

    -- Already approved: keep the approved number. A different phone on the
    -- request re-enters the full chain instead of replacing it here.
    IF v_locked_approved IS NOT NULL THEN
      IF NULLIF(btrim(v_request_phone), '') IS NOT NULL
         AND public.landlord_number_norm(v_request_phone) <> public.landlord_number_norm(v_locked_approved)
         AND public.landlord_number_norm(v_request_phone) <> public.landlord_number_norm(v_current_payout) THEN
        v_change_request := public._create_landlord_number_change_request(
          p_landlord_id,
          CASE WHEN NULLIF(btrim(COALESCE((SELECT mobile_money_number FROM public.landlords WHERE id = p_landlord_id), '')), '') IS NULL
               THEN 'phone' ELSE 'mobile_money_number' END,
          v_current_payout, v_request_phone, v_request_by, 'verification_request',
          'From landlord_verification_requests; approved by ' || COALESCE(v_actor::text, 'unknown') || ': ' || v_reason);
      END IF;
      v_request_phone := NULL;  -- never snapshot it directly
    END IF;
  END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
  UPDATE public.landlords
  SET verification_status = p_status,
      verification_reason = v_reason,
      verification_source = COALESCE(NULLIF(btrim(p_source), ''), 'ops_manual'),
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END,
      verified_mobile_money_number = CASE
        WHEN p_status = 'verified'
          THEN COALESCE(v_locked_approved, NULLIF(btrim(v_request_phone), ''), mobile_money_number, phone)
        ELSE NULL
      END,
      verified_mobile_money_set_at = CASE
        WHEN p_status = 'verified' AND v_locked_approved IS NOT NULL THEN verified_mobile_money_set_at
        WHEN p_status = 'verified' THEN now() ELSE NULL END,
      verified_mobile_money_source = CASE
        WHEN p_status = 'verified' AND v_locked_approved IS NOT NULL THEN verified_mobile_money_source
        WHEN p_status = 'verified'
          THEN CASE WHEN v_request_phone IS NOT NULL THEN 'verification_request' ELSE 'ops_ad_hoc' END
        ELSE NULL
      END
  WHERE id = p_landlord_id
  RETURNING name, registered_by INTO v_name, v_registered_by;
  IF NOT FOUND THEN RAISE EXCEPTION 'Landlord not found'; END IF;
  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

  UPDATE public.landlord_verification_requests
  SET status = CASE WHEN p_status IN ('verified','rejected') THEN p_status ELSE 'pending' END,
      reject_comment = CASE WHEN p_status = 'rejected' THEN v_reason ELSE reject_comment END,
      resolved_by = v_actor,
      resolved_at = now()
  WHERE landlord_id = p_landlord_id AND status = 'pending';

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'landlord_verification_status_set', 'landlords', p_landlord_id,
    jsonb_build_object('status', p_status, 'reason', v_reason, 'source', p_source,
      'agreement_required', false, 'number_change_request_id', v_change_request));

  IF p_status = 'verified' THEN
    v_type := 'success'; v_title := 'Landlord verified';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' has been verified.';
  ELSIF p_status = 'rejected' THEN
    v_type := 'error'; v_title := 'Landlord verification rejected';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification was rejected. Reason: ' || v_reason;
  ELSE
    v_type := 'info'; v_title := 'Landlord verification pending';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification is under review. ' || v_reason;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT p.id, v_title, v_message, v_type,
    jsonb_build_object('kind', 'landlord_verification', 'landlord_id', p_landlord_id, 'status', p_status, 'reason', v_reason)
  FROM public.profiles p
  WHERE p.borrower_landlord_id = p_landlord_id;

  IF p_status = 'rejected' AND v_registered_by IS NOT NULL THEN
    BEGIN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_registered_by, 'amount', v_charge_amount, 'direction', 'cash_out',
            'category', 'listing_rejection_penalty', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable',
            'source_table', 'landlords', 'source_id', p_landlord_id::text,
            'description', 'Landlord rejection charge — ' || COALESCE(v_name, 'landlord'), 'currency', 'UGX'),
          jsonb_build_object('amount', v_charge_amount, 'direction', 'cash_in',
            'category', 'listing_rejection_recovery', 'ledger_scope', 'platform',
            'source_table', 'landlords', 'source_id', p_landlord_id::text,
            'description', 'Recovery: landlord rejection charge — ' || COALESCE(v_name, 'landlord'), 'currency', 'UGX')
        ),
        'landlord_rejection_charge:' || p_landlord_id::text, true);
      v_agent_charged := true;
    EXCEPTION WHEN OTHERS THEN v_agent_charged := false;
    END;
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_registered_by, 'Landlord Rejected',
      'The landlord "' || COALESCE(v_name, 'landlord') || '" you registered was rejected. Reason: ' || v_reason,
      'warning', jsonb_build_object('kind', 'landlord_rejection_penalty', 'landlord_id', p_landlord_id,
        'reason', v_reason, 'charge', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END));
  END IF;

  RETURN jsonb_build_object('ok', true, 'landlord_id', p_landlord_id, 'status', p_status,
    'source', COALESCE(NULLIF(btrim(p_source), ''), 'ops_manual'), 'agent_id', v_registered_by,
    'agent_charged', v_agent_charged, 'charge_amount', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END,
    'number_change_request_id', v_change_request);
END;
$function$;

-- ────────────────────────────────────────────────────────────── legacy payout table
CREATE OR REPLACE FUNCTION public.enforce_agent_landlord_payout_approved_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_approved text;
BEGIN
  SELECT verified_mobile_money_number INTO v_approved FROM public.landlords WHERE id = NEW.landlord_id;
  IF NULLIF(btrim(COALESCE(v_approved, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Landlord Ops has not approved a payout number for this landlord.' USING ERRCODE = 'check_violation';
  END IF;
  IF public.landlord_number_norm(NEW.landlord_phone) <> public.landlord_number_norm(v_approved) THEN
    RAISE EXCEPTION 'Payout phone does not match the number Landlord Ops approved for this landlord.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_enforce_agent_landlord_payout_approved_number ON public.agent_landlord_payouts;
CREATE TRIGGER trg_enforce_agent_landlord_payout_approved_number
  BEFORE INSERT OR UPDATE OF landlord_phone, landlord_id ON public.agent_landlord_payouts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_landlord_payout_approved_number();

-- ────────────────────────────────────────────────────────────── expiry sweep
SELECT cron.schedule('expire-landlord-number-change-requests', '17 * * * *',
  $$SELECT public.expire_landlord_number_change_requests();$$);

-- ────────────────────────────────────────────────────────────── drift baselines
-- (project_critical_function_drift_detection): a silent revert of the lock
-- reopens the fraud path, so watch it. Re-baseline in the SAME migration
-- whenever one of these bodies is deliberately changed.
INSERT INTO public.critical_function_baselines (function_signature, expected_sha256, note, baselined_at, baselined_by)
SELECT sig,
       encode(sha256(convert_to(pg_get_functiondef(sig::regprocedure), 'UTF8')), 'hex'),
       note, now(), '20260924090000_landlord_number_lock_and_change_chain.sql'
FROM (VALUES
  ('lock_verified_landlord_numbers()', 'Doc 120: blocks any change to phone/mobile_money_number on a verified landlord and turns it into a chain change request. Revert = agents can swap payout numbers again.'),
  ('review_landlord_number_change(uuid,text,text)', 'Doc 120: the only path that applies a new landlord number (4-stage chain, segregation, expiry).'),
  ('guard_landlord_number_change_request()', 'Doc 120: change requests move forward only, from authorized RPCs only.'),
  ('landlord_verification_gate()', 'Doc 112/120: locks verification + approved payout number columns to set_landlord_verification().'),
  ('set_landlord_verification(uuid,text,text,text)', 'Doc 112/120: snapshots the approved payout number; must not overwrite an existing approved number from a verification request.')
) AS v(sig, note)
ON CONFLICT (function_signature) DO UPDATE
  SET expected_sha256 = EXCLUDED.expected_sha256,
      baselined_at = now(),
      baselined_by = EXCLUDED.baselined_by,
      note = EXCLUDED.note;
