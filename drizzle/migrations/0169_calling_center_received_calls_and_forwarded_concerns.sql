-- Calling Center: manually recorded incoming calls, and forwarded concerns with
-- an append-only lifecycle (Sent -> Received -> In Progress -> Completed).
-- Nothing here changes the existing cc_* calling spine or its RPCs.

-- ── Received calls ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cc_received_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_by uuid NOT NULL,
  recorded_by_name text,
  caller_name text NOT NULL,
  caller_phone text,
  linked_user_id uuid,
  linked_kind text,
  called_at timestamptz NOT NULL DEFAULT now(),
  concern text NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'open',
  follow_up_at timestamptz,
  follow_up_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cc_received_calls_status_ck CHECK (status IN ('open','following_up','resolved','closed')),
  CONSTRAINT cc_received_calls_linked_kind_ck CHECK (linked_kind IS NULL OR linked_kind IN ('tenant','landlord','agent','staff','user'))
);

CREATE INDEX IF NOT EXISTS cc_received_calls_called_at_idx ON public.cc_received_calls(called_at DESC);
CREATE INDEX IF NOT EXISTS cc_received_calls_recorded_by_idx ON public.cc_received_calls(recorded_by, called_at DESC);

GRANT SELECT ON public.cc_received_calls TO authenticated;
GRANT ALL ON public.cc_received_calls TO service_role;
ALTER TABLE public.cc_received_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY cc_received_calls_select_staff ON public.cc_received_calls
  FOR SELECT TO authenticated
  USING (
    recorded_by = auth.uid()
    OR is_welile_staff(auth.uid())
    OR has_role(auth.uid(), 'super_admin')
  );

-- ── Forwarded concerns ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cc_forwarded_concerns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL,
  feedback_id uuid,
  received_call_id uuid REFERENCES public.cc_received_calls(id) ON DELETE RESTRICT,
  cycle_row_id uuid,
  caller_name text,
  caller_user_id uuid,
  subject_type text,
  title text NOT NULL,
  context text,
  priority text NOT NULL DEFAULT 'normal',
  forwarded_by uuid NOT NULL,
  forwarded_by_name text,
  forwarded_to uuid NOT NULL,
  forwarded_to_staff_id uuid,
  forwarded_to_name text,
  status text NOT NULL DEFAULT 'sent',
  due_at timestamptz,
  accepted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  outcome text,
  follow_up_needed boolean NOT NULL DEFAULT false,
  follow_up_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cc_fc_source_ck CHECK (source_kind IN ('outbound_call','received_call')),
  CONSTRAINT cc_fc_priority_ck CHECK (priority IN ('low','normal','high','critical')),
  CONSTRAINT cc_fc_status_ck CHECK (status IN ('sent','received','in_progress','completed'))
);

CREATE INDEX IF NOT EXISTS cc_fc_to_idx ON public.cc_forwarded_concerns(forwarded_to, status, created_at DESC);
CREATE INDEX IF NOT EXISTS cc_fc_by_idx ON public.cc_forwarded_concerns(forwarded_by, created_at DESC);
CREATE INDEX IF NOT EXISTS cc_fc_created_idx ON public.cc_forwarded_concerns(created_at DESC);

GRANT SELECT ON public.cc_forwarded_concerns TO authenticated;
GRANT ALL ON public.cc_forwarded_concerns TO service_role;
ALTER TABLE public.cc_forwarded_concerns ENABLE ROW LEVEL SECURITY;

-- Participants see their own; HR, CEO, COO and Tenant Ops see everything (read only).
CREATE POLICY cc_fc_select_scoped ON public.cc_forwarded_concerns
  FOR SELECT TO authenticated
  USING (
    forwarded_to = auth.uid()
    OR forwarded_by = auth.uid()
    OR has_role(auth.uid(), 'hr')
    OR has_role(auth.uid(), 'ceo')
    OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'tenant_ops')
    OR has_role(auth.uid(), 'manager')
    OR has_role(auth.uid(), 'super_admin')
  );

CREATE TABLE IF NOT EXISTS public.cc_forwarded_concern_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concern_id uuid NOT NULL REFERENCES public.cc_forwarded_concerns(id) ON DELETE RESTRICT,
  action text NOT NULL,
  actor_id uuid,
  actor_name text,
  note text,
  status_after text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cc_fce_action_ck CHECK (action IN ('forwarded','accepted','started','progress_note','completed'))
);

CREATE INDEX IF NOT EXISTS cc_fce_concern_idx ON public.cc_forwarded_concern_events(concern_id, created_at);
GRANT SELECT ON public.cc_forwarded_concern_events TO authenticated;
GRANT ALL ON public.cc_forwarded_concern_events TO service_role;
ALTER TABLE public.cc_forwarded_concern_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY cc_fce_select_scoped ON public.cc_forwarded_concern_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cc_forwarded_concerns c WHERE c.id = concern_id));

