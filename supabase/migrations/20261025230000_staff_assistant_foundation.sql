-- 2026-10-25: Zoe (My Space Staff AI Assistant) — Database Foundation (Step 1 / Prompt 2).
--
-- Creates:
--   1. public.staff_assistant_config (single row id = true: enabled, max_questions_per_day = 50,
--      max_emails_per_day = 30, history_days = 90).
--   2. public.staff_assistant_conversations and public.staff_assistant_messages
--      (owner = auth.uid(); RLS so each staff member reads only their own rows; CRM / executive
--      reviewers read for quality review; written by the staff-assistant edge function via service_role).
--   3. public.staff_assistant_feedback (thumbs up/down on Zoe messages; owner = auth.uid()) and
--      public.staff_assistant_unanswered (questions Zoe could not answer; owner = auth.uid()).
--   4. public.staff_assistant_has_access() — STABLE, SECURITY DEFINER, search_path = public:
--      true when Zoe is enabled in staff_assistant_config and the caller holds an enabled staff role
--      (public.is_welile_staff(auth.uid()) or enabled role in tenant_ops, landlord_ops, agent_ops,
--      financial_ops, partner_ops, hr, access_admin).
--   5. public.staff_assistant_require_staff() — STABLE, SECURITY DEFINER, search_path = public:
--      raises 28000 when unauthenticated or 42501 when staff_assistant_has_access() is false.
--   6. Daily retention cleanup function public.staff_assistant_purge_old_history() + pg_cron job
--      'staff-assistant-purge-old-history' that deletes Zoe messages (and empty expired conversations)
--      older than staff_assistant_config.history_days.
--
-- Security & RLS invariants:
--   - Every new table has RLS enabled, explicit REVOKE/GRANT, and the restrictive
--     mfa_required_for_staff policy using ((select public.staff_mfa_ok())).
--   - Ownership policies wrap auth.uid() as (select auth.uid()) for initplan evaluation.
--   - Functions revoke EXECUTE from PUBLIC, anon and grant EXECUTE to authenticated only.

-- ---------------------------------------------------------------------------
-- 1. Single-row configuration table: public.staff_assistant_config
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_config (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled                boolean NOT NULL DEFAULT true,
  max_questions_per_day  integer NOT NULL DEFAULT 50 CHECK (max_questions_per_day >= 1 AND max_questions_per_day <= 1000),
  max_emails_per_day     integer NOT NULL DEFAULT 30 CHECK (max_emails_per_day >= 0 AND max_emails_per_day <= 500),
  history_days           integer NOT NULL DEFAULT 90 CHECK (history_days >= 1 AND history_days <= 3650),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid
);

COMMENT ON TABLE public.staff_assistant_config IS
  'Single-row configuration for Zoe (My Space staff assistant): kill switch, daily question/email budgets, and retention window.';

INSERT INTO public.staff_assistant_config (id, enabled, max_questions_per_day, max_emails_per_day, history_days)
VALUES (true, true, 50, 30, 90)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Access gate functions: staff_assistant_has_access() & staff_assistant_require_staff()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_has_access()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND COALESCE((SELECT c.enabled FROM public.staff_assistant_config c WHERE c.id = true), false) = true
     AND (
       public.is_welile_staff((SELECT auth.uid()))
       OR EXISTS (
         SELECT 1
           FROM public.user_roles ur
          WHERE ur.user_id = (SELECT auth.uid())
            AND COALESCE(ur.enabled, true) = true
            AND ur.role::text IN (
              'tenant_ops',
              'landlord_ops',
              'agent_ops',
              'financial_ops',
              'partner_ops',
              'hr',
              'access_admin'
            )
       )
     );
$function$;

COMMENT ON FUNCTION public.staff_assistant_has_access() IS
  'Returns true when Zoe (staff_assistant_config.enabled) is on and the authenticated caller holds an enabled staff role.';

CREATE OR REPLACE FUNCTION public.staff_assistant_require_staff()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.staff_assistant_require_staff() IS
  'Raises 28000 if unauthenticated or 42501 if staff_assistant_has_access() is false.';

REVOKE ALL ON FUNCTION public.staff_assistant_has_access() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_has_access() TO authenticated;

REVOKE ALL ON FUNCTION public.staff_assistant_require_staff() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_require_staff() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Conversation & message tables: staff_assistant_conversations & staff_assistant_messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL DEFAULT auth.uid(),
  persona          text NOT NULL DEFAULT 'staff' CHECK (persona IN ('staff')),
  title            text CHECK (title IS NULL OR char_length(title) <= 200),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_active_at   timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  message_count    integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  ip_address       text CHECK (ip_address IS NULL OR char_length(ip_address) <= 64),
  user_agent       text CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  device_class     text CHECK (device_class IS NULL OR char_length(device_class) <= 32),
  device_browser   text CHECK (device_browser IS NULL OR char_length(device_browser) <= 64),
  device_os        text CHECK (device_os IS NULL OR char_length(device_os) <= 64)
);

