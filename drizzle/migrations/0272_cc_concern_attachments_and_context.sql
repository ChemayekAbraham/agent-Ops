-- Attachments carried by a forwarded concern, and a read-only person/call context
-- reader. Additive only: no existing concern rule, status, permission, audit trail
-- or notification is touched.

CREATE TABLE IF NOT EXISTS public.cc_concern_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concern_id uuid NOT NULL REFERENCES public.cc_forwarded_concerns(id) ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text,
  size_bytes bigint,
  kind text NOT NULL DEFAULT 'document',
  uploaded_by uuid NOT NULL,
  uploaded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cc_concern_attachments_concern_idx
  ON public.cc_concern_attachments (concern_id, created_at);

GRANT SELECT, INSERT ON public.cc_concern_attachments TO authenticated;
GRANT ALL ON public.cc_concern_attachments TO service_role;

ALTER TABLE public.cc_concern_attachments ENABLE ROW LEVEL SECURITY;

-- Exactly the reach of the concern itself: sender, current handler, active
-- reviewers and the named overseers (HR / CEO / super admin).
DROP POLICY IF EXISTS cc_concern_attachments_read ON public.cc_concern_attachments;
CREATE POLICY cc_concern_attachments_read
  ON public.cc_concern_attachments FOR SELECT TO authenticated
  USING (public.cc_can_view_concern(concern_id, auth.uid()));

DROP POLICY IF EXISTS cc_concern_attachments_insert ON public.cc_concern_attachments;
CREATE POLICY cc_concern_attachments_insert
  ON public.cc_concern_attachments FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND public.cc_can_view_concern(concern_id, auth.uid())
  );

-- No UPDATE or DELETE policy: attachments survive forwarding, reassignment,
-- hand-offs and completion.

-- Storage: files live under <concern_id>/... in the private
-- concern-attachments bucket and inherit the same reach.
DROP POLICY IF EXISTS cc_concern_attachments_storage_read ON storage.objects;
CREATE POLICY cc_concern_attachments_storage_read
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'concern-attachments'
    AND public.cc_can_view_concern(((storage.foldername(name))[1])::uuid, auth.uid())
  );

DROP POLICY IF EXISTS cc_concern_attachments_storage_insert ON storage.objects;
CREATE POLICY cc_concern_attachments_storage_insert
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'concern-attachments'
    AND public.cc_can_view_concern(((storage.foldername(name))[1])::uuid, auth.uid())
  );

