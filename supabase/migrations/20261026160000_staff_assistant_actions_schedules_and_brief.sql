-- 2026-10-26: Zoe (My Space Staff Assistant) — Reminders, Colleague Notifications,
-- Scheduled Report Emails, and Morning Brief Preferences (Prompt 13).
--
-- Creates:
--   1. Updated public.block_all_notification_inserts() allowing 'staff_assistant' and
--      'staff_assistant_reminder' in-app notifications in public.notifications.
--   2. public.staff_assistant_reminders (owner = auth.uid(), RLS, mfa_required_for_staff, grants).
--   3. public.staff_assistant_schedules (owner = auth.uid(), RLS, mfa_required_for_staff, grants)
--      for daily/weekly scheduled report emails to active Welile staff only.
--   4. public.staff_assistant_preferences (owner = auth.uid(), RLS, mfa_required_for_staff, grants)
--      storing per-person optional 07:30 Kampala morning brief settings (off by default).
--   5. Read-only Zoe tool public.assistant_staff_my_reminders_and_schedules(p_include_cancelled)
--      (STABLE, SECURITY DEFINER, search_path = public, authenticated only).
--   6. Click-confirmed action RPCs (authenticated only, gated by staff_assistant_has_access()):
--      - public.staff_assistant_create_reminder(...)
--      - public.staff_assistant_cancel_reminder(p_reminder_id)
--      - public.staff_assistant_send_colleague_notification(...)
--      - public.staff_assistant_create_schedule(...)
--      - public.staff_assistant_cancel_schedule(p_schedule_id)
--      - public.staff_assistant_set_morning_brief_prefs(...)
--   7. Cron helper RPCs (service_role only) for the scheduled-report & reminder runner:
--      - public.staff_assistant_check_owner_access(p_owner_id)
--      - public.staff_assistant_run_scheduled_report_as_owner(p_owner_id, p_report_rpc, p_report_args)
--      - public.staff_assistant_dispatch_due_reminders()

