-- 2026-10-26: Zoe (My Space Staff Assistant) — CRM Review Panel & Daily Budget Usage (Step 12 / Prompt 12).
--
-- Creates:
--   1. public.staff_assistant_is_crm_reviewer() — STABLE, SECURITY DEFINER, search_path = public:
--      true only for the exact roles that review Agent Assistant chats today
--      ('crm', 'cto', 'manager', 'coo', 'ceo', 'super_admin').
--   2. RLS policies on staff_assistant_conversations, staff_assistant_messages,
--      staff_assistant_feedback, and staff_assistant_unanswered so CRM reviewers can read all
--      Zoe conversations, feedback, and unanswered questions, and update unanswered status/notes
--      with server-stamped reviewed_by / reviewed_at.
--   3. public.staff_assistant_crm_review_dashboard(p_role_filter, p_only_thumbs_down,
--      p_only_unanswered, p_limit) — STABLE, SECURITY DEFINER, search_path = public:
--      returns Zoe conversations (filtered by role, thumbs-down, and "Zoe could not answer"),
--      the weekly summary of most-asked unanswered questions, and daily usage per person against
--      the budget in staff_assistant_config.
--   4. public.staff_assistant_crm_conversation_thread(p_conversation_id) — STABLE,
--      SECURITY DEFINER, search_path = public:
--      returns the ordered message thread for a Zoe conversation with thumbs up/down feedback
--      and unanswered reason metadata.

-- ---------------------------------------------------------------------------
-- 1. CRM Reviewer Gate (same roles that review agent assistant chats today)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_is_crm_reviewer()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND (
       public.has_role((SELECT auth.uid()), 'crm'::app_role)
       OR public.has_role((SELECT auth.uid()), 'cto'::app_role)
       OR public.has_role((SELECT auth.uid()), 'manager'::app_role)
       OR public.has_role((SELECT auth.uid()), 'coo'::app_role)
       OR public.has_role((SELECT auth.uid()), 'ceo'::app_role)
       OR public.has_role((SELECT auth.uid()), 'super_admin'::app_role)
     );
$function$;

COMMENT ON FUNCTION public.staff_assistant_is_crm_reviewer() IS
  'Returns true when the signed-in caller holds an enabled CRM reviewer role (crm, cto, manager, coo, ceo, super_admin) — identical to the Agent Assistant CRM review roles.';

REVOKE ALL ON FUNCTION public.staff_assistant_is_crm_reviewer() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_is_crm_reviewer() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. RLS Policies for CRM Reviewers & Server-Stamped Unanswered Review Trigger
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "CRM team reads staff_assistant_conversations" ON public.staff_assistant_conversations;
CREATE POLICY "CRM team reads staff_assistant_conversations"
  ON public.staff_assistant_conversations
  FOR SELECT TO authenticated
  USING ((SELECT public.staff_assistant_is_crm_reviewer()));

DROP POLICY IF EXISTS "CRM team reads staff_assistant_messages" ON public.staff_assistant_messages;
CREATE POLICY "CRM team reads staff_assistant_messages"
  ON public.staff_assistant_messages
  FOR SELECT TO authenticated
  USING ((SELECT public.staff_assistant_is_crm_reviewer()));

DROP POLICY IF EXISTS "CRM team reads staff_assistant_feedback" ON public.staff_assistant_feedback;
CREATE POLICY "CRM team reads staff_assistant_feedback"
  ON public.staff_assistant_feedback
  FOR SELECT TO authenticated
  USING ((SELECT public.staff_assistant_is_crm_reviewer()));

DROP POLICY IF EXISTS "CRM team reads staff_assistant_unanswered" ON public.staff_assistant_unanswered;
CREATE POLICY "CRM team reads staff_assistant_unanswered"
  ON public.staff_assistant_unanswered
  FOR SELECT TO authenticated
  USING ((SELECT public.staff_assistant_is_crm_reviewer()));

DROP POLICY IF EXISTS "CRM team updates staff_assistant_unanswered" ON public.staff_assistant_unanswered;
CREATE POLICY "CRM team updates staff_assistant_unanswered"
  ON public.staff_assistant_unanswered
  FOR UPDATE TO authenticated
  USING ((SELECT public.staff_assistant_is_crm_reviewer()))
  WITH CHECK ((SELECT public.staff_assistant_is_crm_reviewer()));

