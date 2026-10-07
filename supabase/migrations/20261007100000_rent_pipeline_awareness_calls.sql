-- Rent pipeline "awareness call" feedback. Additive only: one new append-only table and two new functions.
-- Nothing in the rent pipeline is touched: no status, approve/reject function, trigger, policy or existing table is changed
-- and no money moves. Staff phone the tenant, landlord or agent on a Rent Plan, then record what they heard.
--
--   public.rent_pipeline_awareness_calls          the log (insert only, through record_awareness_call)
--   public.record_awareness_call(...)              the only write path; SECURITY DEFINER; also emits a system_events row
--   public.get_awareness_calls_for_request(uuid)   every call on one Rent Plan, with the caller's name and team
--
-- Answer choices are the SAME as the 30M awareness record already in use (tops_30m_awareness, and awareness30m in
-- src/lib/callingCenterWeeklyForwardingPdf.ts): awareness before = knew | heard | did_not_know ("Heard but unsure" on screen),
-- explanation given = yes | partly | no. They are asked of an answered call only; an unanswered call stores nulls.
--
-- Who may record or read: staff with an enabled role of tenant_ops, landlord_ops, agent_ops, operations, manager, super_admin,
-- coo, ceo, cto or cfo (any Rent Plan), plus the Rent Plan's own service centre manager (rent_requests.service_center_manager_id,
-- only for that plan). There is no service-centre role in app_role: a service centre is the manager the plan was routed to.
-- caller_team is worked out from the caller, never supplied: the plan's service centre manager = service_centre; otherwise
-- agent_ops, then tenant_ops, then landlord_ops by role; any other pipeline role = other.
-- pipeline_stage is the Rent Plan's status read at the moment of the call.

