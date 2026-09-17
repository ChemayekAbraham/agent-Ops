-- Calling Center forwarded concerns: reassignment authority for HR/CEO,
-- adjustable deadlines (default 24h), and a fuller append-only audit trail.
-- Additive only: no history is ever overwritten or removed.

ALTER TABLE public.cc_forwarded_concerns
  ADD COLUMN IF NOT EXISTS original_forwarded_to uuid,
  ADD COLUMN IF NOT EXISTS original_forwarded_to_name text,
  ADD COLUMN IF NOT EXISTS reassigned_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reassigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reassigned_by uuid,
  ADD COLUMN IF NOT EXISTS last_reassigned_by_name text,
  ADD COLUMN IF NOT EXISTS due_is_custom boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS due_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS due_set_by uuid,
  ADD COLUMN IF NOT EXISTS due_set_by_name text;

-- The first recipient is remembered permanently.
UPDATE public.cc_forwarded_concerns
   SET original_forwarded_to = COALESCE(original_forwarded_to, forwarded_to),
       original_forwarded_to_name = COALESCE(original_forwarded_to_name, forwarded_to_name)
 WHERE original_forwarded_to IS NULL;

ALTER TABLE public.cc_forwarded_concern_events
  ADD COLUMN IF NOT EXISTS prev_user_id uuid,
  ADD COLUMN IF NOT EXISTS prev_user_name text,
  ADD COLUMN IF NOT EXISTS new_user_id uuid,
  ADD COLUMN IF NOT EXISTS new_user_name text,
  ADD COLUMN IF NOT EXISTS prev_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS new_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS reason text;

ALTER TABLE public.cc_forwarded_concern_events DROP CONSTRAINT IF EXISTS cc_fce_action_ck;
ALTER TABLE public.cc_forwarded_concern_events
  ADD CONSTRAINT cc_fce_action_ck CHECK (action = ANY (ARRAY[
    'forwarded','accepted','started','progress_note','completed','reassigned','due_changed'
  ]));