-- Status is derived from the event trail, never written directly.
CREATE OR REPLACE FUNCTION public.cc_fc_apply_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.action = 'accepted' THEN
    UPDATE public.cc_forwarded_concerns
       SET status = 'received', accepted_at = coalesce(accepted_at, NEW.created_at), updated_at = now()
     WHERE id = NEW.concern_id AND status = 'sent';
  ELSIF NEW.action = 'started' THEN
    UPDATE public.cc_forwarded_concerns
       SET status = 'in_progress',
           accepted_at = coalesce(accepted_at, NEW.created_at),
           started_at = coalesce(started_at, NEW.created_at),
           updated_at = now()
     WHERE id = NEW.concern_id AND status IN ('sent','received');
  ELSIF NEW.action = 'completed' THEN
    UPDATE public.cc_forwarded_concerns
       SET status = 'completed',
           completed_at = coalesce(completed_at, NEW.created_at),
           outcome = coalesce(nullif(btrim(NEW.note), ''), outcome),
           updated_at = now()
     WHERE id = NEW.concern_id AND status <> 'completed';
  END IF;

  UPDATE public.cc_forwarded_concern_events e
     SET status_after = c.status
    FROM public.cc_forwarded_concerns c
   WHERE e.id = NEW.id AND c.id = NEW.concern_id;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cc_fc_apply_event ON public.cc_forwarded_concern_events;
CREATE TRIGGER trg_cc_fc_apply_event
  AFTER INSERT ON public.cc_forwarded_concern_events
  FOR EACH ROW EXECUTE FUNCTION public.cc_fc_apply_event();

