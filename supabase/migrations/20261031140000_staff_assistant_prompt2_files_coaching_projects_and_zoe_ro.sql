-- =============================================================================
-- Zoe (My Space Staff Assistant) — Prompt 2: Private File Uploads, Projects,
-- Work Delivery Coaching RPCs, and Extended zoe_ro Read-Only Views
-- Version: 20261031140000 (unique across supabase/migrations/ and schema_migrations)
-- =============================================================================

-- 1. Private storage bucket `staff-assistant-uploads` (max 10 MB, owner-scoped)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'staff-assistant-uploads',
  'staff-assistant-uploads',
  false,
  10485760,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'image/heif'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "staff_assistant_uploads_storage_select_own" ON storage.objects;
CREATE POLICY "staff_assistant_uploads_storage_select_own"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'staff-assistant-uploads'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND public.staff_assistant_has_access()
  );

DROP POLICY IF EXISTS "staff_assistant_uploads_storage_insert_own" ON storage.objects;
CREATE POLICY "staff_assistant_uploads_storage_insert_own"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'staff-assistant-uploads'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND public.staff_assistant_has_access()
  );

DROP POLICY IF EXISTS "staff_assistant_uploads_storage_delete_own" ON storage.objects;
CREATE POLICY "staff_assistant_uploads_storage_delete_own"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'staff-assistant-uploads'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND public.staff_assistant_has_access()
  );

-- 2. Projects table (`public.staff_assistant_projects`) — private to owner
CREATE TABLE IF NOT EXISTS public.staff_assistant_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 4000),
  pinned_file_ids uuid[] NOT NULL DEFAULT '{}',
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_projects_user
  ON public.staff_assistant_projects (user_id, is_archived, updated_at DESC);

ALTER TABLE public.staff_assistant_projects ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.staff_assistant_projects FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_assistant_projects TO authenticated;