-- A previous recipient, and anyone who acted on a concern, keeps seeing it.
DROP POLICY IF EXISTS cc_fc_select_scoped ON public.cc_forwarded_concerns;
CREATE POLICY cc_fc_select_scoped ON public.cc_forwarded_concerns
FOR SELECT TO authenticated
USING (
  forwarded_to = auth.uid()
  OR forwarded_by = auth.uid()
  OR original_forwarded_to = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.cc_forwarded_concern_events e
     WHERE e.concern_id = cc_forwarded_concerns.id
       AND auth.uid() IN (e.actor_id, e.prev_user_id, e.new_user_id)
  )
  OR public.has_role(auth.uid(), 'hr'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'tenant_ops'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

-- Who may reassign / change a deadline.
CREATE OR REPLACE FUNCTION public.cc_concern_powers()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_hr boolean := false;
  v_ceo boolean := false;
  v_admin boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('can_reassign', false, 'can_set_due', false, 'is_hr', false, 'is_ceo', false);
  END IF;
  v_hr := public.has_role(v_uid, 'hr'::app_role);
  v_ceo := public.has_role(v_uid, 'ceo'::app_role);
  v_admin := public.has_role(v_uid, 'super_admin'::app_role);
  RETURN jsonb_build_object(
    'can_reassign', (v_hr OR v_ceo OR v_admin),
    'can_set_due', (v_hr OR v_ceo OR v_admin),
    'is_hr', v_hr,
    'is_ceo', v_ceo
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cc_concern_powers() TO authenticated;

-- Reassign the person a concern is forwarded to. HR, the CEO and super admins only.
CREATE OR REPLACE FUNCTION public.cc_reassign_concern(
  p_concern_id uuid,
  p_new_forwarded_to uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cc_forwarded_concerns;
  v_actor text;
  v_new_name text;
  v_new_staff uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in again.';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'hr'::app_role)
    OR public.has_role(v_uid, 'ceo'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only HR or the CEO can change who a concern is forwarded to.';
  END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 THEN
    RAISE EXCEPTION 'Write why you are changing the person handling this (at least 10 characters).';
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Concern not found.';
  END IF;
  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'This concern is already completed.';
  END IF;
  IF v_row.forwarded_to = p_new_forwarded_to THEN
    RAISE EXCEPTION 'That is already the person handling this.';
  END IF;

  SELECT o.full_name, o.staff_id INTO v_new_name, v_new_staff
    FROM public.cc_forward_staff_options() o
   WHERE o.user_id = p_new_forwarded_to;
  IF v_new_name IS NULL THEN
    RAISE EXCEPTION 'That person cannot receive concerns. Choose a staff member with an active employee role.';
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Staff member') INTO v_actor
    FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.cc_forwarded_concern_events (
    concern_id, action, actor_id, actor_name, note, reason,
    prev_user_id, prev_user_name, new_user_id, new_user_name
  ) VALUES (
    p_concern_id, 'reassigned', v_uid, v_actor, btrim(p_reason), btrim(p_reason),
    v_row.forwarded_to, v_row.forwarded_to_name, p_new_forwarded_to, v_new_name
  );

  UPDATE public.cc_forwarded_concerns
     SET forwarded_to = p_new_forwarded_to,
         forwarded_to_name = v_new_name,
         forwarded_to_staff_id = v_new_staff,
         original_forwarded_to = coalesce(original_forwarded_to, v_row.forwarded_to),
         original_forwarded_to_name = coalesce(original_forwarded_to_name, v_row.forwarded_to_name),
         reassigned_count = reassigned_count + 1,
         last_reassigned_at = now(),
         last_reassigned_by = v_uid,
         last_reassigned_by_name = v_actor,
         -- the new person must confirm they have it; the old steps stay in history
         status = 'sent',
         accepted_at = NULL,
         started_at = NULL,
         updated_at = now()
   WHERE id = p_concern_id;

  BEGIN
    INSERT INTO public.system_events (
      event_type, user_id, related_entity_type, related_entity_id, description, metadata
    ) VALUES (
      'role_changed', p_new_forwarded_to, 'cc_forwarded_concerns', p_concern_id,
      format('Calling Center concern reassigned to %s', v_new_name),
      jsonb_build_object(
        'previous_recipient', v_row.forwarded_to,
        'previous_recipient_name', v_row.forwarded_to_name,
        'new_recipient', p_new_forwarded_to,
        'new_recipient_name', v_new_name,
        'changed_by', v_uid,
        'changed_by_name', v_actor,
        'sender', v_row.forwarded_by,
        'reason', btrim(p_reason)
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'previous_recipient_name', v_row.forwarded_to_name,
    'new_recipient_name', v_new_name
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cc_reassign_concern(uuid, uuid, text) TO authenticated;

-- Set or adjust the answer deadline. The person handling it, HR, the CEO.
CREATE OR REPLACE FUNCTION public.cc_set_concern_due(
  p_concern_id uuid,
  p_due_at timestamptz,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cc_forwarded_concerns;
  v_actor text;
  v_priv boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in again.';
  END IF;
  IF p_due_at IS NULL THEN
    RAISE EXCEPTION 'Choose the new answer time.';
  END IF;
  IF length(btrim(coalesce(p_reason,''))) < 5 THEN
    RAISE EXCEPTION 'Write why the answer time is changing (at least 5 characters).';
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Concern not found.';
  END IF;
  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'This concern is already completed.';
  END IF;

  v_priv := public.has_role(v_uid, 'hr'::app_role)
         OR public.has_role(v_uid, 'ceo'::app_role)
         OR public.has_role(v_uid, 'super_admin'::app_role);

  IF NOT v_priv AND v_row.forwarded_to <> v_uid THEN
    RAISE EXCEPTION 'Only the person handling this, HR or the CEO can change the answer time.';
  END IF;
  IF p_due_at < now() - INTERVAL '1 minute' THEN
    RAISE EXCEPTION 'Pick a time in the future.';
  END IF;
  IF p_due_at > now() + INTERVAL '60 days' THEN
    RAISE EXCEPTION 'That is too far ahead. Pick a time within 60 days.';
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Staff member') INTO v_actor
    FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.cc_forwarded_concern_events (
    concern_id, action, actor_id, actor_name, note, reason, prev_due_at, new_due_at
  ) VALUES (
    p_concern_id, 'due_changed', v_uid, v_actor, btrim(p_reason), btrim(p_reason),
    v_row.due_at, p_due_at
  );

  UPDATE public.cc_forwarded_concerns
     SET due_at = p_due_at,
         due_is_custom = true,
         due_set_at = now(),
         due_set_by = v_uid,
         due_set_by_name = v_actor,
         updated_at = now()
   WHERE id = p_concern_id;

  RETURN jsonb_build_object('success', true, 'due_at', p_due_at, 'previous_due_at', v_row.due_at);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cc_set_concern_due(uuid, timestamptz, text) TO authenticated;

-- Forwarding: default answer time is now 24 hours, and the first recipient is
-- recorded as the original recipient from the start.
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
  p_due_hours integer DEFAULT 24
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_by text;
  v_to text;
  v_staff uuid;
  v_hours integer;
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

  -- 24 hours unless a custom answer time is chosen.
  v_hours := greatest(1, least(168, coalesce(p_due_hours, 24)));

  INSERT INTO public.cc_forwarded_concerns (
    source_kind, feedback_id, received_call_id, cycle_row_id, caller_name, caller_user_id,
    subject_type, title, context, priority, forwarded_by, forwarded_by_name,
    forwarded_to, forwarded_to_staff_id, forwarded_to_name, status, due_at,
    original_forwarded_to, original_forwarded_to_name, due_is_custom
  ) VALUES (
    p_source_kind, p_feedback_id, p_received_call_id, p_cycle_row_id,
    nullif(btrim(coalesce(p_caller_name,'')), ''), p_caller_user_id,
    nullif(btrim(coalesce(p_subject_type,'')), ''), btrim(p_title),
    nullif(btrim(coalesce(p_context,'')), ''), coalesce(p_priority, 'normal'),
    v_uid, v_by, p_forwarded_to, v_staff, v_to, 'sent',
    now() + (v_hours * INTERVAL '1 hour'),
    p_forwarded_to, v_to, (p_due_hours IS NOT NULL AND p_due_hours <> 24)
  ) RETURNING id INTO v_id;

  INSERT INTO public.cc_forwarded_concern_events (
    concern_id, action, actor_id, actor_name, note, new_user_id, new_user_name, new_due_at
  ) VALUES (
    v_id, 'forwarded', v_uid, v_by, nullif(btrim(coalesce(p_context,'')), ''),
    p_forwarded_to, v_to, now() + (v_hours * INTERVAL '1 hour')
  );

  RETURN v_id;
END;
$$;