CREATE TABLE IF NOT EXISTS public.rent_pipeline_awareness_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests (id),
  subject_type text NOT NULL
    CONSTRAINT rent_pipeline_awareness_calls_subject_type_check CHECK (subject_type IN ('tenant', 'landlord', 'agent')),
  subject_user_id uuid,
  subject_phone text NOT NULL
    CONSTRAINT rent_pipeline_awareness_calls_phone_check CHECK (length(btrim(subject_phone)) >= 7),
  caller_id uuid NOT NULL,
  caller_team text NOT NULL
    CONSTRAINT rent_pipeline_awareness_calls_team_check
    CHECK (caller_team IN ('service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'other')),
  pipeline_stage text NOT NULL,
  dial_started_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  call_result text NOT NULL
    CONSTRAINT rent_pipeline_awareness_calls_result_check
    CHECK (call_result IN ('answered', 'no_answer', 'phone_off', 'wrong_number')),
  aware_30m text
    CONSTRAINT rent_pipeline_awareness_calls_aware_30m_check CHECK (aware_30m IN ('knew', 'heard', 'did_not_know')),
  aware_merchant_codes text
    CONSTRAINT rent_pipeline_awareness_calls_aware_codes_check CHECK (aware_merchant_codes IN ('knew', 'heard', 'did_not_know')),
  explained text
    CONSTRAINT rent_pipeline_awareness_calls_explained_check CHECK (explained IN ('yes', 'partly', 'no')),
  note text
    CONSTRAINT rent_pipeline_awareness_calls_note_check CHECK (note IS NULL OR length(note) <= 2000),
  -- The three answers belong to an answered call and only to one.
  CONSTRAINT rent_pipeline_awareness_calls_answers_check CHECK (
    (call_result = 'answered' AND aware_30m IS NOT NULL AND aware_merchant_codes IS NOT NULL AND explained IS NOT NULL)
    OR (call_result <> 'answered' AND aware_30m IS NULL AND aware_merchant_codes IS NULL AND explained IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS rent_pipeline_awareness_calls_request_idx ON public.rent_pipeline_awareness_calls (rent_request_id);
CREATE INDEX IF NOT EXISTS rent_pipeline_awareness_calls_caller_idx ON public.rent_pipeline_awareness_calls (caller_id);
CREATE INDEX IF NOT EXISTS rent_pipeline_awareness_calls_recorded_idx ON public.rent_pipeline_awareness_calls (recorded_at);

-- A double tap or a retry of the same call must not log it twice.
CREATE UNIQUE INDEX IF NOT EXISTS rent_pipeline_awareness_calls_once_idx
  ON public.rent_pipeline_awareness_calls (caller_id, rent_request_id, subject_phone, dial_started_at);

-- Append-only, even for the table owner and service_role: no row can be changed or removed.
CREATE OR REPLACE FUNCTION public.rent_pipeline_awareness_calls_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'rent_pipeline_awareness_calls is append-only: % is not allowed', TG_OP;
END;
$function$;

DROP TRIGGER IF EXISTS rent_pipeline_awareness_calls_no_change ON public.rent_pipeline_awareness_calls;
CREATE TRIGGER rent_pipeline_awareness_calls_no_change
  BEFORE UPDATE OR DELETE ON public.rent_pipeline_awareness_calls
  FOR EACH ROW EXECUTE FUNCTION public.rent_pipeline_awareness_calls_append_only();

REVOKE ALL ON FUNCTION public.rent_pipeline_awareness_calls_append_only() FROM PUBLIC, anon;

-- This schema's default privileges auto-grant new tables (all privileges, to anon and authenticated); strip them all and
-- grant back only what an append-only log needs. Staff read through RLS; writes go only through record_awareness_call.
REVOKE ALL ON TABLE public.rent_pipeline_awareness_calls FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.rent_pipeline_awareness_calls TO authenticated;
GRANT SELECT, INSERT ON TABLE public.rent_pipeline_awareness_calls TO service_role;

ALTER TABLE public.rent_pipeline_awareness_calls ENABLE ROW LEVEL SECURITY;

-- Pipeline staff may read every call. (A service centre manager reads their own plans' calls through
-- get_awareness_calls_for_request.) There is deliberately no INSERT, UPDATE or DELETE policy.
DROP POLICY IF EXISTS rent_pipeline_awareness_calls_select ON public.rent_pipeline_awareness_calls;
CREATE POLICY rent_pipeline_awareness_calls_select ON public.rent_pipeline_awareness_calls
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'landlord_ops') OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'cfo')
  );

-- ─── record_awareness_call ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_awareness_call(
  p_rent_request_id uuid,
  p_subject_type text,
  p_subject_phone text,
  p_dial_started_at timestamptz,
  p_call_result text,
  p_subject_user_id uuid DEFAULT NULL,
  p_aware_30m text DEFAULT NULL,
  p_aware_merchant_codes text DEFAULT NULL,
  p_explained text DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_req record;
  v_staff boolean;
  v_is_sc boolean;
  v_team text;
  v_phone text := btrim(COALESCE(p_subject_phone, ''));
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_row public.rent_pipeline_awareness_calls%ROWTYPE;
  v_existing public.rent_pipeline_awareness_calls%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_rent_request_id IS NULL THEN RAISE EXCEPTION 'p_rent_request_id is required'; END IF;

  SELECT rr.id, rr.status, rr.tenant_id, rr.landlord_id, rr.agent_id, rr.service_center_manager_id
    INTO v_req
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;
  IF v_req.id IS NULL THEN RAISE EXCEPTION 'Rent Plan not found'; END IF;

  v_staff := public.has_role(v_actor, 'tenant_ops') OR public.has_role(v_actor, 'landlord_ops') OR public.has_role(v_actor, 'agent_ops')
          OR public.has_role(v_actor, 'operations') OR public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
          OR public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'cto')
          OR public.has_role(v_actor, 'cfo');
  v_is_sc := v_req.service_center_manager_id IS NOT NULL AND v_req.service_center_manager_id = v_actor;
  IF NOT (v_staff OR v_is_sc) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_team := CASE
    WHEN v_is_sc THEN 'service_centre'
    WHEN public.has_role(v_actor, 'agent_ops') THEN 'agent_ops'
    WHEN public.has_role(v_actor, 'tenant_ops') THEN 'tenant_ops'
    WHEN public.has_role(v_actor, 'landlord_ops') THEN 'landlord_ops'
    ELSE 'other'
  END;

  IF p_subject_type IS NULL OR p_subject_type NOT IN ('tenant', 'landlord', 'agent') THEN
    RAISE EXCEPTION 'invalid subject type: %, expected tenant/landlord/agent', p_subject_type;
  END IF;
  IF length(v_phone) < 7 THEN RAISE EXCEPTION 'the phone number that was called is required'; END IF;
  IF p_dial_started_at IS NULL THEN RAISE EXCEPTION 'p_dial_started_at is required'; END IF;
  IF p_dial_started_at > now() + interval '5 minutes' THEN RAISE EXCEPTION 'the call cannot start in the future'; END IF;
  IF p_dial_started_at < now() - interval '7 days' THEN RAISE EXCEPTION 'a call can be recorded up to 7 days after it was dialled'; END IF;

  IF p_call_result IS NULL OR p_call_result NOT IN ('answered', 'no_answer', 'phone_off', 'wrong_number') THEN
    RAISE EXCEPTION 'invalid call result: %, expected answered/no_answer/phone_off/wrong_number', p_call_result;
  END IF;
  IF p_call_result = 'answered' THEN
    IF p_aware_30m IS NULL OR p_aware_merchant_codes IS NULL OR p_explained IS NULL THEN
      RAISE EXCEPTION 'an answered call needs all three answers: aware_30m, aware_merchant_codes and explained';
    END IF;
    IF p_aware_30m NOT IN ('knew', 'heard', 'did_not_know') OR p_aware_merchant_codes NOT IN ('knew', 'heard', 'did_not_know') THEN
      RAISE EXCEPTION 'awareness answers must be knew, heard or did_not_know';
    END IF;
    IF p_explained NOT IN ('yes', 'partly', 'no') THEN
      RAISE EXCEPTION 'explained must be yes, partly or no';
    END IF;
  ELSIF p_aware_30m IS NOT NULL OR p_aware_merchant_codes IS NOT NULL OR p_explained IS NOT NULL THEN
    RAISE EXCEPTION 'answers can only be recorded for an answered call';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'note must be 2000 characters or fewer'; END IF;

  -- If the person is named, they must be the one on this Rent Plan (the plan's agent or its service centre manager for 'agent').
  IF p_subject_user_id IS NOT NULL AND NOT COALESCE(
    (p_subject_type = 'tenant' AND p_subject_user_id = v_req.tenant_id)
    OR (p_subject_type = 'landlord' AND p_subject_user_id = v_req.landlord_id)
    OR (p_subject_type = 'agent' AND (p_subject_user_id = v_req.agent_id OR p_subject_user_id = v_req.service_center_manager_id)),
    false
  ) THEN
    RAISE EXCEPTION 'that person is not the % on this Rent Plan', p_subject_type;
  END IF;

  -- A repeat of the same call (double tap, retry) returns the row already stored.
  SELECT * INTO v_existing
  FROM public.rent_pipeline_awareness_calls c
  WHERE c.caller_id = v_actor AND c.rent_request_id = p_rent_request_id
    AND c.subject_phone = v_phone AND c.dial_started_at = p_dial_started_at;
  IF v_existing.id IS NOT NULL THEN
    RETURN to_jsonb(v_existing) || jsonb_build_object('already_recorded', true);
  END IF;

  INSERT INTO public.rent_pipeline_awareness_calls (
    rent_request_id, subject_type, subject_user_id, subject_phone, caller_id, caller_team, pipeline_stage,
    dial_started_at, call_result, aware_30m, aware_merchant_codes, explained, note
  ) VALUES (
    p_rent_request_id, p_subject_type, p_subject_user_id, v_phone, v_actor, v_team, v_req.status,
    p_dial_started_at, p_call_result, p_aware_30m, p_aware_merchant_codes, p_explained, v_note
  )
  RETURNING * INTO v_row;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_pipeline.awareness_call_recorded',
    v_actor,
    'rent_request',
    p_rent_request_id,
    jsonb_build_object(
      'awareness_call_id', v_row.id,
      'subject_type', p_subject_type,
      'call_result', p_call_result,
      'caller_team', v_team,
      'pipeline_stage', v_req.status,
      'aware_30m', p_aware_30m,
      'aware_merchant_codes', p_aware_merchant_codes,
      'explained', p_explained,
      'source', 'awareness_calls'
    )
  );

  RETURN to_jsonb(v_row) || jsonb_build_object('already_recorded', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_awareness_call(uuid, text, text, timestamptz, text, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_awareness_call(uuid, text, text, timestamptz, text, uuid, text, text, text, text) TO authenticated;

-- ─── get_awareness_calls_for_request ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_awareness_calls_for_request(p_rent_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_sc uuid;
  v_staff boolean;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_rent_request_id IS NULL THEN RAISE EXCEPTION 'p_rent_request_id is required'; END IF;

  SELECT rr.service_center_manager_id INTO v_sc FROM public.rent_requests rr WHERE rr.id = p_rent_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rent Plan not found'; END IF;

  v_staff := public.has_role(v_actor, 'tenant_ops') OR public.has_role(v_actor, 'landlord_ops') OR public.has_role(v_actor, 'agent_ops')
          OR public.has_role(v_actor, 'operations') OR public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
          OR public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'cto')
          OR public.has_role(v_actor, 'cfo');
  IF NOT (v_staff OR (v_sc IS NOT NULL AND v_sc = v_actor)) THEN RAISE EXCEPTION 'not authorized'; END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) || jsonb_build_object(
           'caller_name', COALESCE(NULLIF(btrim(pr.full_name), ''), 'Unnamed caller'),
           'caller_team', c.caller_team
         ) ORDER BY c.recorded_at DESC, c.id), '[]'::jsonb)
    INTO v_rows
  FROM public.rent_pipeline_awareness_calls c
  LEFT JOIN public.profiles pr ON pr.id = c.caller_id
  WHERE c.rent_request_id = p_rent_request_id;

  RETURN jsonb_build_object(
    'rent_request_id', p_rent_request_id,
    'total', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_awareness_calls_for_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_awareness_calls_for_request(uuid) TO authenticated;