-- ── Who a concern may be forwarded to ─────────────────────────────────────────
-- Staff with a live employee role, minus Platform Sales Officers.
CREATE OR REPLACE FUNCTION public.cc_forward_staff_options()
RETURNS TABLE(user_id uuid, staff_id uuid, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ur.user_id,
         s.id AS staff_id,
         coalesce(nullif(btrim(p.full_name), ''), 'Staff member') AS full_name
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    LEFT JOIN public.hr_staff s ON s.user_id = ur.user_id AND s.active
   WHERE ur.role = 'employee'
     AND coalesce(ur.enabled, true)
     AND NOT EXISTS (SELECT 1 FROM public.v_pso_officers o WHERE o.user_id = ur.user_id)
   ORDER BY 3;
$$;

GRANT EXECUTE ON FUNCTION public.cc_forward_staff_options() TO authenticated;

-- ── Record a received call ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cc_record_received_call(
  p_caller_name text,
  p_concern text,
  p_caller_phone text DEFAULT NULL,
  p_linked_user_id uuid DEFAULT NULL,
  p_linked_kind text DEFAULT NULL,
  p_called_at timestamptz DEFAULT now(),
  p_notes text DEFAULT NULL,
  p_status text DEFAULT 'open',
  p_follow_up_at timestamptz DEFAULT NULL,
  p_follow_up_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT (is_welile_staff(v_uid) OR has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Only Welile staff can record a received call.';
  END IF;
  IF length(btrim(coalesce(p_caller_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Enter the caller''s name.';
  END IF;
  IF length(btrim(coalesce(p_concern, ''))) < 5 THEN
    RAISE EXCEPTION 'Describe what the caller said (at least 5 characters).';
  END IF;

  INSERT INTO public.cc_received_calls (
    recorded_by, recorded_by_name, caller_name, caller_phone, linked_user_id, linked_kind,
    called_at, concern, notes, status, follow_up_at, follow_up_note
  )
  SELECT v_uid, coalesce(nullif(btrim(p.full_name), ''), 'Officer'),
         btrim(p_caller_name), nullif(btrim(coalesce(p_caller_phone,'')), ''),
         p_linked_user_id, p_linked_kind, coalesce(p_called_at, now()),
         btrim(p_concern), nullif(btrim(coalesce(p_notes,'')), ''),
         coalesce(p_status, 'open'), p_follow_up_at, nullif(btrim(coalesce(p_follow_up_note,'')), '')
    FROM public.profiles p WHERE p.id = v_uid
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.cc_record_received_call(text, text, text, uuid, text, timestamptz, text, text, timestamptz, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cc_update_received_call(
  p_id uuid,
  p_status text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_follow_up_at timestamptz DEFAULT NULL,
  p_follow_up_note text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (is_welile_staff(v_uid) OR has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Only Welile staff can update a received call.';
  END IF;

  UPDATE public.cc_received_calls
     SET status = coalesce(nullif(btrim(coalesce(p_status,'')), ''), status),
         notes = coalesce(nullif(btrim(coalesce(p_notes,'')), ''), notes),
         follow_up_at = coalesce(p_follow_up_at, follow_up_at),
         follow_up_note = coalesce(nullif(btrim(coalesce(p_follow_up_note,'')), ''), follow_up_note),
         updated_at = now()
   WHERE id = p_id;

  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.cc_update_received_call(uuid, text, text, timestamptz, text) TO authenticated;

-- ── Forward a concern ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cc_forward_concern(
  p_source_kind text,
  p_title text,
  p_forwarded_to uuid,
  p_context text DEFAULT NULL,
  p_priority text DEFAULT 'normal',
  p_feedback_id uuid DEFAULT NULL,
  p_received_call_id uuid DEFAULT NULL,
  p_cycle_row_id uuid DEFAULT NULL,
  p_caller_name text DEFAULT NULL,
  p_caller_user_id uuid DEFAULT NULL,
  p_subject_type text DEFAULT NULL,
  p_due_hours integer DEFAULT 12
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_by text;
  v_to text;
  v_staff uuid;
BEGIN
  IF v_uid IS NULL OR NOT (is_welile_staff(v_uid) OR has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Only Welile staff can forward a concern.';
  END IF;
  IF p_source_kind NOT IN ('outbound_call','received_call') THEN
    RAISE EXCEPTION 'Unknown call source.';
  END IF;
  IF length(btrim(coalesce(p_title,''))) < 5 THEN
    RAISE EXCEPTION 'Give the concern a short title (at least 5 characters).';
  END IF;

  SELECT o.full_name, o.staff_id INTO v_to, v_staff
    FROM public.cc_forward_staff_options() o
   WHERE o.user_id = p_forwarded_to;
  IF v_to IS NULL THEN
    RAISE EXCEPTION 'That person cannot receive concerns. Choose a staff member with an active employee role.';
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Officer') INTO v_by FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.cc_forwarded_concerns (
    source_kind, feedback_id, received_call_id, cycle_row_id, caller_name, caller_user_id,
    subject_type, title, context, priority, forwarded_by, forwarded_by_name,
    forwarded_to, forwarded_to_staff_id, forwarded_to_name, status, due_at
  ) VALUES (
    p_source_kind, p_feedback_id, p_received_call_id, p_cycle_row_id,
    nullif(btrim(coalesce(p_caller_name,'')), ''), p_caller_user_id,
    nullif(btrim(coalesce(p_subject_type,'')), ''), btrim(p_title),
    nullif(btrim(coalesce(p_context,'')), ''), coalesce(p_priority, 'normal'),
    v_uid, v_by, p_forwarded_to, v_staff, v_to, 'sent',
    now() + (greatest(1, least(168, coalesce(p_due_hours, 12))) * INTERVAL '1 hour')
  ) RETURNING id INTO v_id;

  INSERT INTO public.cc_forwarded_concern_events (concern_id, action, actor_id, actor_name, note)
  VALUES (v_id, 'forwarded', v_uid, v_by, nullif(btrim(coalesce(p_context,'')), ''));

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.cc_forward_concern(text, text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, integer) TO authenticated;

-- ── Move a concern along ──────────────────────────────────────────────────────
-- Only the person it was forwarded to may accept, start or complete it. The
-- sender may add progress notes. HR and the CEO watch but do not act.
CREATE OR REPLACE FUNCTION public.cc_concern_event(
  p_concern_id uuid,
  p_action text,
  p_note text DEFAULT NULL,
  p_follow_up_needed boolean DEFAULT NULL,
  p_follow_up_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cc_forwarded_concerns;
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in again.';
  END IF;
  IF p_action NOT IN ('accepted','started','progress_note','completed') THEN
    RAISE EXCEPTION 'Unknown step.';
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Concern not found.';
  END IF;

  IF p_action IN ('accepted','started','completed') AND v_row.forwarded_to <> v_uid THEN
    RAISE EXCEPTION 'Only the person this was forwarded to can move it along.';
  END IF;
  IF p_action = 'progress_note' AND v_uid NOT IN (v_row.forwarded_to, v_row.forwarded_by) THEN
    RAISE EXCEPTION 'Only the sender or the receiver can add a note.';
  END IF;
  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'This concern is already completed.';
  END IF;
  IF p_action = 'completed' AND length(btrim(coalesce(p_note,''))) < 10 THEN
    RAISE EXCEPTION 'Write what was done to resolve it (at least 10 characters).';
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Staff member') INTO v_name FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.cc_forwarded_concern_events (concern_id, action, actor_id, actor_name, note)
  VALUES (p_concern_id, p_action, v_uid, v_name, nullif(btrim(coalesce(p_note,'')), ''));

  IF p_follow_up_needed IS NOT NULL OR p_follow_up_note IS NOT NULL THEN
    UPDATE public.cc_forwarded_concerns
       SET follow_up_needed = coalesce(p_follow_up_needed, follow_up_needed),
           follow_up_note = coalesce(nullif(btrim(coalesce(p_follow_up_note,'')), ''), follow_up_note),
           updated_at = now()
     WHERE id = p_concern_id;
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  RETURN jsonb_build_object('success', true, 'status', v_row.status);
END $$;

GRANT EXECUTE ON FUNCTION public.cc_concern_event(uuid, text, text, boolean, text) TO authenticated;