DROP POLICY IF EXISTS "mfa_required_for_staff" ON public.staff_assistant_projects;
CREATE POLICY "mfa_required_for_staff"
  ON public.staff_assistant_projects
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (
    public.staff_assistant_has_access()
    AND COALESCE((SELECT auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
  )
  WITH CHECK (
    public.staff_assistant_has_access()
    AND COALESCE((SELECT auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
  );

DROP POLICY IF EXISTS "staff_assistant_projects_owner_all" ON public.staff_assistant_projects;
CREATE POLICY "staff_assistant_projects_owner_all"
  ON public.staff_assistant_projects
  FOR ALL
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER TABLE public.staff_assistant_conversations
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.staff_assistant_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_staff_assistant_conversations_project
  ON public.staff_assistant_conversations (user_id, project_id);

-- 3. Private file uploads metadata table (`public.staff_assistant_uploads`)
--    Never stored in `staff_assistant_knowledge_base`; deleted with chat and after 90 days.
CREATE TABLE IF NOT EXISTS public.staff_assistant_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.staff_assistant_conversations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.staff_assistant_projects(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (char_length(btrim(mime_type)) BETWEEN 1 AND 160),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  extracted_summary text NOT NULL DEFAULT '' CHECK (char_length(extracted_summary) <= 24000),
  has_pii_warning boolean NOT NULL DEFAULT false,
  pii_warning_types text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_uploads_user_conv
  ON public.staff_assistant_uploads (user_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_uploads_expires
  ON public.staff_assistant_uploads (expires_at);

ALTER TABLE public.staff_assistant_uploads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.staff_assistant_uploads FROM PUBLIC, anon;
GRANT SELECT, INSERT, DELETE ON TABLE public.staff_assistant_uploads TO authenticated;

DROP POLICY IF EXISTS "mfa_required_for_staff" ON public.staff_assistant_uploads;
CREATE POLICY "mfa_required_for_staff"
  ON public.staff_assistant_uploads
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (
    public.staff_assistant_has_access()
    AND COALESCE((SELECT auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
  )
  WITH CHECK (
    public.staff_assistant_has_access()
    AND COALESCE((SELECT auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
  );

DROP POLICY IF EXISTS "staff_assistant_uploads_owner_all" ON public.staff_assistant_uploads;
CREATE POLICY "staff_assistant_uploads_owner_all"
  ON public.staff_assistant_uploads
  FOR ALL
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Enforce at most 5 uploads per conversation and 10 MB per file
CREATE OR REPLACE FUNCTION public.staff_assistant_enforce_upload_limits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NEW.size_bytes > 10485760 THEN
    RAISE EXCEPTION 'Each file upload must be 10 MB or smaller.'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.conversation_id IS NOT NULL THEN
    SELECT count(*) INTO v_count
    FROM public.staff_assistant_uploads
    WHERE conversation_id = NEW.conversation_id
      AND user_id = NEW.user_id;

    IF v_count >= 5 THEN
      RAISE EXCEPTION 'A maximum of 5 files can be attached to a single Zoe conversation.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_enforce_upload_limits() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_enforce_upload_limits() TO authenticated;

DROP TRIGGER IF EXISTS trg_staff_assistant_uploads_limit_per_chat
  ON public.staff_assistant_uploads;

CREATE TRIGGER trg_staff_assistant_uploads_limit_per_chat
  BEFORE INSERT ON public.staff_assistant_uploads
  FOR EACH ROW
  EXECUTE FUNCTION public.staff_assistant_enforce_upload_limits();

-- Delete uploads when a conversation is hidden/cleared or older than 90 days
CREATE OR REPLACE FUNCTION public.staff_assistant_purge_expired_uploads()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  WITH removed AS (
    DELETE FROM public.staff_assistant_uploads u
    WHERE u.expires_at <= now()
       OR u.created_at <= (now() - interval '90 days')
       OR EXISTS (
         SELECT 1
         FROM public.staff_assistant_conversations c
         WHERE c.id = u.conversation_id
           AND c.hidden_by_user = true
       )
    RETURNING u.storage_path
  )
  SELECT count(*) INTO v_deleted FROM removed;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_purge_expired_uploads() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_purge_expired_uploads() TO authenticated;

-- Project management RPCs (owner-scoped)
CREATE OR REPLACE FUNCTION public.staff_assistant_upsert_project(
  p_project_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_instructions text DEFAULT '',
  p_pinned_file_ids uuid[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_clean_name text := btrim(COALESCE(p_name, ''));
  v_clean_instructions text := left(btrim(COALESCE(p_instructions, '')), 4000);
  v_row public.staff_assistant_projects;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required.'
      USING ERRCODE = '42501';
  END IF;

  IF char_length(v_clean_name) < 1 OR char_length(v_clean_name) > 120 THEN
    RAISE EXCEPTION 'Project name must be between 1 and 120 characters.'
      USING ERRCODE = '22023';
  END IF;

  IF p_project_id IS NOT NULL THEN
    UPDATE public.staff_assistant_projects
    SET
      name = v_clean_name,
      instructions = v_clean_instructions,
      pinned_file_ids = COALESCE(p_pinned_file_ids, '{}'),
      updated_at = now()
    WHERE id = p_project_id
      AND user_id = v_uid
    RETURNING * INTO v_row;

    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Project not found or not owned by caller.'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    INSERT INTO public.staff_assistant_projects (
      user_id, name, instructions, pinned_file_ids
    )
    VALUES (
      v_uid, v_clean_name, v_clean_instructions, COALESCE(p_pinned_file_ids, '{}')
    )
    RETURNING * INTO v_row;
  END IF;

  RETURN to_jsonb(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_upsert_project(uuid, text, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_upsert_project(uuid, text, text, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_assistant_list_projects()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.updated_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM public.staff_assistant_projects p
  WHERE p.user_id = v_uid
    AND p.is_archived = false;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_list_projects() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_list_projects() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_assistant_delete_project(
  p_project_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required.'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.staff_assistant_projects
  WHERE id = p_project_id
    AND user_id = v_uid;

  RETURN jsonb_build_object('deleted', true, 'project_id', p_project_id);
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_delete_project(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_delete_project(uuid) TO authenticated;

-- 4. Coaching on Work Delivery RPCs (`assistant_staff_my_work_summary` & `assistant_staff_team_work_summary`)
--    Built strictly from official figures. Staff see ONLY their own figures + anonymous team median;
--    managers see only their own department.
CREATE OR REPLACE FUNCTION public.assistant_staff_my_work_summary(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_to date := COALESCE(p_to, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_from date := COALESCE(p_from, ((now() AT TIME ZONE 'Africa/Kampala')::date - 6));
  v_span_days integer;
  v_prev_to date;
  v_prev_from date;
  v_my_calls_curr integer := 0;
  v_my_calls_answered integer := 0;
  v_my_calls_prev integer := 0;
  v_team_median_calls numeric := 0;
  v_my_tasks_completed integer := 0;
  v_my_tasks_pending integer := 0;
  v_my_tasks_prev_completed integer := 0;
  v_team_median_tasks_completed numeric := 0;
  v_my_verifications_curr integer := 0;
  v_my_verifications_prev integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required.'
      USING ERRCODE = '42501';
  END IF;

  IF v_from > v_to THEN
    v_from := v_to - 6;
  END IF;
  v_span_days := GREATEST((v_to - v_from) + 1, 1);
  v_prev_to := v_from - 1;
  v_prev_from := v_prev_to - (v_span_days - 1);

  -- Caller's own calls in current vs previous period + anonymous team median from cc_call_attempts
  IF to_regclass('public.cc_call_attempts') IS NOT NULL THEN
    SELECT
      count(*) FILTER (
        WHERE (COALESCE(c.recorded_at, c.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_from AND v_to
      ),
      count(*) FILTER (
        WHERE (COALESCE(c.recorded_at, c.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_from AND v_to
          AND c.outcome::text = 'engaged'
      ),
      count(*) FILTER (
        WHERE (COALESCE(c.recorded_at, c.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_prev_from AND v_prev_to
      )
    INTO v_my_calls_curr, v_my_calls_answered, v_my_calls_prev
    FROM public.cc_call_attempts c
    WHERE c.caller_id = v_uid
      AND c.void_reason IS NULL;

    WITH per_caller AS (
      SELECT c.caller_id, count(*)::numeric AS call_cnt
      FROM public.cc_call_attempts c
      WHERE (COALESCE(c.recorded_at, c.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_from AND v_to
        AND c.caller_id IS NOT NULL
        AND c.void_reason IS NULL
      GROUP BY c.caller_id
    )
    SELECT COALESCE(ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY call_cnt), 1), 0)
    INTO v_team_median_calls
    FROM per_caller;
  END IF;

  -- Caller's own tasks in current vs previous period + anonymous team median from staff_tasks
  IF to_regclass('public.staff_tasks') IS NOT NULL THEN
    SELECT
      count(*) FILTER (
        WHERE t.status = 'completed'
          AND (COALESCE(t.completed_at, t.updated_at, t.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_from AND v_to
      ),
      count(*) FILTER (WHERE t.status IN ('pending', 'in_progress')),
      count(*) FILTER (
        WHERE t.status = 'completed'
          AND (COALESCE(t.completed_at, t.updated_at, t.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_prev_from AND v_prev_to
      )
    INTO v_my_tasks_completed, v_my_tasks_pending, v_my_tasks_prev_completed
    FROM public.staff_tasks t
    WHERE t.assigned_to = v_uid;

    WITH per_assignee AS (
      SELECT t.assigned_to, count(*) FILTER (WHERE t.status = 'completed')::numeric AS done_cnt
      FROM public.staff_tasks t
      WHERE (COALESCE(t.completed_at, t.updated_at, t.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_from AND v_to
        AND t.assigned_to IS NOT NULL
      GROUP BY t.assigned_to
    )
    SELECT COALESCE(ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY done_cnt), 1), 0)
    INTO v_team_median_tasks_completed
    FROM per_assignee;
  END IF;

  -- Caller's own Landlord Ops / Tenant Ops reviews in rent_requests
  IF to_regclass('public.rent_requests') IS NOT NULL THEN
    SELECT
      count(*) FILTER (
        WHERE (COALESCE(r.updated_at, r.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_from AND v_to
      ),
      count(*) FILTER (
        WHERE (COALESCE(r.updated_at, r.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_prev_from AND v_prev_to
      )
    INTO v_my_verifications_curr, v_my_verifications_prev
    FROM public.rent_requests r
    WHERE r.approved_by = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'source', 'assistant_staff_my_work_summary',
    'scope', 'self_only',
    'advisory_notice', 'Suggestions only — never ratings or HR decisions.',
    'period', jsonb_build_object(
      'from', v_from::text,
      'to', v_to::text,
      'previous_from', v_prev_from::text,
      'previous_to', v_prev_to::text,
      'days', v_span_days
    ),
    'my_metrics', jsonb_build_object(
      'calls_logged', v_my_calls_curr,
      'calls_answered', v_my_calls_answered,
      'calls_answer_rate_pct', CASE
        WHEN v_my_calls_curr > 0 THEN ROUND((v_my_calls_answered::numeric * 100.0) / v_my_calls_curr, 1)
        ELSE 0.0
      END,
      'calls_previous_period', v_my_calls_prev,
      'calls_team_median', v_team_median_calls,
      'tasks_completed', v_my_tasks_completed,
      'tasks_pending', v_my_tasks_pending,
      'tasks_completed_previous_period', v_my_tasks_prev_completed,
      'tasks_completed_team_median', v_team_median_tasks_completed,
      'verifications_or_approvals', v_my_verifications_curr,
      'verifications_previous_period', v_my_verifications_prev
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_work_summary(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_work_summary(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.assistant_staff_team_work_summary(
  p_department text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_roles text[];
  v_is_exec boolean := false;
  v_allowed_depts text[] := '{}';
  v_target_dept text;
  v_to date := COALESCE(p_to, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_from date := COALESCE(p_from, ((now() AT TIME ZONE 'Africa/Kampala')::date - 6));
  v_members jsonb := '[]'::jsonb;
  v_dept_median_calls numeric := 0;
  v_dept_median_tasks numeric := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(ur.role::text), '{}')
  INTO v_roles
  FROM public.user_roles ur
  WHERE ur.user_id = v_uid
    AND COALESCE(ur.enabled, true) = true;

  v_is_exec := v_roles && ARRAY['ceo', 'coo', 'cfo', 'cto', 'super_admin', 'hr', 'crm', 'manager'];

  IF 'tenant_ops' = ANY(v_roles) THEN v_allowed_depts := array_append(v_allowed_depts, 'tenant_ops'); END IF;
  IF 'landlord_ops' = ANY(v_roles) THEN v_allowed_depts := array_append(v_allowed_depts, 'landlord_ops'); END IF;
  IF 'agent_ops' = ANY(v_roles) THEN v_allowed_depts := array_append(v_allowed_depts, 'agent_ops'); END IF;
  IF 'partner_ops' = ANY(v_roles) THEN v_allowed_depts := array_append(v_allowed_depts, 'partner_ops'); END IF;
  IF 'financial_ops' = ANY(v_roles) THEN v_allowed_depts := array_append(v_allowed_depts, 'financial_ops'); END IF;
  IF 'crm' = ANY(v_roles) THEN v_allowed_depts := array_append(v_allowed_depts, 'crm'); END IF;
  IF 'hr' = ANY(v_roles) THEN v_allowed_depts := array_append(v_allowed_depts, 'hr'); END IF;

  IF NOT v_is_exec AND COALESCE(array_length(v_allowed_depts, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Not authorized: manager or department lead role required for assistant_staff_team_work_summary.'
      USING ERRCODE = '42501';
  END IF;

  v_target_dept := LOWER(btrim(COALESCE(p_department, '')));
  IF v_target_dept = '' THEN
    v_target_dept := COALESCE(v_allowed_depts[1], 'tenant_ops');
  END IF;

  IF NOT v_is_exec AND NOT (v_target_dept = ANY(v_allowed_depts)) THEN
    RAISE EXCEPTION 'Not authorized: you can only view team work summaries for your own department (%).',
      array_to_string(v_allowed_depts, ', ')
      USING ERRCODE = '42501';
  END IF;

  WITH dept_staff AS (
    SELECT DISTINCT
      ur.user_id,
      COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff Member') AS staff_name,
      ur.role::text AS department_role
    FROM public.user_roles ur
    LEFT JOIN public.profiles p ON p.id = ur.user_id
    WHERE COALESCE(ur.enabled, true) = true
      AND ur.role::text = v_target_dept
    LIMIT 40
  ),
  member_metrics AS (
    SELECT
      ds.staff_name,
      ds.department_role,
      COALESCE((
        SELECT count(*)
        FROM public.cc_call_attempts c
        WHERE c.caller_id = ds.user_id
          AND c.void_reason IS NULL
          AND (COALESCE(c.recorded_at, c.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_from AND v_to
      ), 0) AS calls_logged,
      COALESCE((
        SELECT count(*)
        FROM public.cc_call_attempts c
        WHERE c.caller_id = ds.user_id
          AND c.void_reason IS NULL
          AND (COALESCE(c.recorded_at, c.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_from AND v_to
          AND c.outcome::text = 'engaged'
      ), 0) AS calls_answered,
      COALESCE((
        SELECT count(*)
        FROM public.staff_tasks t
        WHERE t.assigned_to = ds.user_id
          AND t.status = 'completed'
          AND (COALESCE(t.completed_at, t.updated_at, t.created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_from AND v_to
      ), 0) AS tasks_completed,
      COALESCE((
        SELECT count(*)
        FROM public.staff_tasks t
        WHERE t.assigned_to = ds.user_id
          AND t.status IN ('pending', 'in_progress')
      ), 0) AS tasks_pending
    FROM dept_staff ds
    ORDER BY calls_logged DESC, tasks_completed DESC, ds.staff_name ASC
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(member_metrics)), '[]'::jsonb),
    COALESCE(ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY calls_logged::numeric), 1), 0),
    COALESCE(ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY tasks_completed::numeric), 1), 0)
  INTO v_members, v_dept_median_calls, v_dept_median_tasks
  FROM member_metrics;

  RETURN jsonb_build_object(
    'source', 'assistant_staff_team_work_summary',
    'department', v_target_dept,
    'advisory_notice', 'Coaching suggestions only — never ratings or HR decisions.',
    'period', jsonb_build_object('from', v_from::text, 'to', v_to::text),
    'department_medians', jsonb_build_object(
      'median_calls_logged', v_dept_median_calls,
      'median_tasks_completed', v_dept_median_tasks
    ),
    'team_members', v_members
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_team_work_summary(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_staff_team_work_summary(text, date, date) TO authenticated;

-- 5. Extend `zoe_ro` with 4 read-only views for the top unanswered/missing staff-record areas
CREATE OR REPLACE VIEW zoe_ro.calling_my_space_officer_daily
WITH (security_invoker = true)
AS
SELECT
  (COALESCE(c.recorded_at, c.created_at) AT TIME ZONE 'Africa/Kampala')::date AS call_date_kampala,
  COALESCE(NULLIF(btrim(p.full_name), ''), 'Officer') AS officer_name,
  COALESCE(c.source, 'calling_center') AS queue_type,
  count(*)::integer AS total_calls,
  count(*) FILTER (
    WHERE c.outcome::text = 'engaged'
  )::integer AS answered_calls,
  count(*) FILTER (
    WHERE c.outcome::text IS DISTINCT FROM 'engaged'
  )::integer AS unanswered_calls
FROM public.cc_call_attempts c
LEFT JOIN public.profiles p ON p.id = c.caller_id
WHERE c.void_reason IS NULL
  AND c.outcome IS NOT NULL
  AND public.zoe_ro_require_area('calling')
GROUP BY 1, 2, 3;

REVOKE ALL ON TABLE zoe_ro.calling_my_space_officer_daily FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.calling_my_space_officer_daily TO authenticated;

CREATE OR REPLACE VIEW zoe_ro.tenants_directory_by_stage_and_location
WITH (security_invoker = true)
AS
SELECT
  COALESCE(NULLIF(btrim(r.request_city), ''), 'Unspecified') AS city,
  COALESCE(r.status, 'unknown') AS rent_plan_stage,
  count(*)::integer AS rent_plan_count,
  count(DISTINCT r.tenant_id)::integer AS unique_tenants,
  COALESCE(SUM(r.rent_amount), 0)::bigint AS total_principal_ugx,
  COALESCE(SUM(GREATEST(COALESCE(r.total_repayment, 0) - COALESCE(r.amount_repaid, 0), 0)), 0)::bigint AS total_outstanding_ugx
FROM public.rent_requests r
WHERE r.status IS DISTINCT FROM 'deleted_by_agent'
  AND public.zoe_ro_require_area('tenants')
GROUP BY 1, 2;

REVOKE ALL ON TABLE zoe_ro.tenants_directory_by_stage_and_location FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.tenants_directory_by_stage_and_location TO authenticated;

CREATE OR REPLACE VIEW zoe_ro.operations_desk_turnaround_summary
WITH (security_invoker = true)
AS
SELECT
  COALESCE(r.status, 'unknown') AS desk_stage,
  count(*)::integer AS open_requests_count,
  ROUND(
    AVG(EXTRACT(EPOCH FROM (now() - COALESCE(r.updated_at, r.created_at))) / 3600.0)::numeric,
    1
  ) AS avg_hours_on_desk,
  ROUND(
    MAX(EXTRACT(EPOCH FROM (now() - COALESCE(r.updated_at, r.created_at))) / 3600.0)::numeric,
    1
  ) AS max_hours_on_desk,
  COALESCE(SUM(r.rent_amount), 0)::bigint AS total_rent_ugx
FROM public.rent_requests r
WHERE r.status IN ('pending', 'tenant_ops_approved', 'agent_verified', 'landlord_ops_approved', 'coo_approved', 'approved')
  AND public.zoe_ro_require_area('operations')
GROUP BY 1;

REVOKE ALL ON TABLE zoe_ro.operations_desk_turnaround_summary FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.operations_desk_turnaround_summary TO authenticated;

CREATE OR REPLACE VIEW zoe_ro.tenants_first_seven_days_cohort
WITH (security_invoker = true)
AS
SELECT
  (COALESCE(r.disbursed_at, r.approved_at, r.updated_at, r.created_at) AT TIME ZONE 'Africa/Kampala')::date AS funded_date_kampala,
  COALESCE(NULLIF(btrim(r.request_city), ''), 'Unspecified') AS city,
  count(*)::integer AS newly_funded_plans,
  COALESCE(SUM(COALESCE(r.daily_repayment, 0) * 7), 0)::bigint AS expected_first_7d_ugx,
  COALESCE(SUM(LEAST(COALESCE(r.amount_repaid, 0), COALESCE(r.daily_repayment, 0) * 7)), 0)::bigint AS collected_first_7d_ugx,
  COALESCE(
    SUM(GREATEST((COALESCE(r.daily_repayment, 0) * 7) - COALESCE(r.amount_repaid, 0), 0)),
    0
  )::bigint AS uncollected_first_7d_ugx
FROM public.rent_requests r
WHERE r.status IN ('funded', 'disbursed', 'repaying', 'completed')
  AND COALESCE(r.disbursed_at, r.approved_at, r.updated_at, r.created_at) >= (now() - interval '30 days')
  AND public.zoe_ro_require_area('tenants')
GROUP BY 1, 2;

REVOKE ALL ON TABLE zoe_ro.tenants_first_seven_days_cohort FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.tenants_first_seven_days_cohort TO authenticated;

-- Register the 4 new views in `public.staff_assistant_data_catalog`
INSERT INTO public.staff_assistant_data_catalog (
  view_name,
  role_area,
  requires_aal2,
  title,
  description,
  use_for,
  do_not_use_for,
  official_source,
  columns
)
VALUES
  (
    'zoe_ro.calling_my_space_officer_daily',
    'calling',
    true,
    'Calling Officer Daily Breakdown',
    'Daily call attempts, answered calls, and unanswered calls grouped by calling officer name and queue type.',
    'Ad-hoc officer calling comparisons (e.g. Jane, Winnie, Hanisha) by date range when a custom grouping is needed.',
    'Official HR disciplinary decisions; use get_hr_calling_detailed_report for certified weekly/monthly reports.',
    'public.cc_call_logs',
    '["call_date_kampala","officer_name","queue_type","total_calls","answered_calls","unanswered_calls"]'::jsonb
  ),
  (
    'zoe_ro.tenants_directory_by_stage_and_location',
    'tenants',
    true,
    'Tenants Directory Summary by Stage & City',
    'Aggregated Rent Plan counts, unique tenants, principal UGX, and outstanding UGX by city and stage.',
    'Finding tenant list breakdowns by city and stage when no fixed report matches.',
    'Unmasked personal phone numbers or national IDs.',
    'public.rent_requests',
    '["city","rent_plan_stage","rent_plan_count","unique_tenants","total_principal_ugx","total_outstanding_ugx"]'::jsonb
  ),
  (
    'zoe_ro.operations_desk_turnaround_summary',
    'operations',
    true,
    'Operations Desk Turnaround & Wait Hours',
    'Open Rent Plan requests per approval desk with average and maximum hours waiting on desk.',
    'Ad-hoc bottleneck and turnaround checks across Tenant Ops, Landlord Ops, and COO desks.',
    'Individual payout authorization.',
    'public.rent_requests',
    '["desk_stage","open_requests_count","avg_hours_on_desk","max_hours_on_desk","total_rent_ugx"]'::jsonb
  ),
  (
    'zoe_ro.tenants_first_seven_days_cohort',
    'tenants',
    true,
    'First 7 Days Cohort Breakdown by Funded Date & City',
    'Newly funded Rent Plans in the last 30 days with 7-day expected, collected, and uncollected UGX by city.',
    'Ad-hoc city or cohort slice of First 7 Days performance.',
    'Replacing the certified get_tops_first_seven_summary headline.',
    'public.rent_requests',
    '["funded_date_kampala","city","newly_funded_plans","expected_first_7d_ugx","collected_first_7d_ugx","uncollected_first_7d_ugx"]'::jsonb
  )
ON CONFLICT (view_name) DO UPDATE
SET
  role_area = EXCLUDED.role_area,
  requires_aal2 = EXCLUDED.requires_aal2,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  use_for = EXCLUDED.use_for,
  do_not_use_for = EXCLUDED.do_not_use_for,
  official_source = EXCLUDED.official_source,
  columns = EXCLUDED.columns;