-- Record one uploaded file against a concern.
CREATE OR REPLACE FUNCTION public.cc_add_concern_attachment(
  p_concern_id uuid,
  p_storage_path text,
  p_file_name text,
  p_mime_type text DEFAULT NULL,
  p_size_bytes bigint DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
  v_kind text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in.';
  END IF;
  IF NOT public.cc_can_view_concern(p_concern_id, v_uid) THEN
    RAISE EXCEPTION 'You cannot add files to this concern.';
  END IF;
  IF length(btrim(coalesce(p_storage_path, ''))) = 0 OR length(btrim(coalesce(p_file_name, ''))) = 0 THEN
    RAISE EXCEPTION 'The file is missing a name.';
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Staff member') INTO v_name
    FROM public.profiles WHERE id = v_uid;

  v_kind := CASE WHEN coalesce(p_mime_type, '') LIKE 'image/%' THEN 'image' ELSE 'document' END;

  INSERT INTO public.cc_concern_attachments (
    concern_id, storage_path, file_name, mime_type, size_bytes, kind, uploaded_by, uploaded_by_name
  ) VALUES (
    p_concern_id, btrim(p_storage_path), btrim(p_file_name), nullif(btrim(coalesce(p_mime_type, '')), ''),
    p_size_bytes, v_kind, v_uid, v_name
  )
  ON CONFLICT (storage_path) DO UPDATE SET file_name = excluded.file_name
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.cc_add_concern_attachment(uuid, text, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_add_concern_attachment(uuid, text, text, text, bigint) TO authenticated;

-- The authoritative person and call behind a concern. Read-only: it only reads
-- records that already exist and never creates a person.
CREATE OR REPLACE FUNCTION public.cc_concern_context(p_concern_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_c record;
  v_person jsonb := '{}'::jsonb;
  v_call jsonb := '{}'::jsonb;
  v_person_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.cc_can_view_concern(p_concern_id, v_uid) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_c FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  IF v_c.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_person_id := v_c.caller_user_id;

  -- Call details, from whichever record the concern came from.
  IF v_c.received_call_id IS NOT NULL THEN
    SELECT jsonb_build_object(
             'kind', 'received_call',
             'called_at', r.called_at,
             'recorded_by_name', r.recorded_by_name,
             'caller_name_recorded', r.caller_name,
             'caller_phone_recorded', r.caller_phone,
             'linked_kind', r.linked_kind,
             'is_registered', (r.linked_user_id IS NOT NULL),
             'concern', r.concern,
             'notes', r.notes,
             'call_status', r.status,
             'follow_up_at', r.follow_up_at,
             'follow_up_note', r.follow_up_note
           ),
           coalesce(v_person_id, r.linked_user_id)
      INTO v_call, v_person_id
      FROM public.cc_received_calls r
     WHERE r.id = v_c.received_call_id;
  ELSIF v_c.cycle_row_id IS NOT NULL THEN
    SELECT jsonb_build_object(
             'kind', 'outbound_call',
             'called_at', coalesce(a.recorded_at, row_.updated_at, row_.created_at),
             'recorded_by_name', (SELECT coalesce(nullif(btrim(p.full_name), ''), 'Officer') FROM public.profiles p WHERE p.id = a.caller_id),
             'is_registered', true,
             'attempt_outcome', a.outcome::text,
             'channel', a.channel::text,
             'row_state', row_.state::text,
             'attempt_no', a.attempt_no,
             'feedback_note', (SELECT f.note FROM public.cc_feedback f WHERE f.attempt_id = a.id ORDER BY f.created_at DESC LIMIT 1),
             'feedback_severity', (SELECT f.severity::text FROM public.cc_feedback f WHERE f.attempt_id = a.id ORDER BY f.created_at DESC LIMIT 1),
             'feedback_category', (
               SELECT cat.name FROM public.cc_feedback f
                 JOIN public.cc_feedback_categories cat ON cat.id = f.category_id
                WHERE f.attempt_id = a.id ORDER BY f.created_at DESC LIMIT 1
             )
           ),
           coalesce(v_person_id, row_.subject_id)
      INTO v_call, v_person_id
      FROM public.cc_cycle_rows row_
      LEFT JOIN public.cc_call_attempts a ON a.cycle_row_id = row_.id
     WHERE row_.id = v_c.cycle_row_id
     ORDER BY a.recorded_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  IF v_call = '{}'::jsonb THEN
    v_call := jsonb_build_object(
      'kind', CASE WHEN v_c.source_kind = 'received_call' THEN 'received_call' ELSE 'outbound_call' END,
      'called_at', v_c.created_at,
      'is_registered', (v_person_id IS NOT NULL)
    );
  END IF;

  -- Authoritative person record, when the caller is a registered person.
  IF v_person_id IS NOT NULL THEN
    SELECT jsonb_build_object(
             'user_id', p.id,
             'full_name', p.full_name,
             'phone', p.phone,
             'email', p.email,
             'district', p.district,
             'address', p.address,
             'national_id', p.national_id,
             'created_at', p.created_at,
             'roles', (SELECT array_agg(DISTINCT ur.role::text) FROM public.user_roles ur WHERE ur.user_id = p.id),
             'agent_name', (
               SELECT coalesce(nullif(btrim(ap.full_name), ''), NULL) FROM public.rent_requests rr
                 JOIN public.profiles ap ON ap.id = rr.agent_id
                WHERE rr.tenant_id = p.id AND rr.agent_id IS NOT NULL
                ORDER BY rr.created_at DESC LIMIT 1
             ),
             'agent_phone', (
               SELECT ap.phone FROM public.rent_requests rr
                 JOIN public.profiles ap ON ap.id = rr.agent_id
                WHERE rr.tenant_id = p.id AND rr.agent_id IS NOT NULL
                ORDER BY rr.created_at DESC LIMIT 1
             ),
             'active_plan', (
               SELECT jsonb_build_object(
                        'id', rr.id, 'status', rr.status, 'rent_amount', rr.rent_amount,
                        'total_repayment', rr.total_repayment, 'amount_repaid', rr.amount_repaid,
                        'daily_repayment', rr.daily_repayment, 'created_at', rr.created_at
                      )
                 FROM public.rent_requests rr
                WHERE rr.tenant_id = p.id
                ORDER BY (rr.status IN ('repaying','funded','disbursed')) DESC, rr.created_at DESC
                LIMIT 1
             )
           ) INTO v_person
      FROM public.profiles p
     WHERE p.id = v_person_id;
  END IF;

  RETURN jsonb_build_object(
    'concern_id', v_c.id,
    'source_kind', v_c.source_kind,
    'subject_type', v_c.subject_type,
    'caller_name', v_c.caller_name,
    'person_id', v_person_id,
    'person', coalesce(v_person, '{}'::jsonb),
    'call', v_call
  );
END $$;

REVOKE ALL ON FUNCTION public.cc_concern_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_concern_context(uuid) TO authenticated;