GRANT UPDATE (status, review_note) ON TABLE public.staff_assistant_unanswered TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_assistant_unanswered_stamp_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NEW.status IN ('reviewed', 'planned', 'dismissed') THEN
    IF OLD.status IS DISTINCT FROM NEW.status OR NEW.reviewed_by IS NULL THEN
      NEW.reviewed_by := auth.uid();
      NEW.reviewed_at := now();
    ELSE
      NEW.reviewed_by := OLD.reviewed_by;
      NEW.reviewed_at := OLD.reviewed_at;
    END IF;
  ELSE
    NEW.reviewed_by := NULL;
    NEW.reviewed_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_unanswered_stamp_review() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS staff_assistant_unanswered_stamp_review_trg ON public.staff_assistant_unanswered;
CREATE TRIGGER staff_assistant_unanswered_stamp_review_trg
  BEFORE UPDATE ON public.staff_assistant_unanswered
  FOR EACH ROW EXECUTE FUNCTION public.staff_assistant_unanswered_stamp_review();

-- ---------------------------------------------------------------------------
-- 3. CRM Review Dashboard RPC (conversations with filters, weekly unanswered
--    summary, and daily usage per person against staff_assistant_config budget)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_crm_review_dashboard(
  p_role_filter      text    DEFAULT NULL,
  p_only_thumbs_down boolean DEFAULT false,
  p_only_unanswered  boolean DEFAULT false,
  p_limit            integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_role_filter     text        := NULLIF(lower(btrim(COALESCE(p_role_filter, ''))), '');
  v_only_down       boolean     := COALESCE(p_only_thumbs_down, false);
  v_only_unanswered boolean     := COALESCE(p_only_unanswered, false);
  v_limit           integer     := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
  v_kampala_today   date        := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_day_start       timestamptz := ((now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala');
  v_week_cutoff     timestamptz := now() - interval '7 days';
  v_cfg             record;
  v_conversations   jsonb;
  v_weekly_unans    jsonb;
  v_daily_usage     jsonb;
  v_available_roles jsonb;
  v_summary         jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.staff_assistant_is_crm_reviewer() THEN
    RAISE EXCEPTION 'staff_assistant_crm_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF v_role_filter = 'all' THEN
    v_role_filter := NULL;
  END IF;

  SELECT
    COALESCE(c.enabled, true)               AS enabled,
    COALESCE(c.max_questions_per_day, 50)   AS max_questions_per_day,
    COALESCE(c.max_emails_per_day, 30)      AS max_emails_per_day,
    COALESCE(c.history_days, 90)            AS history_days
  INTO v_cfg
  FROM public.staff_assistant_config c
  WHERE c.id = true
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT true AS enabled, 50 AS max_questions_per_day, 30 AS max_emails_per_day, 90 AS history_days
      INTO v_cfg;
  END IF;

  -- Distinct staff roles available for filtering
  SELECT COALESCE(jsonb_agg(r.role_name ORDER BY r.role_name), '[]'::jsonb)
    INTO v_available_roles
    FROM (
      SELECT DISTINCT ur.role::text AS role_name
        FROM public.user_roles ur
       WHERE COALESCE(ur.enabled, true) = true
         AND ur.role::text NOT IN ('tenant', 'landlord', 'agent', 'supporter')
    ) r;

  -- Conversations enriched with caller roles, thumbs up/down counts, and unanswered counts
  WITH conv_enriched AS (
    SELECT
      c.id,
      c.user_id,
      COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff Member') AS full_name,
      public.assistant_real_email(p.email)                     AS email,
      p.phone                                                  AS phone,
      COALESCE(
        ARRAY(
          SELECT DISTINCT ur.role::text
            FROM public.user_roles ur
           WHERE ur.user_id = c.user_id
             AND COALESCE(ur.enabled, true) = true
             AND ur.role::text NOT IN ('tenant', 'landlord', 'agent', 'supporter')
           ORDER BY ur.role::text
        ),
        ARRAY[]::text[]
      ) AS roles,
      c.title,
      c.status,
      c.started_at,
      c.last_active_at,
      c.message_count,
      c.ip_address,
      c.user_agent,
      c.device_class,
      c.device_browser,
      c.device_os,
      COALESCE((
        SELECT count(*)::integer
          FROM public.staff_assistant_feedback f
         WHERE f.conversation_id = c.id
           AND f.rating = 'up'
      ), 0) AS thumbs_up_count,
      COALESCE((
        SELECT count(*)::integer
          FROM public.staff_assistant_feedback f
         WHERE f.conversation_id = c.id
           AND f.rating = 'down'
      ), 0) AS thumbs_down_count,
      COALESCE((
        SELECT count(*)::integer
          FROM public.staff_assistant_messages m
         WHERE m.conversation_id = c.id
           AND m.role = 'assistant'
           AND m.outcome IN ('unmatched', 'out_of_scope', 'not_staff', 'blocked', 'error')
      ), 0) AS unanswered_count,
      (
        SELECT m.content
          FROM public.staff_assistant_messages m
         WHERE m.conversation_id = c.id
           AND m.role = 'user'
         ORDER BY m.created_at DESC
         LIMIT 1
      ) AS last_question,
      (
        SELECT m.outcome
          FROM public.staff_assistant_messages m
         WHERE m.conversation_id = c.id
           AND m.role = 'assistant'
         ORDER BY m.created_at DESC
         LIMIT 1
      ) AS last_outcome
    FROM public.staff_assistant_conversations c
    LEFT JOIN public.profiles p ON p.id = c.user_id
  ),
  filtered AS (
    SELECT *
      FROM conv_enriched ce
     WHERE (v_role_filter IS NULL OR v_role_filter = ANY(ce.roles))
       AND (NOT v_only_down OR ce.thumbs_down_count > 0)
       AND (NOT v_only_unanswered OR ce.unanswered_count > 0)
     ORDER BY ce.last_active_at DESC
     LIMIT v_limit
  )
  SELECT
    jsonb_build_object(
      'total_conversations',       (SELECT count(*)::integer FROM conv_enriched),
      'thumbs_down_conversations', (SELECT count(*)::integer FROM conv_enriched WHERE thumbs_down_count > 0),
      'unanswered_conversations',  (SELECT count(*)::integer FROM conv_enriched WHERE unanswered_count > 0),
      'open_unanswered_questions', (SELECT count(*)::integer FROM public.staff_assistant_unanswered WHERE status = 'open'),
      'questions_asked_today',     (SELECT count(*)::integer FROM public.staff_assistant_messages WHERE role = 'user' AND created_at >= v_day_start),
      'emails_sent_today',         (SELECT count(*)::integer FROM public.system_events WHERE event_type = 'zoe_report_email_sent' AND created_at >= v_day_start)
    ),
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id',                f.id,
          'user_id',           f.user_id,
          'full_name',         f.full_name,
          'email',             f.email,
          'phone',             f.phone,
          'roles',             to_jsonb(f.roles),
          'title',             f.title,
          'status',            f.status,
          'started_at',        f.started_at,
          'last_active_at',    f.last_active_at,
          'message_count',     f.message_count,
          'thumbs_up_count',   f.thumbs_up_count,
          'thumbs_down_count', f.thumbs_down_count,
          'unanswered_count',  f.unanswered_count,
          'last_question',     f.last_question,
          'last_outcome',      f.last_outcome,
          'ip_address',        f.ip_address,
          'user_agent',        f.user_agent,
          'device_class',      f.device_class,
          'device_browser',    f.device_browser,
          'device_os',         f.device_os
        )
        ORDER BY f.last_active_at DESC
      )
      FROM filtered f
    ), '[]'::jsonb)
  INTO v_summary, v_conversations;

  -- Weekly summary of most-asked unanswered questions (last 7 days)
  WITH recent_unans AS (
    SELECT
      u.id,
      u.conversation_id,
      u.user_id,
      u.caller_roles,
      btrim(u.question_text) AS question_text,
      lower(regexp_replace(btrim(u.question_text), '\s+', ' ', 'g')) AS norm_q,
      u.reason,
      u.status,
      u.review_note,
      u.created_at
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_week_cutoff
      AND (v_role_filter IS NULL OR v_role_filter = ANY(u.caller_roles))
  ),
  grouped_unans AS (
    SELECT
      (ARRAY_AGG(r.question_text ORDER BY r.created_at DESC))[1]    AS question_text,
      (ARRAY_AGG(r.reason ORDER BY r.created_at DESC))[1]           AS reason,
      count(*)::integer                                             AS ask_count,
      count(DISTINCT r.user_id)::integer                            AS unique_staff_count,
      ARRAY(
        SELECT DISTINCT rl
          FROM recent_unans r2,
               LATERAL unnest(r2.caller_roles) AS rl
         WHERE r2.norm_q = r.norm_q
         ORDER BY rl
      )                                                             AS roles_asking,
      max(r.created_at)                                             AS latest_asked_at,
      count(*) FILTER (WHERE r.status = 'open')::integer            AS open_count,
      (ARRAY_AGG(r.id ORDER BY r.created_at DESC))[1]               AS sample_id,
      (ARRAY_AGG(r.conversation_id ORDER BY r.created_at DESC))[1]  AS sample_conversation_id,
      (ARRAY_AGG(r.status ORDER BY r.created_at DESC))[1]           AS status,
      (ARRAY_AGG(r.review_note ORDER BY r.created_at DESC))[1]      AS review_note
    FROM recent_unans r
    GROUP BY r.norm_q
    ORDER BY count(*) DESC, max(r.created_at) DESC
    LIMIT 50
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question_text',          g.question_text,
        'reason',                 g.reason,
        'ask_count',              g.ask_count,
        'unique_staff_count',     g.unique_staff_count,
        'roles_asking',           to_jsonb(g.roles_asking),
        'latest_asked_at',        g.latest_asked_at,
        'open_count',             g.open_count,
        'sample_id',              g.sample_id,
        'sample_conversation_id', g.sample_conversation_id,
        'status',                 g.status,
        'review_note',            g.review_note
      )
      ORDER BY g.ask_count DESC, g.latest_asked_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_weekly_unans
  FROM grouped_unans g;

  -- Daily usage per person today (Kampala time) against budget in staff_assistant_config
  WITH questions_today AS (
    SELECT
      m.user_id,
      count(*)::integer  AS questions_count,
      max(m.created_at)  AS last_question_at
    FROM public.staff_assistant_messages m
    WHERE m.role = 'user'
      AND m.created_at >= v_day_start
    GROUP BY m.user_id
  ),
  emails_today AS (
    SELECT
      se.user_id,
      count(*)::integer  AS emails_count,
      max(se.created_at) AS last_email_at
    FROM public.system_events se
    WHERE se.event_type = 'zoe_report_email_sent'
      AND se.created_at >= v_day_start
      AND se.user_id IS NOT NULL
    GROUP BY se.user_id
  ),
  active_conv_users AS (
    SELECT
      c.user_id,
      max(c.last_active_at) AS last_active_at
    FROM public.staff_assistant_conversations c
    GROUP BY c.user_id
  ),
  all_zoe_users AS (
    SELECT user_id FROM questions_today
    UNION
    SELECT user_id FROM emails_today
    UNION
    SELECT user_id FROM active_conv_users
  ),
  per_person AS (
    SELECT
      u.user_id,
      COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff Member') AS full_name,
      public.assistant_real_email(p.email)                     AS email,
      COALESCE(
        ARRAY(
          SELECT DISTINCT ur.role::text
            FROM public.user_roles ur
           WHERE ur.user_id = u.user_id
             AND COALESCE(ur.enabled, true) = true
             AND ur.role::text NOT IN ('tenant', 'landlord', 'agent', 'supporter')
           ORDER BY ur.role::text
        ),
        ARRAY[]::text[]
      ) AS roles,
      COALESCE(qt.questions_count, 0)                          AS questions_today,
      v_cfg.max_questions_per_day                              AS max_questions_per_day,
      GREATEST(v_cfg.max_questions_per_day - COALESCE(qt.questions_count, 0), 0) AS questions_remaining,
      ROUND(
        (COALESCE(qt.questions_count, 0)::numeric / GREATEST(v_cfg.max_questions_per_day, 1)::numeric) * 100,
        1
      )                                                        AS budget_utilization_pct,
      COALESCE(et.emails_count, 0)                             AS emails_today,
      v_cfg.max_emails_per_day                                 AS max_emails_per_day,
      GREATEST(
        COALESCE(qt.last_question_at, 'epoch'::timestamptz),
        COALESCE(et.last_email_at, 'epoch'::timestamptz),
        COALESCE(ac.last_active_at, 'epoch'::timestamptz)
      )                                                        AS last_active_at
    FROM all_zoe_users u
    LEFT JOIN questions_today qt   ON qt.user_id = u.user_id
    LEFT JOIN emails_today et      ON et.user_id = u.user_id
    LEFT JOIN active_conv_users ac ON ac.user_id = u.user_id
    LEFT JOIN public.profiles p    ON p.id = u.user_id
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'user_id',                pp.user_id,
        'full_name',              pp.full_name,
        'email',                  pp.email,
        'roles',                  to_jsonb(pp.roles),
        'questions_today',        pp.questions_today,
        'max_questions_per_day',  pp.max_questions_per_day,
        'questions_remaining',    pp.questions_remaining,
        'budget_utilization_pct', pp.budget_utilization_pct,
        'emails_today',           pp.emails_today,
        'max_emails_per_day',     pp.max_emails_per_day,
        'last_active_at',         pp.last_active_at
      )
      ORDER BY pp.questions_today DESC, pp.emails_today DESC, pp.last_active_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_daily_usage
  FROM per_person pp
  WHERE v_role_filter IS NULL OR v_role_filter = ANY(pp.roles);

  RETURN jsonb_build_object(
    'as_of_date',                v_kampala_today,
    'config', jsonb_build_object(
      'enabled',                 v_cfg.enabled,
      'max_questions_per_day',   v_cfg.max_questions_per_day,
      'max_emails_per_day',      v_cfg.max_emails_per_day,
      'history_days',            v_cfg.history_days
    ),
    'summary',                   v_summary,
    'available_roles',           v_available_roles,
    'conversations',             v_conversations,
    'weekly_unanswered_summary', v_weekly_unans,
    'daily_usage_per_person',    v_daily_usage
  );