-- ---------------------------------------------------------------------------
-- 1. Allow 'staff_assistant' and 'staff_assistant_reminder' in public.notifications
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN (
    'merchandise_recovery','director_requisition','advance_arrears','budget',
    'staff_requisition','hr_birthday','rd_alert','lending_repayment',
    'float','bike_lease_reminder','wallet_transfer_reversal',
    'security','staff_assistant','staff_assistant_reminder'
  ) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'action','') IN ('listing_rejected','subagent_listing_rejected') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'kind','') = 'landlord_payout_rejected' THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Personal Reminders Table: public.staff_assistant_reminders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_reminders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL DEFAULT auth.uid(),
  title            text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 240),
  note             text CHECK (note IS NULL OR char_length(note) <= 1000),
  remind_at        timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'notified', 'completed', 'cancelled')),
  notified_at      timestamptz,
  cancelled_at     timestamptz,
  conversation_id  uuid REFERENCES public.staff_assistant_conversations(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_reminders IS
  'Personal reminders created by a staff member in Zoe after clicking Confirm on a reminder draft card. Owner is user_id = auth.uid().';

CREATE INDEX IF NOT EXISTS staff_assistant_reminders_user_status_idx
  ON public.staff_assistant_reminders (user_id, status, remind_at ASC);

CREATE INDEX IF NOT EXISTS staff_assistant_reminders_due_idx
  ON public.staff_assistant_reminders (remind_at ASC)
  WHERE status = 'scheduled';

DROP TRIGGER IF EXISTS staff_assistant_reminders_touch_updated_at ON public.staff_assistant_reminders;
CREATE TRIGGER staff_assistant_reminders_touch_updated_at
  BEFORE UPDATE ON public.staff_assistant_reminders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 3. Scheduled Report Emails Table: public.staff_assistant_schedules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL DEFAULT auth.uid(),
  title               text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 200),
  report_tool         text NOT NULL CHECK (char_length(trim(report_tool)) BETWEEN 1 AND 120),
  report_rpc          text NOT NULL CHECK (report_rpc ~ '^assistant_staff_[a-z0-9_]+$'),
  report_args         jsonb NOT NULL DEFAULT '{}'::jsonb,
  frequency           text NOT NULL CHECK (frequency IN ('daily', 'weekly')),
  day_of_week         integer CHECK (day_of_week IS NULL OR (day_of_week BETWEEN 0 AND 6)),
  send_time_kampala   text NOT NULL DEFAULT '07:30'
                      CHECK (send_time_kampala ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  recipient_emails    text[] NOT NULL
                      CHECK (coalesce(array_length(recipient_emails, 1), 0) BETWEEN 1 AND 10),
  recipient_names     text[] NOT NULL DEFAULT '{}',
  custom_message      text CHECK (custom_message IS NULL OR char_length(custom_message) <= 1000),
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'cancelled')),
  last_run_at         timestamptz,
  last_run_status     text CHECK (last_run_status IS NULL OR char_length(last_run_status) <= 160),
  next_run_at         timestamptz NOT NULL,
  run_count           integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  cancelled_at        timestamptz,
  conversation_id     uuid REFERENCES public.staff_assistant_conversations(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_schedules IS
  'Recurring daily/weekly Zoe report email schedules. Owner is user_id = auth.uid(). Every run re-checks owner access and recipient staff status.';

CREATE INDEX IF NOT EXISTS staff_assistant_schedules_user_status_idx
  ON public.staff_assistant_schedules (user_id, status, next_run_at ASC);

CREATE INDEX IF NOT EXISTS staff_assistant_schedules_due_idx
  ON public.staff_assistant_schedules (next_run_at ASC)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS staff_assistant_schedules_touch_updated_at ON public.staff_assistant_schedules;
CREATE TRIGGER staff_assistant_schedules_touch_updated_at
  BEFORE UPDATE ON public.staff_assistant_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 4. Per-Person Preferences Table (Morning Brief): public.staff_assistant_preferences
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_preferences (
  user_id                       uuid PRIMARY KEY DEFAULT auth.uid(),
  morning_brief_enabled         boolean NOT NULL DEFAULT false,
  morning_brief_time            text NOT NULL DEFAULT '07:30'
                                CHECK (morning_brief_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  last_brief_kampala_date       date,
  dismissed_brief_kampala_date  date,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_preferences IS
  'Per-staff Zoe preferences including the optional 07:30 Kampala morning brief (off by default, turned on per person).';

DROP TRIGGER IF EXISTS staff_assistant_preferences_touch_updated_at ON public.staff_assistant_preferences;
CREATE TRIGGER staff_assistant_preferences_touch_updated_at
  BEFORE UPDATE ON public.staff_assistant_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 5. RLS, mfa_required_for_staff policies, and explicit table grants
-- ---------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_reminders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_assistant_schedules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_assistant_preferences  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_reminders;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_reminders
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_schedules;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_schedules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_preferences;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_preferences
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

-- Owner policies for staff_assistant_reminders
DROP POLICY IF EXISTS "Staff read own staff_assistant_reminders" ON public.staff_assistant_reminders;
CREATE POLICY "Staff read own staff_assistant_reminders"
  ON public.staff_assistant_reminders
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

DROP POLICY IF EXISTS "Staff insert own staff_assistant_reminders" ON public.staff_assistant_reminders;
CREATE POLICY "Staff insert own staff_assistant_reminders"
  ON public.staff_assistant_reminders
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

DROP POLICY IF EXISTS "Staff update own staff_assistant_reminders" ON public.staff_assistant_reminders;
CREATE POLICY "Staff update own staff_assistant_reminders"
  ON public.staff_assistant_reminders
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()))
  WITH CHECK (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

DROP POLICY IF EXISTS "Staff delete own staff_assistant_reminders" ON public.staff_assistant_reminders;
CREATE POLICY "Staff delete own staff_assistant_reminders"
  ON public.staff_assistant_reminders
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

-- Owner policies for staff_assistant_schedules
DROP POLICY IF EXISTS "Staff read own staff_assistant_schedules" ON public.staff_assistant_schedules;
CREATE POLICY "Staff read own staff_assistant_schedules"
  ON public.staff_assistant_schedules
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

DROP POLICY IF EXISTS "Staff insert own staff_assistant_schedules" ON public.staff_assistant_schedules;
CREATE POLICY "Staff insert own staff_assistant_schedules"
  ON public.staff_assistant_schedules
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

DROP POLICY IF EXISTS "Staff update own staff_assistant_schedules" ON public.staff_assistant_schedules;
CREATE POLICY "Staff update own staff_assistant_schedules"
  ON public.staff_assistant_schedules
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()))
  WITH CHECK (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

DROP POLICY IF EXISTS "Staff delete own staff_assistant_schedules" ON public.staff_assistant_schedules;
CREATE POLICY "Staff delete own staff_assistant_schedules"
  ON public.staff_assistant_schedules
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

-- Owner policies for staff_assistant_preferences
DROP POLICY IF EXISTS "Staff read own staff_assistant_preferences" ON public.staff_assistant_preferences;
CREATE POLICY "Staff read own staff_assistant_preferences"
  ON public.staff_assistant_preferences
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

DROP POLICY IF EXISTS "Staff insert own staff_assistant_preferences" ON public.staff_assistant_preferences;
CREATE POLICY "Staff insert own staff_assistant_preferences"
  ON public.staff_assistant_preferences
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

DROP POLICY IF EXISTS "Staff update own staff_assistant_preferences" ON public.staff_assistant_preferences;
CREATE POLICY "Staff update own staff_assistant_preferences"
  ON public.staff_assistant_preferences
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()))
  WITH CHECK (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

-- Explicit grants
REVOKE ALL ON TABLE public.staff_assistant_reminders   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staff_assistant_schedules   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staff_assistant_preferences FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_assistant_reminders   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_assistant_schedules   TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON TABLE public.staff_assistant_preferences TO authenticated;

GRANT ALL ON TABLE public.staff_assistant_reminders   TO service_role;
GRANT ALL ON TABLE public.staff_assistant_schedules   TO service_role;
GRANT ALL ON TABLE public.staff_assistant_preferences TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Read-only Zoe tool: public.assistant_staff_my_reminders_and_schedules
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_reminders_and_schedules(
  p_include_cancelled boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_today      date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_reminders  jsonb;
  v_schedules  jsonb;
  v_combined   jsonb;
  v_prefs      record;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb), '[]'::jsonb)
    INTO v_reminders
    FROM (
      SELECT
        rem.id,
        'reminder'::text AS item_type,
        rem.title,
        rem.note,
        rem.remind_at,
        to_char(rem.remind_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD HH24:MI') AS remind_at_kampala,
        rem.status,
        rem.notified_at,
        rem.cancelled_at,
        rem.created_at
      FROM public.staff_assistant_reminders rem
      WHERE rem.user_id = v_uid
        AND (COALESCE(p_include_cancelled, false) = true OR rem.status <> 'cancelled')
      ORDER BY rem.remind_at ASC, rem.created_at DESC
      LIMIT 100
    ) r;

  SELECT COALESCE(jsonb_agg(row_to_json(s)::jsonb), '[]'::jsonb)
    INTO v_schedules
    FROM (
      SELECT
        sch.id,
        'schedule'::text AS item_type,
        sch.title,
        sch.report_tool,
        sch.report_rpc,
        sch.report_args,
        sch.frequency,
        sch.day_of_week,
        sch.send_time_kampala,
        sch.recipient_emails,
        sch.recipient_names,
        sch.custom_message,
        sch.status,
        sch.last_run_at,
        sch.last_run_status,
        sch.next_run_at,
        to_char(sch.next_run_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD HH24:MI') AS next_run_kampala,
        sch.run_count,
        sch.cancelled_at,
        sch.created_at
      FROM public.staff_assistant_schedules sch
      WHERE sch.user_id = v_uid
        AND (COALESCE(p_include_cancelled, false) = true OR sch.status <> 'cancelled')
      ORDER BY sch.next_run_at ASC, sch.created_at DESC
      LIMIT 100
    ) s;

  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    INTO v_combined
    FROM (
      SELECT elem FROM jsonb_array_elements(v_schedules) AS elem
      UNION ALL
      SELECT elem FROM jsonb_array_elements(v_reminders) AS elem
      LIMIT 200
    ) u;

  SELECT
    p.morning_brief_enabled,
    p.morning_brief_time,
    p.last_brief_kampala_date,
    p.dismissed_brief_kampala_date
    INTO v_prefs
    FROM public.staff_assistant_preferences p
   WHERE p.user_id = v_uid;

  RETURN jsonb_build_object(
    'source', 'My Space Zoe Reminders & Report Schedules (staff_assistant_reminders, staff_assistant_schedules)',
    'period', jsonb_build_object('as_of', v_today::text),
    'row_count', jsonb_array_length(v_combined),
    'rows', v_combined,
    'reminders', v_reminders,
    'schedules', v_schedules,
    'data', jsonb_build_object(
      'active_reminders_count', (
        SELECT count(*)::int
          FROM public.staff_assistant_reminders r2
         WHERE r2.user_id = v_uid AND r2.status = 'scheduled'
      ),
      'active_schedules_count', (
        SELECT count(*)::int
          FROM public.staff_assistant_schedules s2
         WHERE s2.user_id = v_uid AND s2.status = 'active'
      ),
      'morning_brief', jsonb_build_object(
        'enabled', COALESCE(v_prefs.morning_brief_enabled, false),
        'brief_time', COALESCE(v_prefs.morning_brief_time, '07:30'),
        'last_brief_kampala_date', v_prefs.last_brief_kampala_date,
        'dismissed_brief_kampala_date', v_prefs.dismissed_brief_kampala_date
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.assistant_staff_my_reminders_and_schedules(boolean) IS
  'Read-only Zoe tool returning the signed-in staff member''s personal reminders, report email schedules, and 07:30 Kampala morning brief settings.';

REVOKE ALL ON FUNCTION public.assistant_staff_my_reminders_and_schedules(boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_reminders_and_schedules(boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Click-confirmed action RPCs (invoked ONLY when the user clicks Confirm/Cancel)
-- ---------------------------------------------------------------------------

-- 7a. Create a personal reminder for myself
CREATE OR REPLACE FUNCTION public.staff_assistant_create_reminder(
  p_title text,
  p_remind_at timestamptz,
  p_note text DEFAULT NULL,
  p_conversation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_clean_title text := trim(COALESCE(p_title, ''));
  v_clean_note  text := NULLIF(trim(COALESCE(p_note, '')), '');
  v_remind_at  timestamptz := COALESCE(p_remind_at, now() + interval '1 hour');
  v_row        public.staff_assistant_reminders%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.staff_assistant_has_access() OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF v_clean_title = '' OR char_length(v_clean_title) > 240 THEN
    RAISE EXCEPTION 'invalid_reminder_title' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.staff_assistant_reminders (
    user_id,
    title,
    note,
    remind_at,
    status,
    notified_at,
    conversation_id
  )
  VALUES (
    v_uid,
    v_clean_title,
    v_clean_note,
    v_remind_at,
    CASE WHEN v_remind_at <= now() THEN 'notified' ELSE 'scheduled' END,
    CASE WHEN v_remind_at <= now() THEN now() ELSE NULL END,
    p_conversation_id
  )
  RETURNING * INTO v_row;

  IF v_remind_at <= now() THEN
    INSERT INTO public.notifications (
      user_id,
      title,
      message,
      type,
      is_read,
      link_path,
      metadata
    )
    VALUES (
      v_uid,
      'Zoe Reminder: ' || v_clean_title,
      COALESCE(v_clean_note, v_clean_title),
      'staff_assistant_reminder',
      false,
      '/me/zoe',
      jsonb_build_object(
        'source', 'staff_assistant',
        'reminder_id', v_row.id,
        'remind_at', v_row.remind_at
      )
    );
  END IF;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    reason,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_reminder_created',
    'staff_assistant_reminders',
    v_row.id::text,
    'Created personal Zoe reminder: ' || v_clean_title,
    jsonb_build_object(
      'reminder_id', v_row.id,
      'title', v_row.title,
      'remind_at', v_row.remind_at,
      'status', v_row.status
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'reminder', jsonb_build_object(
      'id', v_row.id,
      'title', v_row.title,
      'note', v_row.note,
      'remind_at', v_row.remind_at,
      'remind_at_kampala', to_char(v_row.remind_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD HH24:MI'),
      'status', v_row.status
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_create_reminder(text, timestamptz, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_create_reminder(text, timestamptz, text, uuid) TO authenticated;

-- 7b. Cancel a personal reminder
CREATE OR REPLACE FUNCTION public.staff_assistant_cancel_reminder(
  p_reminder_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_row public.staff_assistant_reminders%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.staff_assistant_has_access() OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.staff_assistant_reminders
     SET status = 'cancelled',
         cancelled_at = now(),
         updated_at = now()
   WHERE id = p_reminder_id
     AND user_id = v_uid
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'reminder_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    reason,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_reminder_cancelled',
    'staff_assistant_reminders',
    v_row.id::text,
    'Cancelled personal Zoe reminder: ' || v_row.title,
    jsonb_build_object('reminder_id', v_row.id, 'title', v_row.title)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'status', v_row.status,
    'cancelled_at', v_row.cancelled_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_cancel_reminder(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_cancel_reminder(uuid) TO authenticated;

-- 7c. Send an in-app notification to a Welile staff colleague (notifications table)
CREATE OR REPLACE FUNCTION public.staff_assistant_send_colleague_notification(
  p_recipient_email text,
  p_title text,
  p_message text,
  p_link_path text DEFAULT '/me/zoe',
  p_conversation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid            uuid := (SELECT auth.uid());
  v_clean_email    text := lower(trim(COALESCE(p_recipient_email, '')));
  v_clean_title    text := trim(COALESCE(p_title, ''));
  v_clean_message  text := trim(COALESCE(p_message, ''));
  v_sender_name    text;
  v_recipient      record;
  v_notif_id       uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.staff_assistant_has_access() OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  -- Enforce that the recipient is an active Welile staff member with a registered email
  IF v_clean_email = '' OR NOT public.staff_assistant_is_staff_email(v_clean_email) THEN
    RAISE EXCEPTION 'recipient_not_staff' USING ERRCODE = '42501';
  END IF;

  IF v_clean_title = '' OR char_length(v_clean_title) > 200 THEN
    RAISE EXCEPTION 'invalid_notification_title' USING ERRCODE = '22023';
  END IF;
  IF v_clean_message = '' OR char_length(v_clean_message) > 1000 THEN
    RAISE EXCEPTION 'invalid_notification_message' USING ERRCODE = '22023';
  END IF;

  SELECT r.staff_user_id, r.full_name, r.email
    INTO v_recipient
    FROM public.staff_assistant_email_recipients(v_clean_email) r
   WHERE lower(trim(r.email)) = v_clean_email
   LIMIT 1;

  IF v_recipient.staff_user_id IS NULL THEN
    RAISE EXCEPTION 'recipient_not_staff' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(NULLIF(trim(p.full_name), ''), NULLIF(trim(p.email), ''), 'Welile Staff')
    INTO v_sender_name
    FROM public.profiles p
   WHERE p.id = v_uid;

  INSERT INTO public.notifications (
    user_id,
    title,
    message,
    type,
    is_read,
    link_path,
    metadata
  )
  VALUES (
    v_recipient.staff_user_id,
    v_clean_title,
    v_clean_message || ' (Sent via Zoe by ' || COALESCE(v_sender_name, 'Staff Colleague') || ')',
    'staff_assistant',
    false,
    COALESCE(NULLIF(trim(p_link_path), ''), '/me/zoe'),
    jsonb_build_object(
      'source', 'staff_assistant',
      'sender_user_id', v_uid,
      'sender_name', COALESCE(v_sender_name, 'Staff Colleague'),
      'recipient_user_id', v_recipient.staff_user_id,
      'recipient_name', v_recipient.full_name,
      'recipient_email', v_recipient.email,
      'conversation_id', p_conversation_id
    )
  )
  RETURNING id INTO v_notif_id;

  IF v_notif_id IS NULL THEN
    RAISE EXCEPTION 'notification_insert_blocked' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    reason,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_colleague_notified',
    'notifications',
    v_notif_id::text,
    'Sent in-app colleague notification via Zoe to ' || v_recipient.email,
    jsonb_build_object(
      'notification_id', v_notif_id,
      'recipient_user_id', v_recipient.staff_user_id,
      'recipient_name', v_recipient.full_name,
      'recipient_email', v_recipient.email,
      'title', v_clean_title
    )
  );

  INSERT INTO public.system_events (
    event_type,
    actor_id,
    user_id,
    source,
    description,
    metadata
  )
  VALUES (
    'staff_assistant.colleague_notified',
    v_uid,
    v_recipient.staff_user_id,
    'staff_assistant_send_colleague_notification',
    'In-app notification sent via Zoe by ' || COALESCE(v_sender_name, 'Staff') || ' to ' || v_recipient.email,
    jsonb_build_object(
      'notification_id', v_notif_id,
      'recipient_user_id', v_recipient.staff_user_id,
      'recipient_email', v_recipient.email,
      'title', v_clean_title
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'notification_id', v_notif_id,
    'recipient_user_id', v_recipient.staff_user_id,
    'recipient_name', v_recipient.full_name,
    'recipient_email', v_recipient.email,
    'title', v_clean_title
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_send_colleague_notification(text, text, text, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_send_colleague_notification(text, text, text, text, uuid) TO authenticated;

-- 7d. Helper to compute the next run timestamp in Africa/Kampala
CREATE OR REPLACE FUNCTION public.staff_assistant_compute_next_run(
  p_frequency text,
  p_send_time_kampala text DEFAULT '07:30',
  p_day_of_week integer DEFAULT NULL,
  p_from timestamptz DEFAULT now()
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_time_str   text := COALESCE(NULLIF(trim(p_send_time_kampala), ''), '07:30');
  v_now_kla    timestamp := (COALESCE(p_from, now()) AT TIME ZONE 'Africa/Kampala');
  v_target_kla timestamp;
  v_dow        integer;
  v_days_ahead integer;
BEGIN
  IF v_time_str !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    v_time_str := '07:30';
  END IF;

  v_target_kla := (v_now_kla::date::text || ' ' || v_time_str || ':00')::timestamp;

  IF p_frequency = 'weekly' THEN
    v_dow := COALESCE(p_day_of_week, 1); -- Default Monday (1)
    v_days_ahead := (v_dow - extract(dow FROM v_now_kla)::int + 7) % 7;
    v_target_kla := v_target_kla + make_interval(days => v_days_ahead);
    IF v_target_kla <= v_now_kla THEN
      v_target_kla := v_target_kla + interval '7 days';
    END IF;
  ELSE
    IF v_target_kla <= v_now_kla THEN
      v_target_kla := v_target_kla + interval '1 day';
    END IF;
  END IF;

  RETURN v_target_kla AT TIME ZONE 'Africa/Kampala';
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_compute_next_run(text, text, integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_compute_next_run(text, text, integer, timestamptz) TO authenticated, service_role;

-- 7e. Create a recurring report email schedule (daily or weekly, Welile staff recipients only)
CREATE OR REPLACE FUNCTION public.staff_assistant_create_schedule(
  p_title text,
  p_report_tool text,
  p_report_rpc text,
  p_report_args jsonb DEFAULT '{}'::jsonb,
  p_frequency text DEFAULT 'daily',
  p_recipient_emails text[] DEFAULT '{}',
  p_day_of_week integer DEFAULT NULL,
  p_send_time_kampala text DEFAULT '07:30',
  p_custom_message text DEFAULT NULL,
  p_conversation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid              uuid := (SELECT auth.uid());
  v_clean_title      text := trim(COALESCE(p_title, ''));
  v_clean_tool       text := trim(COALESCE(p_report_tool, ''));
  v_clean_rpc        text := trim(COALESCE(p_report_rpc, ''));
  v_clean_freq       text := lower(trim(COALESCE(p_frequency, 'daily')));
  v_clean_time       text := COALESCE(NULLIF(trim(p_send_time_kampala), ''), '07:30');
  v_verified_emails  text[] := '{}';
  v_verified_names   text[] := '{}';
  v_email            text;
  v_match            record;
  v_next_run         timestamptz;
  v_row              public.staff_assistant_schedules%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.staff_assistant_has_access() OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF v_clean_title = '' OR char_length(v_clean_title) > 200 THEN
    RAISE EXCEPTION 'invalid_schedule_title' USING ERRCODE = '22023';
  END IF;
  IF v_clean_rpc !~ '^assistant_staff_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'invalid_report_rpc' USING ERRCODE = '22023';
  END IF;
  IF v_clean_freq NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'invalid_schedule_frequency' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(array_length(p_recipient_emails, 1), 0) < 1 OR array_length(p_recipient_emails, 1) > 10 THEN
    RAISE EXCEPTION 'invalid_recipient_count' USING ERRCODE = '22023';
  END IF;

  -- Verify EVERY recipient through staff_assistant_is_staff_email and staff_assistant_email_recipients
  FOREACH v_email IN ARRAY p_recipient_emails LOOP
    v_email := lower(trim(COALESCE(v_email, '')));
    IF v_email = '' OR NOT public.staff_assistant_is_staff_email(v_email) THEN
      RAISE EXCEPTION 'recipient_not_staff: %', v_email USING ERRCODE = '42501';
    END IF;

    SELECT r.full_name, lower(trim(r.email)) AS email
      INTO v_match
      FROM public.staff_assistant_email_recipients(v_email) r
     WHERE lower(trim(r.email)) = v_email
     LIMIT 1;

    IF v_match.email IS NULL THEN
      RAISE EXCEPTION 'recipient_not_staff: %', v_email USING ERRCODE = '42501';
    END IF;

    IF NOT (v_match.email = ANY(v_verified_emails)) THEN
      v_verified_emails := array_append(v_verified_emails, v_match.email);
      v_verified_names  := array_append(v_verified_names, v_match.full_name);
    END IF;
  END LOOP;

  v_next_run := public.staff_assistant_compute_next_run(
    v_clean_freq,
    v_clean_time,
    p_day_of_week,
    now()
  );

  INSERT INTO public.staff_assistant_schedules (
    user_id,
    title,
    report_tool,
    report_rpc,
    report_args,
    frequency,
    day_of_week,
    send_time_kampala,
    recipient_emails,
    recipient_names,
    custom_message,
    status,
    next_run_at,
    conversation_id
  )
  VALUES (
    v_uid,
    v_clean_title,
    v_clean_tool,
    v_clean_rpc,
    COALESCE(p_report_args, '{}'::jsonb),
    v_clean_freq,
    CASE WHEN v_clean_freq = 'weekly' THEN COALESCE(p_day_of_week, 1) ELSE NULL END,
    v_clean_time,
    v_verified_emails,
    v_verified_names,
    NULLIF(trim(COALESCE(p_custom_message, '')), ''),
    'active',
    v_next_run,
    p_conversation_id
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    reason,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_schedule_created',
    'staff_assistant_schedules',
    v_row.id::text,
    'Created Zoe ' || v_row.frequency || ' report schedule: ' || v_row.title,
    jsonb_build_object(
      'schedule_id', v_row.id,
      'report_tool', v_row.report_tool,
      'report_rpc', v_row.report_rpc,
      'frequency', v_row.frequency,
      'send_time_kampala', v_row.send_time_kampala,
      'recipient_emails', v_row.recipient_emails,
      'next_run_at', v_row.next_run_at
    )
  );

  INSERT INTO public.system_events (
    event_type,
    actor_id,
    user_id,
    source,
    description,
    metadata
  )
  VALUES (
    'staff_assistant.schedule_created',
    v_uid,
    v_uid,
    'staff_assistant_create_schedule',
    'Created Zoe ' || v_row.frequency || ' report schedule (' || v_row.report_tool || ') for ' || array_to_string(v_row.recipient_emails, ', '),
    jsonb_build_object(
      'schedule_id', v_row.id,
      'report_tool', v_row.report_tool,
      'frequency', v_row.frequency,
      'recipient_emails', v_row.recipient_emails
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'schedule', jsonb_build_object(
      'id', v_row.id,
      'title', v_row.title,
      'report_tool', v_row.report_tool,
      'report_rpc', v_row.report_rpc,
      'frequency', v_row.frequency,
      'day_of_week', v_row.day_of_week,
      'send_time_kampala', v_row.send_time_kampala,
      'recipient_emails', v_row.recipient_emails,
      'recipient_names', v_row.recipient_names,
      'status', v_row.status,
      'next_run_at', v_row.next_run_at,
      'next_run_kampala', to_char(v_row.next_run_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD HH24:MI')
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_create_schedule(text, text, text, jsonb, text, text[], integer, text, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_create_schedule(text, text, text, jsonb, text, text[], integer, text, text, uuid) TO authenticated;

-- 7f. Cancel a recurring report schedule
CREATE OR REPLACE FUNCTION public.staff_assistant_cancel_schedule(
  p_schedule_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_row public.staff_assistant_schedules%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.staff_assistant_has_access() OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.staff_assistant_schedules
     SET status = 'cancelled',
         cancelled_at = now(),
         updated_at = now()
   WHERE id = p_schedule_id
     AND user_id = v_uid
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'schedule_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    reason,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_schedule_cancelled',
    'staff_assistant_schedules',
    v_row.id::text,
    'Cancelled Zoe report schedule: ' || v_row.title,
    jsonb_build_object('schedule_id', v_row.id, 'title', v_row.title)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'status', v_row.status,
    'cancelled_at', v_row.cancelled_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_cancel_schedule(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_cancel_schedule(uuid) TO authenticated;

-- 7g. Toggle or update per-person Morning Brief preference (off by default, 07:30 Kampala time)
CREATE OR REPLACE FUNCTION public.staff_assistant_set_morning_brief_prefs(
  p_enabled boolean,
  p_brief_time text DEFAULT '07:30',
  p_dismiss_today boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_today      date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_clean_time text := COALESCE(NULLIF(trim(p_brief_time), ''), '07:30');
  v_row        public.staff_assistant_preferences%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.staff_assistant_has_access() OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF v_clean_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    v_clean_time := '07:30';
  END IF;

  INSERT INTO public.staff_assistant_preferences (
    user_id,
    morning_brief_enabled,
    morning_brief_time,
    dismissed_brief_kampala_date,
    updated_at
  )
  VALUES (
    v_uid,
    COALESCE(p_enabled, false),
    v_clean_time,
    CASE WHEN COALESCE(p_dismiss_today, false) THEN v_today ELSE NULL END,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET morning_brief_enabled = COALESCE(p_enabled, staff_assistant_preferences.morning_brief_enabled),
        morning_brief_time = v_clean_time,
        dismissed_brief_kampala_date = CASE
          WHEN COALESCE(p_dismiss_today, false) THEN v_today
          WHEN COALESCE(p_enabled, false) = true AND staff_assistant_preferences.morning_brief_enabled = false THEN NULL
          ELSE staff_assistant_preferences.dismissed_brief_kampala_date
        END,
        updated_at = now()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'morning_brief', jsonb_build_object(
      'enabled', v_row.morning_brief_enabled,
      'brief_time', v_row.morning_brief_time,
      'last_brief_kampala_date', v_row.last_brief_kampala_date,
      'dismissed_brief_kampala_date', v_row.dismissed_brief_kampala_date
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_set_morning_brief_prefs(boolean, text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_set_morning_brief_prefs(boolean, text, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Cron Runner Verification & Impersonation Helpers (service_role only)
-- ---------------------------------------------------------------------------

-- 8a. Re-check whether a schedule/reminder owner still passes staff_assistant_has_access()
CREATE OR REPLACE FUNCTION public.staff_assistant_check_owner_access(
  p_owner_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prev_sub    text := current_setting('request.jwt.claim.sub', true);
  v_prev_role   text := current_setting('request.jwt.claim.role', true);
  v_prev_claims text := current_setting('request.jwt.claims', true);
  v_allowed     boolean := false;
BEGIN
  IF p_owner_id IS NULL THEN
    RETURN false;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', p_owner_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_owner_id::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  v_allowed := public.staff_assistant_has_access();

  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_prev_role, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), true);

  RETURN COALESCE(v_allowed, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_check_owner_access(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_assistant_check_owner_access(uuid) TO service_role;

-- 8b. Execute a scheduled read-only report strictly under the schedule owner's identity & role checks
CREATE OR REPLACE FUNCTION public.staff_assistant_run_scheduled_report_as_owner(
  p_owner_id uuid,
  p_report_rpc text,
  p_report_args jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prev_sub    text := current_setting('request.jwt.claim.sub', true);
  v_prev_role   text := current_setting('request.jwt.claim.role', true);
  v_prev_claims text := current_setting('request.jwt.claims', true);
  v_result      jsonb;
BEGIN
  IF p_owner_id IS NULL THEN
    RAISE EXCEPTION 'owner_required' USING ERRCODE = '28000';
  END IF;
  IF COALESCE(p_report_rpc, '') !~ '^assistant_staff_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'invalid_report_rpc' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', p_owner_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_owner_id::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  BEGIN
    IF NOT public.staff_assistant_has_access() THEN
      RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
    END IF;

    -- Execute the zero-arg or default-arg signature of the read-only assistant_staff_* function
    -- so its internal role checks and masking run against auth.uid() = p_owner_id.
    EXECUTE format('SELECT public.%I()', p_report_rpc) INTO v_result;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);
    PERFORM set_config('request.jwt.claim.role', COALESCE(v_prev_role, ''), true);
    PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), true);
    RAISE;
  END;

  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_prev_role, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), true);

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_run_scheduled_report_as_owner(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_assistant_run_scheduled_report_as_owner(uuid, text, jsonb) TO service_role;

-- 8c. Dispatch due personal reminders into public.notifications (re-checking owner access)
CREATE OR REPLACE FUNCTION public.staff_assistant_dispatch_due_reminders()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_rem       record;
  v_delivered integer := 0;
BEGIN
  FOR v_rem IN
    SELECT r.*
      FROM public.staff_assistant_reminders r
     WHERE r.status = 'scheduled'
       AND r.remind_at <= now()
     ORDER BY r.remind_at ASC
     LIMIT 100
  LOOP
    IF public.staff_assistant_check_owner_access(v_rem.user_id) THEN
      INSERT INTO public.notifications (
        user_id,
        title,
        message,
        type,
        is_read,
        link_path,
        metadata
      )
      VALUES (
        v_rem.user_id,
        'Zoe Reminder: ' || v_rem.title,
        COALESCE(v_rem.note, v_rem.title),
        'staff_assistant_reminder',
        false,
        '/me/zoe',
        jsonb_build_object(
          'source', 'staff_assistant',
          'reminder_id', v_rem.id,
          'remind_at', v_rem.remind_at
        )
      );

      UPDATE public.staff_assistant_reminders
         SET status = 'notified',
             notified_at = now(),
             updated_at = now()
       WHERE id = v_rem.id;

      v_delivered := v_delivered + 1;
    ELSE
      UPDATE public.staff_assistant_reminders
         SET status = 'cancelled',
             cancelled_at = now(),
             updated_at = now()
       WHERE id = v_rem.id;
    END IF;
  END LOOP;

  RETURN v_delivered;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_dispatch_due_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_assistant_dispatch_due_reminders() TO service_role;