COMMENT ON TABLE public.staff_assistant_conversations IS
  'Zoe conversation sessions in My Space. Owner is user_id = auth.uid().';

CREATE TABLE IF NOT EXISTS public.staff_assistant_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES public.staff_assistant_conversations (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL DEFAULT auth.uid(),
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL CHECK (char_length(content) <= 8000),
  outcome          text CHECK (outcome IS NULL OR outcome IN (
                     'answered', 'clarify', 'out_of_scope', 'not_staff',
                     'unmatched', 'rate_limited', 'blocked', 'error')),
  tools_called     text[] NOT NULL DEFAULT '{}',
  source_label     text CHECK (source_label IS NULL OR char_length(source_label) <= 240),
  period_label     text CHECK (period_label IS NULL OR char_length(period_label) <= 120),
  report_payload   jsonb,
  model            text CHECK (model IS NULL OR char_length(model) <= 120),
  latency_ms       integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_messages IS
  'Individual user and assistant turns in Zoe conversations. Automatically purged after staff_assistant_config.history_days.';

CREATE INDEX IF NOT EXISTS staff_assistant_conversations_user_idx
  ON public.staff_assistant_conversations (user_id, last_active_at DESC);

CREATE INDEX IF NOT EXISTS staff_assistant_messages_conversation_idx
  ON public.staff_assistant_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS staff_assistant_messages_user_recent_idx
  ON public.staff_assistant_messages (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS staff_assistant_messages_created_at_idx
  ON public.staff_assistant_messages (created_at);

-- ---------------------------------------------------------------------------
-- 4. Quality & learning tables: staff_assistant_feedback & staff_assistant_unanswered
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_feedback (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES public.staff_assistant_conversations (id) ON DELETE CASCADE,
  message_id       uuid NOT NULL REFERENCES public.staff_assistant_messages (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL DEFAULT auth.uid(),
  rating           text NOT NULL CHECK (rating IN ('up', 'down')),
  comment          text CHECK (comment IS NULL OR char_length(comment) <= 1000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

COMMENT ON TABLE public.staff_assistant_feedback IS
  'Thumbs up/down feedback given by staff on Zoe answers.';

DROP TRIGGER IF EXISTS staff_assistant_feedback_touch_updated_at ON public.staff_assistant_feedback;
CREATE TRIGGER staff_assistant_feedback_touch_updated_at
  BEFORE UPDATE ON public.staff_assistant_feedback
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS staff_assistant_feedback_user_idx
  ON public.staff_assistant_feedback (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS staff_assistant_feedback_rating_idx
  ON public.staff_assistant_feedback (rating, created_at DESC);

CREATE TABLE IF NOT EXISTS public.staff_assistant_unanswered (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid REFERENCES public.staff_assistant_conversations (id) ON DELETE SET NULL,
  message_id       uuid REFERENCES public.staff_assistant_messages (id) ON DELETE SET NULL,
  user_id          uuid NOT NULL DEFAULT auth.uid(),
  caller_roles     text[] NOT NULL DEFAULT '{}',
  question_text    text NOT NULL CHECK (char_length(question_text) <= 2000),
  reason           text NOT NULL DEFAULT 'unmatched' CHECK (reason IN (
                     'unmatched', 'missing_tool', 'role_restricted', 'out_of_scope', 'error')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'planned', 'dismissed')),
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  review_note      text CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_unanswered IS
  'Questions Zoe could not answer or had to refuse, used to prioritize new official report tools.';

CREATE INDEX IF NOT EXISTS staff_assistant_unanswered_user_idx
  ON public.staff_assistant_unanswered (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS staff_assistant_unanswered_status_idx
  ON public.staff_assistant_unanswered (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Row-Level Security, mfa_required_for_staff & explicit table grants
-- ---------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_config         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_assistant_conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_assistant_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_assistant_feedback       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_assistant_unanswered     ENABLE ROW LEVEL SECURITY;

-- Restrictive staff MFA gate on all 5 tables (Phase 0 / Phase 2 enforcement standard)
DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_config;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_config
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_conversations;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_conversations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_messages;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_messages
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_feedback;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_feedback
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_unanswered;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_unanswered
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

-- Config: readable by authenticated staff who pass staff_assistant_has_access()
DROP POLICY IF EXISTS "Staff read staff_assistant_config" ON public.staff_assistant_config;
CREATE POLICY "Staff read staff_assistant_config"
  ON public.staff_assistant_config
  FOR SELECT TO authenticated
  USING ((SELECT public.staff_assistant_has_access()));

-- Conversations: each person reads only their own (plus delete own for "Clear my history")
DROP POLICY IF EXISTS "Staff read own staff_assistant_conversations" ON public.staff_assistant_conversations;
CREATE POLICY "Staff read own staff_assistant_conversations"
  ON public.staff_assistant_conversations
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff delete own staff_assistant_conversations" ON public.staff_assistant_conversations;
CREATE POLICY "Staff delete own staff_assistant_conversations"
  ON public.staff_assistant_conversations
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Messages: each person reads (and can clear) only their own
DROP POLICY IF EXISTS "Staff read own staff_assistant_messages" ON public.staff_assistant_messages;
CREATE POLICY "Staff read own staff_assistant_messages"
  ON public.staff_assistant_messages
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff delete own staff_assistant_messages" ON public.staff_assistant_messages;
CREATE POLICY "Staff delete own staff_assistant_messages"
  ON public.staff_assistant_messages
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Feedback: each person reads, inserts, and updates only their own feedback on their own messages
DROP POLICY IF EXISTS "Staff read own staff_assistant_feedback" ON public.staff_assistant_feedback;
CREATE POLICY "Staff read own staff_assistant_feedback"
  ON public.staff_assistant_feedback
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff insert own staff_assistant_feedback" ON public.staff_assistant_feedback;
CREATE POLICY "Staff insert own staff_assistant_feedback"
  ON public.staff_assistant_feedback
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (SELECT public.staff_assistant_has_access())
    AND EXISTS (
      SELECT 1
        FROM public.staff_assistant_messages m
       WHERE m.id = message_id
         AND m.conversation_id = staff_assistant_feedback.conversation_id
         AND m.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Staff update own staff_assistant_feedback" ON public.staff_assistant_feedback;
CREATE POLICY "Staff update own staff_assistant_feedback"
  ON public.staff_assistant_feedback
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

-- Unanswered: each person reads only their own rows
DROP POLICY IF EXISTS "Staff read own staff_assistant_unanswered" ON public.staff_assistant_unanswered;
CREATE POLICY "Staff read own staff_assistant_unanswered"
  ON public.staff_assistant_unanswered
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Table grants: anon gets nothing; authenticated gets only the exact privileges permitted by RLS
REVOKE ALL ON TABLE public.staff_assistant_config        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staff_assistant_conversations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staff_assistant_messages      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staff_assistant_feedback      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staff_assistant_unanswered    FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.staff_assistant_config TO authenticated;
GRANT SELECT, DELETE ON TABLE public.staff_assistant_conversations TO authenticated;
GRANT SELECT, DELETE ON TABLE public.staff_assistant_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE (rating, comment, updated_at) ON TABLE public.staff_assistant_feedback TO authenticated;
GRANT SELECT ON TABLE public.staff_assistant_unanswered TO authenticated;

GRANT ALL ON TABLE public.staff_assistant_config        TO service_role;
GRANT ALL ON TABLE public.staff_assistant_conversations TO service_role;
GRANT ALL ON TABLE public.staff_assistant_messages      TO service_role;
GRANT ALL ON TABLE public.staff_assistant_feedback      TO service_role;
GRANT ALL ON TABLE public.staff_assistant_unanswered    TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Daily retention cleanup (> history_days) & pg_cron schedule
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_purge_old_history()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_days    integer;
  v_cutoff  timestamptz;
  v_deleted integer := 0;
BEGIN
  SELECT COALESCE(c.history_days, 90)
    INTO v_days
    FROM public.staff_assistant_config c
   WHERE c.id = true;

  v_days   := GREATEST(COALESCE(v_days, 90), 1);
  v_cutoff := now() - make_interval(days => v_days);

  DELETE FROM public.staff_assistant_messages m
   WHERE m.created_at < v_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  DELETE FROM public.staff_assistant_conversations c
   WHERE c.last_active_at < v_cutoff
     AND NOT EXISTS (
       SELECT 1
         FROM public.staff_assistant_messages m
        WHERE m.conversation_id = c.id
     );

  RETURN v_deleted;
END;
$function$;

COMMENT ON FUNCTION public.staff_assistant_purge_old_history() IS
  'Deletes staff_assistant_messages older than staff_assistant_config.history_days (default 90 days) and prunes empty expired conversations.';

-- Internal maintenance function: callable only by postgres / pg_cron (not exposed to clients)
REVOKE ALL ON FUNCTION public.staff_assistant_purge_old_history() FROM PUBLIC, anon, authenticated, service_role;

DO $cron$
DECLARE
  v_job_id bigint;
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    FOR v_job_id IN
      SELECT jobid FROM cron.job WHERE jobname = 'staff-assistant-purge-old-history'
    LOOP
      PERFORM cron.unschedule(v_job_id);
    END LOOP;

    PERFORM cron.schedule(
      'staff-assistant-purge-old-history',
      '25 0 * * *',
      'SELECT public.staff_assistant_purge_old_history();'
    );
  END IF;
END
$cron$;