END;
$function$;

COMMENT ON FUNCTION public.staff_assistant_crm_review_dashboard(text, boolean, boolean, integer) IS
  'CRM reviewer dashboard for Zoe conversations: role/thumbs-down/unanswered filters, weekly top unanswered questions, and daily usage per person against staff_assistant_config.';

REVOKE ALL ON FUNCTION public.staff_assistant_crm_review_dashboard(text, boolean, boolean, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_crm_review_dashboard(text, boolean, boolean, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. CRM Conversation Thread RPC (messages + thumbs feedback + unanswered info)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_crm_conversation_thread(
  p_conversation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_messages jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.staff_assistant_is_crm_reviewer() THEN
    RAISE EXCEPTION 'staff_assistant_crm_not_authorized' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',                m.id,
        'conversation_id',   m.conversation_id,
        'user_id',           m.user_id,
        'role',              m.role,
        'content',           m.content,
        'outcome',           m.outcome,
        'tools_called',      to_jsonb(COALESCE(m.tools_called, ARRAY[]::text[])),
        'source_label',      m.source_label,
        'period_label',      m.period_label,
        'model',             m.model,
        'latency_ms',        m.latency_ms,
        'created_at',        m.created_at,
        'feedback_rating',   fb.rating,
        'feedback_comment',  fb.comment,
        'unanswered_reason', ua.reason,
        'unanswered_status', ua.status,
        'unanswered_id',     ua.id
      )
      ORDER BY m.created_at ASC
    ),
    '[]'::jsonb
  )
  INTO v_messages
  FROM public.staff_assistant_messages m
  LEFT JOIN LATERAL (
    SELECT f.rating, f.comment
      FROM public.staff_assistant_feedback f
     WHERE f.message_id = m.id
     ORDER BY f.updated_at DESC
     LIMIT 1
  ) fb ON true
  LEFT JOIN LATERAL (
    SELECT u.id, u.reason, u.status
      FROM public.staff_assistant_unanswered u
     WHERE u.message_id = m.id
     ORDER BY u.created_at DESC
     LIMIT 1
  ) ua ON true
  WHERE m.conversation_id = p_conversation_id;

  RETURN jsonb_build_object(
    'conversation_id', p_conversation_id,
    'messages',        v_messages
  );
END;
$function$;

COMMENT ON FUNCTION public.staff_assistant_crm_conversation_thread(uuid) IS
  'Returns the ordered message thread for a Zoe conversation for authorized CRM reviewers.';

REVOKE ALL ON FUNCTION public.staff_assistant_crm_conversation_thread(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_crm_conversation_thread(uuid) TO authenticated;
