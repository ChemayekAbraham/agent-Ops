-- =============================================================================
-- Migration: 20261027100000_staff_assistant_security_hardening.sql
-- Purpose:   Post-implementation security hardening for Zoe (My Space AI Assistant),
--            fixing findings H1, H3, H4, H5, M9, M10, M12 and Low items from
--            docs/ZOE_POST_IMPLEMENTATION_REVIEW.md:
--              1. Lock Zoe's own tables: authenticated gets SELECT only on
--                 staff_assistant_reminders, staff_assistant_schedules, and
--                 staff_assistant_preferences; all writes go through checked RPCs.
--              2. Make staff_assistant_messages and staff_assistant_conversations
--                 undeletable by users (add hidden_by_user/hidden_at for "clear my
--                 history"; keep 90-day purge).
--              3. Add atomic rate-limit and per-recipient email budget RPCs using
--                 transaction advisory locks + configurable model-round / tool-call /
--                 notification caps in staff_assistant_config.
--              4. Create staff_assistant_drafts (owner, kind, canonical payload_hash,
--                 30-minute expiry, used_at) with save & atomic consume RPCs, and
--                 bind all confirm RPCs + staff-assistant-send-email to saved drafts.
--              5. Validate colleague notification link_path against internal routes
--                 and enforce a 30/day notification cap.
--              6. Harden staff_assistant_email_recipients (escape % and _, require
--                 >= 3 non-wildcard characters), allow service_role to call
--                 staff_assistant_is_staff_email, and add
--                 staff_assistant_can_user_read_report(p_user_id, p_report_rpc).
--              7. Fix schedule runner helpers: never forge aal2 in JWT claims,
--                 pass p_report_args inside SET LOCAL TRANSACTION READ ONLY, track
--                 mfa_confirmed_at / requires_mfa, and register pg_cron job.
--              8. Redact CRM review surfaces: drop direct CRM SELECT on
--                 staff_assistant_messages, add v_staff_assistant_crm_messages_redacted,
--                 and strip assistant answer content / report_payload / figures from
--                 staff_assistant_crm_review_dashboard and
--                 staff_assistant_crm_conversation_thread.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Extend staff_assistant_config with model-round, tool-call & notification caps
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_config
  ADD COLUMN IF NOT EXISTS max_model_rounds integer NOT NULL DEFAULT 4
    CONSTRAINT staff_assistant_config_rounds_chk CHECK (max_model_rounds BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS max_tool_calls integer NOT NULL DEFAULT 6
    CONSTRAINT staff_assistant_config_tools_chk CHECK (max_tool_calls BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS max_notifications_per_day integer NOT NULL DEFAULT 30
    CONSTRAINT staff_assistant_config_notifs_chk CHECK (max_notifications_per_day BETWEEN 0 AND 200);

UPDATE public.staff_assistant_config
   SET max_model_rounds = COALESCE(max_model_rounds, 4),
       max_tool_calls = COALESCE(max_tool_calls, 6),
       max_notifications_per_day = COALESCE(max_notifications_per_day, 30)
 WHERE id = true;

-- -----------------------------------------------------------------------------
-- 2. Make staff_assistant_messages and staff_assistant_conversations undeletable
--    by users (soft-hide via hidden_by_user; 90-day purge stays)
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_conversations
  ADD COLUMN IF NOT EXISTS hidden_by_user boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

ALTER TABLE public.staff_assistant_messages
  ADD COLUMN IF NOT EXISTS hidden_by_user boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_staff_assistant_conversations_user_visible
  ON public.staff_assistant_conversations (user_id, last_message_at DESC)
  WHERE hidden_by_user = false;

CREATE INDEX IF NOT EXISTS idx_staff_assistant_messages_user_visible
  ON public.staff_assistant_messages (user_id, created_at DESC)
  WHERE hidden_by_user = false;

-- Drop user DELETE policies and revoke DELETE from authenticated
DROP POLICY IF EXISTS "Staff delete own staff_assistant_conversations" ON public.staff_assistant_conversations;
DROP POLICY IF EXISTS "Staff delete own staff_assistant_messages" ON public.staff_assistant_messages;

REVOKE DELETE ON TABLE public.staff_assistant_conversations FROM PUBLIC, anon, authenticated;
REVOKE DELETE ON TABLE public.staff_assistant_messages      FROM PUBLIC, anon, authenticated;

-- Update owner SELECT policies on conversations/messages to hide rows where hidden_by_user = true
DROP POLICY IF EXISTS "Staff read own staff_assistant_conversations" ON public.staff_assistant_conversations;
CREATE POLICY "Staff read own staff_assistant_conversations"
  ON public.staff_assistant_conversations
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND hidden_by_user = false
    AND (SELECT public.staff_assistant_has_access())
  );

DROP POLICY IF EXISTS "Staff read own staff_assistant_messages" ON public.staff_assistant_messages;
CREATE POLICY "Staff read own staff_assistant_messages"
  ON public.staff_assistant_messages
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND hidden_by_user = false
    AND (SELECT public.staff_assistant_has_access())
  );

-- Guard trigger so even service_role / SQL callers cannot delete messages younger than 90 days
CREATE OR REPLACE FUNCTION public.trg_guard_staff_assistant_messages_no_user_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF OLD.created_at >= now() - interval '90 days'
     AND current_setting('app.zoe_allow_test_cleanup', true) IS DISTINCT FROM 'on'
  THEN
    RAISE EXCEPTION 'staff_assistant_messages cannot be deleted before the 90-day retention window; use hidden_by_user to clear history.'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_guard_staff_assistant_messages_no_user_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_staff_assistant_messages_no_user_delete ON public.staff_assistant_messages;
CREATE TRIGGER trg_staff_assistant_messages_no_user_delete
  BEFORE DELETE ON public.staff_assistant_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_guard_staff_assistant_messages_no_user_delete();

-- Soft-hide RPC for "Clear my history"
CREATE OR REPLACE FUNCTION public.staff_assistant_hide_my_history(
  p_user_id uuid DEFAULT NULL,
  p_conversation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role text := COALESCE(auth.role(), '');
  v_uid uuid;
  v_now timestamptz := now();
  v_msg_count integer := 0;
  v_conv_count integer := 0;
BEGIN
  IF v_caller_role = 'service_role' AND p_user_id IS NOT NULL THEN
    v_uid := p_user_id;
  ELSE
    v_uid := (SELECT auth.uid());
    IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
      RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.staff_assistant_messages
     SET hidden_by_user = true,
         hidden_at = v_now
   WHERE user_id = v_uid
     AND hidden_by_user = false
     AND (p_conversation_id IS NULL OR conversation_id = p_conversation_id);
  GET DIAGNOSTICS v_msg_count = ROW_COUNT;

  UPDATE public.staff_assistant_conversations
     SET hidden_by_user = true,
         hidden_at = v_now
   WHERE user_id = v_uid
     AND hidden_by_user = false
     AND (p_conversation_id IS NULL OR id = p_conversation_id);
  GET DIAGNOSTICS v_conv_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'hidden_messages', v_msg_count,
    'hidden_conversations', v_conv_count,
    'hidden_at', v_now
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_hide_my_history(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_hide_my_history(uuid, uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Lock Zoe's own tables (Finding H4):
--    authenticated gets SELECT only on staff_assistant_reminders,
--    staff_assistant_schedules, and staff_assistant_preferences.
--    All mutations go through the checked SECURITY DEFINER RPCs.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Staff insert own staff_assistant_reminders"   ON public.staff_assistant_reminders;
DROP POLICY IF EXISTS "Staff update own staff_assistant_reminders"   ON public.staff_assistant_reminders;
DROP POLICY IF EXISTS "Staff delete own staff_assistant_reminders"   ON public.staff_assistant_reminders;

DROP POLICY IF EXISTS "Staff insert own staff_assistant_schedules"   ON public.staff_assistant_schedules;
DROP POLICY IF EXISTS "Staff update own staff_assistant_schedules"   ON public.staff_assistant_schedules;
DROP POLICY IF EXISTS "Staff delete own staff_assistant_schedules"   ON public.staff_assistant_schedules;

DROP POLICY IF EXISTS "Staff insert own staff_assistant_preferences" ON public.staff_assistant_preferences;
DROP POLICY IF EXISTS "Staff update own staff_assistant_preferences" ON public.staff_assistant_preferences;

REVOKE ALL ON TABLE public.staff_assistant_reminders   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staff_assistant_schedules   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staff_assistant_preferences FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.staff_assistant_reminders   TO authenticated;
GRANT SELECT ON TABLE public.staff_assistant_schedules   TO authenticated;
GRANT SELECT ON TABLE public.staff_assistant_preferences TO authenticated;

GRANT ALL ON TABLE public.staff_assistant_reminders   TO service_role;
GRANT ALL ON TABLE public.staff_assistant_schedules   TO service_role;
GRANT ALL ON TABLE public.staff_assistant_preferences TO service_role;

-- -----------------------------------------------------------------------------
-- 4. Atomic rate limits and per-recipient email budget checks
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_check_question_rate_limit(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_cfg record;
  v_kampala_start timestamptz;
  v_one_min_ago timestamptz := now() - interval '60 seconds';
  v_burst_count integer := 0;
  v_daily_count integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required' USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent rate-limit checks for this user within the transaction
  PERFORM pg_advisory_xact_lock(hashtext('zoe_q_rate_' || p_user_id::text));

  SELECT
    COALESCE(c.enabled, true) AS enabled,
    COALESCE(c.max_questions_per_day, 80) AS max_questions_per_day,
    COALESCE(c.max_emails_per_day, 30) AS max_emails_per_day,
    COALESCE(c.max_model_rounds, 4) AS max_model_rounds,
    COALESCE(c.max_tool_calls, 6) AS max_tool_calls
    INTO v_cfg
    FROM public.staff_assistant_config c
   WHERE c.id = true;

  IF NOT FOUND THEN
    v_cfg := ROW(true, 80, 30, 4, 6);
  END IF;

  v_kampala_start := ((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamp AT TIME ZONE 'Africa/Kampala';

  SELECT count(*)::integer
    INTO v_burst_count
    FROM public.staff_assistant_messages m
   WHERE m.user_id = p_user_id
     AND m.role = 'user'
     AND m.created_at >= v_one_min_ago;

  IF v_burst_count >= 10 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limited',
      'used_today', v_daily_count,
      'limit_today', v_cfg.max_questions_per_day,
      'burst_last_minute', v_burst_count
    );
  END IF;

  SELECT count(*)::integer
    INTO v_daily_count
    FROM public.staff_assistant_messages m
   WHERE m.user_id = p_user_id
     AND m.role = 'user'
     AND m.created_at >= v_kampala_start;

  IF v_daily_count >= v_cfg.max_questions_per_day THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'daily_limit',
      'used_today', v_daily_count,
      'limit_today', v_cfg.max_questions_per_day,
      'burst_last_minute', v_burst_count
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'used_today', v_daily_count,
    'limit_today', v_cfg.max_questions_per_day,
    'burst_last_minute', v_burst_count,
    'max_model_rounds', v_cfg.max_model_rounds,
    'max_tool_calls', v_cfg.max_tool_calls
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_check_question_rate_limit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_assistant_check_question_rate_limit(uuid) TO service_role;

-- Atomic per-recipient email budget check (counts each recipient against the 30/day cap)
CREATE OR REPLACE FUNCTION public.staff_assistant_check_email_budget(
  p_user_id uuid,
  p_recipient_count integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role text := COALESCE(auth.role(), '');
  v_uid uuid;
  v_req_count integer := GREATEST(COALESCE(p_recipient_count, 1), 1);
  v_max_emails integer := 30;
  v_kampala_start timestamptz;
  v_sent_today integer := 0;
BEGIN
  IF v_caller_role = 'service_role' THEN
    v_uid := p_user_id;
  ELSE
    v_uid := (SELECT auth.uid());
    IF v_uid IS NULL OR (p_user_id IS NOT NULL AND p_user_id <> v_uid) OR NOT public.staff_assistant_has_access() THEN
      RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'user_id is required' USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent email budget checks for this user within the transaction
  PERFORM pg_advisory_xact_lock(hashtext('zoe_email_rate_' || v_uid::text));

  SELECT COALESCE(c.max_emails_per_day, 30)
    INTO v_max_emails
    FROM public.staff_assistant_config c
   WHERE c.id = true;

  v_kampala_start := ((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamp AT TIME ZONE 'Africa/Kampala';

  -- Count every recipient sent today (per-recipient accounting across direct and scheduled Zoe emails)
  SELECT COALESCE(
    sum(
      GREATEST(
        CASE
          WHEN (al.metadata ->> 'recipient_count') ~ '^[0-9]+$'
            THEN (al.metadata ->> 'recipient_count')::integer
          WHEN jsonb_typeof(al.metadata -> 'recipients') = 'array'
            THEN jsonb_array_length(al.metadata -> 'recipients')
          ELSE 1
        END,
        1
      )
    ),
    0
  )::integer
    INTO v_sent_today
    FROM public.audit_logs al
   WHERE al.user_id = v_uid
     AND al.action_type IN ('staff_assistant_report_email_sent', 'staff_assistant_schedule_email_sent')
     AND al.created_at >= v_kampala_start;

  RETURN jsonb_build_object(
    'allowed', (v_sent_today + v_req_count <= v_max_emails),
    'sent_today', v_sent_today,
    'requested_recipients', v_req_count,
    'max_emails_per_day', v_max_emails,
    'remaining_after', GREATEST(v_max_emails - (v_sent_today + v_req_count), 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_check_email_budget(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_check_email_budget(uuid, integer) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Server-side drafts table: public.staff_assistant_drafts (Finding M9)
--    Ties Draft and Send/Confirm together with owner, kind, exact payload_hash,
--    30-minute expiry, and single-use used_at.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL DEFAULT auth.uid(),
  kind            text NOT NULL
                  CONSTRAINT staff_assistant_drafts_kind_chk
                  CHECK (kind IN ('email', 'reminder', 'notification', 'schedule')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash    text NOT NULL,
  conversation_id uuid REFERENCES public.staff_assistant_conversations(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_drafts IS
  'Server-side action/email drafts for Zoe. Every confirm RPC and staff-assistant-send-email requires an unexpired, unused draft owned by auth.uid() with a matching canonical payload hash.';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_drafts_user_active
  ON public.staff_assistant_drafts (user_id, kind, created_at DESC)
  WHERE used_at IS NULL;

ALTER TABLE public.staff_assistant_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_drafts;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_drafts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS "Staff read own staff_assistant_drafts" ON public.staff_assistant_drafts;
CREATE POLICY "Staff read own staff_assistant_drafts"
  ON public.staff_assistant_drafts
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()));

REVOKE ALL ON TABLE public.staff_assistant_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_drafts TO authenticated;
GRANT ALL    ON TABLE public.staff_assistant_drafts TO service_role;

-- Canonical draft payload hash helper (normalizes fields by draft kind so hash is deterministic)
CREATE OR REPLACE FUNCTION public.staff_assistant_compute_draft_hash(
  p_kind text,
  p_payload jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_kind text := lower(btrim(COALESCE(p_payload ->> 'kind', p_kind, '')));
  v_canonical jsonb;
  v_emails jsonb;
BEGIN
  IF v_kind = 'reminder' THEN
    v_canonical := jsonb_build_object(
      'kind', 'reminder',
      'title', btrim(COALESCE(p_payload ->> 'title', '')),
      'remind_at', (COALESCE(NULLIF(btrim(p_payload ->> 'remind_at'), '')::timestamptz, to_timestamp(0)) AT TIME ZONE 'UTC'),
      'note', COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'note', '')), ''), '')
    );
  ELSIF v_kind = 'notification' THEN
    v_canonical := jsonb_build_object(
      'kind', 'notification',
      'recipient_email', lower(btrim(COALESCE(p_payload ->> 'recipient_email', ''))),
      'title', btrim(COALESCE(p_payload ->> 'title', '')),
      'message', btrim(COALESCE(p_payload ->> 'message', '')),
      'link_path', COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'link_path', '')), ''), '/me')
    );
  ELSIF v_kind = 'schedule' THEN
    SELECT COALESCE(jsonb_agg( lower(btrim(val)) ORDER BY lower(btrim(val)) ), '[]'::jsonb)
      INTO v_emails
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(p_payload -> 'recipient_emails') = 'array'
            THEN p_payload -> 'recipient_emails'
          WHEN COALESCE(p_payload ->> 'recipient_email', '') <> ''
            THEN jsonb_build_array(p_payload ->> 'recipient_email')
          ELSE '[]'::jsonb
        END
      ) AS t(val)
     WHERE btrim(val) <> '';

    v_canonical := jsonb_build_object(
      'kind', 'schedule',
      'title', btrim(COALESCE(p_payload ->> 'title', '')),
      'report_tool', lower(btrim(COALESCE(p_payload ->> 'report_tool', ''))),
      'report_rpc', lower(btrim(COALESCE(p_payload ->> 'report_rpc', ''))),
      'report_args', COALESCE(p_payload -> 'report_args', '{}'::jsonb),
      'frequency', lower(btrim(COALESCE(p_payload ->> 'frequency', 'daily'))),
      'day_of_week', CASE
        WHEN lower(btrim(COALESCE(p_payload ->> 'frequency', 'daily'))) = 'weekly'
          THEN COALESCE((p_payload ->> 'day_of_week')::integer, 1)
        ELSE NULL
      END,
      'send_time_kampala', COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'send_time_kampala', '')), ''), '07:30'),
      'recipient_emails', v_emails,
      'custom_message', COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'custom_message', '')), ''), '')
    );
  ELSIF v_kind = 'email' THEN
    v_canonical := jsonb_build_object(
      'kind', 'email',
      'recipient_email', lower(btrim(COALESCE(p_payload ->> 'recipient_email', ''))),
      'subject', btrim(COALESCE(p_payload ->> 'subject', '')),
      'message', btrim(COALESCE(p_payload ->> 'message', '')),
      'report_tool', lower(btrim(COALESCE(p_payload #>> '{report_reference,tool}', p_payload ->> 'report_tool', ''))),
      'report_rpc', lower(btrim(COALESCE(p_payload #>> '{report_reference,rpc}', p_payload ->> 'report_rpc', ''))),
      'report_args', COALESCE(p_payload #> '{report_reference,args}', p_payload -> 'report_args', '{}'::jsonb)
    );
  ELSE
    RAISE EXCEPTION 'Invalid draft kind: %', v_kind USING ERRCODE = '22023';
  END IF;

  RETURN encode(extensions.digest(v_canonical::text, 'sha256'), 'hex');
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_compute_draft_hash(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_compute_draft_hash(text, jsonb) TO authenticated, service_role;

-- Save a server-side draft (30-minute expiry)
CREATE OR REPLACE FUNCTION public.staff_assistant_save_draft(
  p_kind text,
  p_payload jsonb,
  p_conversation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_kind text := lower(btrim(COALESCE(p_kind, '')));
  v_hash text;
  v_row public.staff_assistant_drafts;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF v_kind NOT IN ('email', 'reminder', 'notification', 'schedule') THEN
    RAISE EXCEPTION 'Invalid draft kind: %', v_kind USING ERRCODE = '22023';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Draft payload must be a JSON object.' USING ERRCODE = '22023';
  END IF;

  v_hash := public.staff_assistant_compute_draft_hash(v_kind, p_payload);

  INSERT INTO public.staff_assistant_drafts (
    user_id,
    kind,
    payload,
    payload_hash,
    conversation_id,
    expires_at
  )
  VALUES (
    v_uid,
    v_kind,
    p_payload,
    v_hash,
    p_conversation_id,
    now() + interval '30 minutes'
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'draft_id', v_row.id,
    'kind', v_row.kind,
    'payload_hash', v_row.payload_hash,
    'expires_at', v_row.expires_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_save_draft(text, jsonb, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_save_draft(text, jsonb, uuid) TO authenticated;

-- Atomically verify and consume a server-side draft (locks row FOR UPDATE, checks owner, expiry, unused, and payload_hash)
CREATE OR REPLACE FUNCTION public.staff_assistant_consume_draft(
  p_draft_id uuid,
  p_kind text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_kind text := lower(btrim(COALESCE(p_kind, '')));
  v_expected_hash text;
  v_row public.staff_assistant_drafts;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF p_draft_id IS NULL THEN
    RAISE EXCEPTION 'A valid server draft_id is required before confirming this action.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_row
    FROM public.staff_assistant_drafts d
   WHERE d.id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND OR v_row.user_id <> v_uid THEN
    RAISE EXCEPTION 'Draft not found or does not belong to the signed-in staff member.'
      USING ERRCODE = '42501';
  END IF;

  IF v_row.kind <> v_kind THEN
    RAISE EXCEPTION 'Draft kind mismatch (expected %, got %).', v_row.kind, v_kind
      USING ERRCODE = '22023';
  END IF;

  IF v_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'This draft has already been used and cannot be sent again.'
      USING ERRCODE = '22023';
  END IF;

  IF v_row.expires_at <= now() THEN
    RAISE EXCEPTION 'This draft has expired (30-minute limit). Please ask Zoe for a fresh draft.'
      USING ERRCODE = '22023';
  END IF;

  v_expected_hash := public.staff_assistant_compute_draft_hash(v_kind, p_payload);

  IF v_row.payload_hash <> v_expected_hash THEN
    RAISE EXCEPTION 'Draft payload does not match the server-stored draft.'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_assistant_drafts
     SET used_at = now()
   WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'ok', true,
    'draft_id', v_row.id,
    'kind', v_row.kind,
    'payload_hash', v_row.payload_hash,
    'used_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_consume_draft(uuid, text, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_consume_draft(uuid, text, jsonb) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Internal link_path validator for colleague notifications
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_is_valid_link_path(
  p_link_path text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_path text := btrim(COALESCE(p_link_path, ''));
BEGIN
  IF v_path = '' THEN
    RETURN false;
  END IF;

  -- Must start with single '/' and never '//' or protocol schemes or control chars
  IF left(v_path, 1) <> '/' OR left(v_path, 2) = '//' OR v_path ~* '[:\\]' OR v_path ~ '[\x00-\x1F\x7F]' THEN
    RETURN false;
  END IF;

  -- Validate against the app's known staff route prefixes
  RETURN v_path IN (
    '/me',
    '/me/zoe',
    '/me/payslips',
    '/me/work',
    '/me/tickets',
    '/me/requisitions',
    '/me/concerns',
    '/me/food',
    '/me/reports',
    '/me/staff-reports',
    '/your-profile',
    '/cfo/cash-position',
    '/cfo/receivables-analysis',
    '/cfo/payables-forecast',
    '/cfo-dashboard',
    '/financial-ops',
    '/coo-dashboard',
    '/ceo-dashboard',
    '/executive-hub',
    '/executive-hub?tab=agent-ops',
    '/executive-hub?tab=partner-ops',
    '/hr-dashboard',
    '/tenant-ops/workspace',
    '/landlord-ops',
    '/landlord-ops/principal-recovered',
    '/crm/dashboard',
    '/operations',
    '/admin/dashboard'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_is_valid_link_path(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_is_valid_link_path(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. Email safety & recipient role verification (Findings H3, H5, Low items)
-- -----------------------------------------------------------------------------
-- 7a. Escape % and _ in staff_assistant_email_recipients and require >= 3 non-wildcard chars
CREATE OR REPLACE FUNCTION public.staff_assistant_email_recipients(
  p_search text DEFAULT NULL
)
RETURNS TABLE (
  staff_user_id uuid,
  full_name text,
  email text,
  roles text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_raw text := btrim(COALESCE(p_search, ''));
  v_stripped text;
  v_escaped text;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required'
      USING ERRCODE = '42501';
  END IF;

  -- Strip SQL LIKE wildcards (% _ \) when checking minimum length of 3 characters
  v_stripped := btrim(regexp_replace(v_raw, '[%_\\]', '', 'g'));
  IF char_length(v_stripped) < 3 THEN
    RETURN;
  END IF;

  -- Escape \, %, and _ so they are matched literally, never as wildcards
  v_escaped := regexp_replace(v_raw, '([\\_%])', '\\\1', 'g');

  RETURN QUERY
  WITH active_staff AS (
    SELECT ur.user_id
    FROM public.user_roles ur
    WHERE ur.enabled IS TRUE
      AND ur.role::text = ANY (public.staff_assistant_Write_or_read_roles_list())
    UNION
    SELECT hs.user_id
    FROM public.hr_staff hs
    WHERE hs.active IS TRUE
      AND hs.ended_on IS NULL
      AND hs.user_id IS NOT NULL
  ),
  staff_with_roles AS (
    SELECT
      s.user_id,
      COALESCE(
        array_agg(DISTINCT ur.role::text ORDER BY ur.role::text)
          FILTER (WHERE ur.enabled IS TRUE),
        ARRAY[]::text[]
      ) AS enabled_roles
    FROM active_staff s
    LEFT JOIN public.user_roles ur
      ON ur.user_id = s.user_id
     AND ur.enabled IS TRUE
    GROUP BY s.user_id
  )
  SELECT
    p.id AS staff_user_id,
    public.assistant_clean_text(COALESCE(NULLIF(btrim(p.full_name), ''), 'Welile Staff'), 120) AS full_name,
    lower(public.assistant_real_email(btrim(p.email))) AS email,
    swr.enabled_roles AS roles
  FROM staff_with_roles swr
  JOIN public.profiles p
    ON p.id = swr.user_id
  WHERE COALESCE(p.is_frozen, false) IS FALSE
    AND public.assistant_real_email(btrim(p.email)) IS NOT NULL
    AND (
      p.full_name ILIKE ('%' || v_escaped || '%') ESCAPE '\'
      OR lower(btrim(p.email)) ILIKE ('%' || lower(v_escaped) || '%') ESCAPE '\'
    )
  ORDER BY
    CASE
      WHEN lower(btrim(p.email)) = lower(v_raw) THEN 0
      WHEN lower(btrim(p.full_name)) = lower(v_raw) THEN 1
      WHEN lower(btrim(p.full_name)) LIKE (lower(v_escaped) || '%') ESCAPE '\' THEN 2
      ELSE 3
    END,
    p.full_name ASC
  LIMIT 10;
END;
$function$;

-- Helper returning the canonical staff role list used across Zoe gates
CREATE OR REPLACE FUNCTION public.staff_assistant_write_or_read_roles_list()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT ARRAY[
    'employee',
    'operations',
    'tenant_ops',
    'landlord_ops',
    'agent_ops',
    'partner_ops',
    'financial_ops',
    'service_center',
    'crm',
    'hr',
    'cfo',
    'coo',
    'ceo',
    'cto',
    'cmo',
    'manager',
    'admin',
    'super_admin'
  ]::text[];
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_write_or_read_roles_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_write_or_read_roles_list() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.staff_assistant_email_recipients(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_email_recipients(text) TO authenticated;

-- 7b. Update staff_assistant_is_staff_email so both authenticated staff AND service_role
--     (the cron schedule runner) can verify recipient emails.
CREATE OR REPLACE FUNCTION public.staff_assistant_is_staff_email(
  p_email text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role text := COALESCE(auth.role(), '');
  v_uid uuid := (SELECT auth.uid());
  v_clean text := lower(COALESCE(public.assistant_real_email(btrim(p_email)), ''));
BEGIN
  IF v_caller_role <> 'service_role' THEN
    IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
      RETURN false;
    END IF;
  END IF;

  IF v_clean = '' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE lower(public.assistant_real_email(btrim(p.email))) = v_clean
      AND COALESCE(p.is_frozen, false) IS FALSE
      AND (
        EXISTS (
          SELECT 1
          FROM public.user_roles ur
          WHERE ur.user_id = p.id
            AND ur.enabled IS TRUE
            AND ur.role::text = ANY (public.staff_assistant_write_or_read_roles_list())
        )
        OR EXISTS (
          SELECT 1
          FROM public.hr_staff hs
          WHERE hs.user_id = p.id
            AND hs.active IS TRUE
            AND hs.ended_on IS NULL
        )
      )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_is_staff_email(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_is_staff_email(text) TO authenticated, service_role;

-- 7c. Check whether a target user (recipient or owner) is allowed by their own roles
--     and permissions to read a given assistant_staff_* report RPC (Finding H5).
CREATE OR REPLACE FUNCTION public.staff_assistant_can_user_read_report(
  p_user_id uuid,
  p_report_rpc text,
  p_owner_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role text := COALESCE(auth.role(), '');
  v_caller_uid uuid := (SELECT auth.uid());
  v_rpc text := lower(btrim(COALESCE(p_report_rpc, '')));
  v_roles text[];
BEGIN
  IF v_caller_role <> 'service_role' THEN
    IF v_caller_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
      RETURN false;
    END IF;
  END IF;

  IF p_user_id IS NULL OR v_rpc !~ '^assistant_staff_[a-z0-9_]+$' THEN
    RETURN false;
  END IF;

  -- Target user must be an active, non-frozen staff member with Zoe access
  IF NOT EXISTS (
    SELECT 1
    FROM public.staff_assistant_config c
    WHERE c.id = true AND c.enabled = true
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_user_id
      AND COALESCE(p.is_frozen, false) IS TRUE
  ) THEN
    RETURN false;
  END IF;

  SELECT COALESCE(
    array_agg(DISTINCT lower(ur.role::text)) FILTER (WHERE ur.enabled IS TRUE),
    ARRAY[]::text[]
  )
    INTO v_roles
    FROM public.user_roles ur
   WHERE ur.user_id = p_user_id
     AND ur.enabled IS TRUE;

  IF NOT (
    v_roles && public.staff_assistant_write_or_read_roles_list()
    OR EXISTS (
      SELECT 1
      FROM public.hr_staff hs
      WHERE hs.user_id = p_user_id
        AND hs.active IS TRUE
        AND hs.ended_on IS NULL
    )
  ) THEN
    RETURN false;
  END IF;

  -- Personal My Space reports (assistant_staff_my_*) contain the owner's personal data:
  -- only the owner themselves can receive their personal My Space report!
  IF v_rpc LIKE 'assistant_staff_my_%' THEN
    RETURN (p_owner_id IS NULL OR p_user_id = p_owner_id);
  END IF;

  -- Group B: Tenant Ops reports
  IF v_rpc IN (
    'assistant_staff_tops_first_seven_summary',
    'assistant_staff_tops_tenant_classification',
    'assistant_staff_tops_smartphone_usage'
  ) THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin'];
  END IF;

  IF v_rpc IN (
    'assistant_staff_tops_arrears_ageing',
    'assistant_staff_tops_landlord_not_paid'
  ) THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cfo','super_admin'];
  END IF;

  IF v_rpc IN (
    'assistant_staff_tops_weekly_performance',
    'assistant_staff_tops_rent_request_lifetime',
    'assistant_staff_tops_pipeline_waiting_on_lops'
  ) THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cto','manager','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_tops_no_payment_report' THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin'];
  END IF;

  -- Group C: Landlord Ops reports
  IF v_rpc = 'assistant_staff_lops_home_range' THEN
    RETURN v_roles && ARRAY['landlord_ops','coo','cfo','ceo','manager','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_lops_paid_lists' THEN
    RETURN v_roles && ARRAY['landlord_ops','coo','cfo','ceo','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_lops_principal_comparison' THEN
    RETURN v_roles && ARRAY['landlord_ops','cfo','ceo','coo','manager','financial_ops','super_admin','cto'];
  END IF;

  IF v_rpc IN (
    'assistant_staff_lops_calling_summary',
    'assistant_staff_lops_calling_coverage'
  ) THEN
    RETURN v_roles && ARRAY['landlord_ops','operations','coo','ceo','cfo','cto','manager','hr','super_admin'];
  END IF;

  -- Group D: Agent Ops reports
  IF v_rpc = 'assistant_staff_aops_network_overview' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_aops_metrics_totals',
    'assistant_staff_aops_metrics_agents',
    'assistant_staff_aops_listing_quality_and_risk'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['agent_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_aops_silent_collectors' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['agent_ops','tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  -- Group E: Partner Ops & PSO
  IF v_rpc IN (
    'assistant_staff_pops_pending_summary',
    'assistant_staff_pops_search_supporters'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['partner_ops','cfo','ceo','coo','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_pops_report_overview' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['partner_ops','financial_ops','cfo','ceo','coo','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_pso_cohort_performance' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['partner_ops','hr','coo','ceo','super_admin']);
  END IF;

  -- Group F: CFO & Financial Ops
  IF v_rpc IN (
    'assistant_staff_cfo_treasury_cash_position',
    'assistant_staff_cfo_receivables_and_payables',
    'assistant_staff_cfo_seven_day_expenses'
  ) THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['cfo','ceo','coo','manager','financial_ops','cto','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_cfo_money_flow_summary' THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['cfo','ceo','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_cfo_budget_revised_position' THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['cfo','ceo','coo','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_fops_verification_and_requisitions' THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['financial_ops','cfo','ceo','coo','super_admin']);
  END IF;

  -- Group G: COO, CEO & Managers
  IF v_rpc IN (
    'assistant_staff_coo_overview',
    'assistant_staff_ceo_growth_and_approvals'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['coo','ceo','cfo','manager','super_admin']);
  END IF;

  -- Group H: HR & Calling
  IF v_rpc = 'assistant_staff_hr_calling_detailed_report' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (
         p_user_id IN (
           '5295252d-f477-42a9-92f5-af56e503e33d'::uuid,
           'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid,
           'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid,
           'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid
         )
         OR (v_roles && ARRAY['hr','tenant_ops','landlord_ops','operations','coo','cfo','ceo','manager','super_admin'])
       );
  END IF;

  IF v_rpc = 'assistant_staff_hr_contracts_and_birthdays' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['hr','coo','ceo','cfo','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_hr_payroll_cost_by_department' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['hr','cfo','coo','ceo','super_admin']);
  END IF;

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8. Update Action Confirm RPCs to require server-stored drafts, take sender
--    name from profiles, validate link_path, and cap notifications at 30/day
-- -----------------------------------------------------------------------------

-- 8a. Reminder confirm RPC (with draft consumption)
DROP FUNCTION IF EXISTS public.staff_assistant_create_reminder(text, timestamptz, text, uuid);
CREATE OR REPLACE FUNCTION public.staff_assistant_create_reminder(
  p_title           text,
  p_remind_at       timestamptz,
  p_note            text DEFAULT NULL,
  p_conversation_id uuid DEFAULT NULL,
  p_draft_id        uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_title      text := btrim(COALESCE(p_title, ''));
  v_note       text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_active_cnt integer;
  v_row        public.staff_assistant_reminders;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_title) < 2 OR char_length(v_title) > 200 THEN
    RAISE EXCEPTION 'Reminder title must be between 2 and 200 characters.' USING ERRCODE = '22023';
  END IF;

  IF v_note IS NOT NULL AND char_length(v_note) > 600 THEN
    RAISE EXCEPTION 'Reminder note must be at most 600 characters.' USING ERRCODE = '22023';
  END IF;

  IF p_remind_at IS NULL OR p_remind_at < (now() - interval '5 minutes') THEN
    RAISE EXCEPTION 'Reminder time must be in the future.' USING ERRCODE = '22023';
  END IF;

  -- Consume server-stored draft (enforces owner, 30-min expiry, unused, and matching payload hash)
  PERFORM public.staff_assistant_consume_draft(
    p_draft_id,
    'reminder',
    jsonb_build_object(
      'kind', 'reminder',
      'title', v_title,
      'remind_at', p_remind_at,
      'note', v_note
    )
  );

  -- Serialize per-user reminder creation
  PERFORM pg_advisory_xact_lock(hashtext('zoe_rem_rate_' || v_uid::text));

  SELECT count(*)::integer
    INTO v_active_cnt
    FROM public.staff_assistant_reminders r
   WHERE r.user_id = v_uid
     AND r.status = 'pending';

  IF v_active_cnt >= 50 THEN
    RAISE EXCEPTION 'You already have 50 active reminders. Please cancel an older reminder first.'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.staff_assistant_reminders (
    user_id,
    title,
    note,
    remind_at,
    status,
    conversation_id
  )
  VALUES (
    v_uid,
    v_title,
    v_note,
    p_remind_at,
    'pending',
    p_conversation_id
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_reminder_created',
    'staff_assistant_reminders',
    v_row.id::text,
    jsonb_build_object(
      'title', v_row.title,
      'remind_at', v_row.remind_at,
      'draft_id', p_draft_id,
      'conversation_id', p_conversation_id
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

REVOKE ALL ON FUNCTION public.staff_assistant_create_reminder(text, timestamptz, text, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_create_reminder(text, timestamptz, text, uuid, uuid) TO authenticated;

-- 8b. Colleague notification confirm RPC (consumes draft, validates link_path, caps at 30/day)
DROP FUNCTION IF EXISTS public.staff_assistant_send_colleague_notification(text, text, text, text, uuid);
CREATE OR REPLACE FUNCTION public.staff_assistant_send_colleague_notification(
  p_recipient_email text,
  p_title           text,
  p_message         text,
  p_link_path       text DEFAULT '/me',
  p_conversation_id uuid DEFAULT NULL,
  p_draft_id        uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid             uuid := (SELECT auth.uid());
  v_clean_email     text := lower(btrim(COALESCE(p_recipient_email, '')));
  v_title           text := btrim(COALESCE(p_title, ''));
  v_message         text := btrim(COALESCE(p_message, ''));
  v_link            text := COALESCE(NULLIF(btrim(COALESCE(p_link_path, '')), ''), '/me');
  v_sender_name     text;
  v_recipient       record;
  v_notif_id        uuid;
  v_kampala_start   timestamptz;
  v_sent_today      integer := 0;
  v_max_notifs      integer := 30;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_title) < 2 OR char_length(v_title) > 160 THEN
    RAISE EXCEPTION 'Notification title must be between 2 and 160 characters.' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_message) < 2 OR char_length(v_message) > 600 THEN
    RAISE EXCEPTION 'Notification message must be between 2 and 600 characters.' USING ERRCODE = '22023';
  END IF;

  -- Validate link_path against the app's route list
  IF NOT public.staff_assistant_is_valid_link_path(v_link) THEN
    RAISE EXCEPTION 'Invalid notification link_path (%). Only internal Welile app routes are allowed.', v_link
      USING ERRCODE = '22023';
  END IF;

  IF NOT public.staff_assistant_is_staff_email(v_clean_email) THEN
    RAISE EXCEPTION 'Recipient must be an active Welile staff member.' USING ERRCODE = '42501';
  END IF;

  SELECT r.staff_user_id, r.full_name, r.email
    INTO v_recipient
    FROM public.staff_assistant_email_recipients(v_clean_email) r
   WHERE lower(r.email) = v_clean_email
   LIMIT 1;

  IF v_recipient.staff_user_id IS NULL THEN
    RAISE EXCEPTION 'Recipient must be an active Welile staff member.' USING ERRCODE = '42501';
  END IF;

  -- Consume server-stored draft
  PERFORM public.staff_assistant_consume_draft(
    p_draft_id,
    'notification',
    jsonb_build_object(
      'kind', 'notification',
      'recipient_email', v_clean_email,
      'title', v_title,
      'message', v_message,
      'link_path', v_link
    )
  );

  -- Atomic daily notification rate limit (30/day)
  PERFORM pg_advisory_xact_lock(hashtext('zoe_notif_rate_' || v_uid::text));

  SELECT COALESCE(c.max_notifications_per_day, 30)
    INTO v_max_notifs
    FROM public.staff_assistant_config c
   WHERE c.id = true;

  v_kampala_start := ((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamp AT TIME ZONE 'Africa/Kampala';

  SELECT count(*)::integer
    INTO v_sent_today
    FROM public.audit_logs al
   WHERE al.user_id = v_uid
     AND al.action_type = 'staff_assistant_colleague_notification_sent'
     AND al.created_at >= v_kampala_start;

  IF v_sent_today >= v_max_notifs THEN
    RAISE EXCEPTION 'Daily Zoe notification limit reached (% per day in Kampala time).', v_max_notifs
      USING ERRCODE = '22023';
  END IF;

  -- Take sender name strictly from public.profiles, never from user_metadata
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), 'Welile Staff')
    INTO v_sender_name
    FROM public.profiles p
   WHERE p.id = v_uid;

  INSERT INTO public.notifications (
    user_id,
    title,
    message,
    type,
    is_read,
    metadata
  )
  VALUES (
    v_recipient.staff_user_id,
    v_title,
    v_message,
    'staff_assistant',
    false,
    jsonb_build_object(
      'source', 'zoe_staff_assistant',
      'sender_user_id', v_uid,
      'sender_name', COALESCE(v_sender_name, 'Welile Staff'),
      'link_path', v_link,
      'draft_id', p_draft_id,
      'conversation_id', p_conversation_id
    )
  )
  RETURNING id INTO v_notif_id;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_colleague_notification_sent',
    'notifications',
    v_notif_id::text,
    jsonb_build_object(
      'recipient_user_id', v_recipient.staff_user_id,
      'recipient_email', v_recipient.email,
      'recipient_name', v_recipient.full_name,
      'title', v_title,
      'link_path', v_link,
      'draft_id', p_draft_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'notification_id', v_notif_id,
    'recipient_user_id', v_recipient.staff_user_id,
    'recipient_name', v_recipient.full_name,
    'recipient_email', v_recipient.email,
    'title', v_title,
    'remaining_notifications_today', GREATEST(v_max_notifs - (v_sent_today + 1), 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_send_colleague_notification(text, text, text, text, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_send_colleague_notification(text, text, text, text, uuid, uuid) TO authenticated;

-- 8c. Add MFA confirmation tracking to staff_assistant_schedules and update
--     staff_assistant_create_schedule to consume draft + verify recipient report access
ALTER TABLE public.staff_assistant_schedules
  ADD COLUMN IF NOT EXISTS mfa_confirmed_at timestamptz;

DROP FUNCTION IF EXISTS public.staff_assistant_create_schedule(text, text, text, jsonb, text, text[], integer, text, text, uuid);
CREATE OR REPLACE FUNCTION public.staff_assistant_create_schedule(
  p_title              text,
  p_report_tool        text,
  p_report_rpc         text,
  p_report_args        jsonb DEFAULT '{}'::jsonb,
  p_frequency          text DEFAULT 'daily',
  p_recipient_emails   text[] DEFAULT ARRAY[]::text[],
  p_day_of_week        integer DEFAULT NULL,
  p_send_time_kampala  text DEFAULT '07:30',
  p_custom_message     text DEFAULT NULL,
  p_conversation_id    uuid DEFAULT NULL,
  p_draft_id           uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid          uuid := (SELECT auth.uid());
  v_aal          text := COALESCE((SELECT auth.jwt() ->> 'aal'), 'aal1');
  v_title        text := btrim(COALESCE(p_title, ''));
  v_tool         text := btrim(COALESCE(p_report_tool, ''));
  v_rpc          text := btrim(COALESCE(p_report_rpc, ''));
  v_freq         text := lower(btrim(COALESCE(p_frequency, 'daily')));
  v_time         text := btrim(COALESCE(p_send_time_kampala, '07:30'));
  v_msg          text := NULLIF(btrim(COALESCE(p_custom_message, '')), '');
  v_dow          integer := CASE WHEN lower(btrim(COALESCE(p_frequency, 'daily'))) = 'weekly'
                                 THEN COALESCE(p_day_of_week, 1)
                                 ELSE NULL END;
  v_clean_emails text[] := ARRAY[]::text[];
  v_clean_names  text[] := ARRAY[]::text[];
  v_email        text;
  v_rec          record;
  v_active_cnt   integer;
  v_next_run     timestamptz;
  v_row          public.staff_assistant_schedules;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_title) < 2 OR char_length(v_title) > 160 THEN
    RAISE EXCEPTION 'Schedule title must be between 2 and 160 characters.' USING ERRCODE = '22023';
  END IF;

  IF v_rpc !~ '^assistant_staff_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Scheduled report must be an official assistant_staff_* function.' USING ERRCODE = '22023';
  END IF;

  -- Confirm the owner's own roles can read this report
  IF NOT public.staff_assistant_can_user_read_report(v_uid, v_rpc, v_uid) THEN
    RAISE EXCEPTION 'Your current role is not authorized to schedule report %.', v_rpc
      USING ERRCODE = '42501';
  END IF;

  IF v_freq NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'Schedule frequency must be daily or weekly.' USING ERRCODE = '22023';
  END IF;

  IF v_freq = 'weekly' AND (v_dow < 0 OR v_dow > 6) THEN
    RAISE EXCEPTION 'Weekly day_of_week must be between 0 (Sunday) and 6 (Saturday).' USING ERRCODE = '22023';
  END IF;

  IF p_recipient_emails IS NULL OR coalesce(array_length(p_recipient_emails, 1), 0) < 1 THEN
    RAISE EXCEPTION 'At least one Welile staff recipient email is required.' USING ERRCODE = '22023';
  END IF;

  IF array_length(p_recipient_emails, 1) > 10 THEN
    RAISE EXCEPTION 'A schedule may have at most 10 staff recipients.' USING ERRCODE = '22023';
  END IF;

  FOREACH v_email IN ARRAY p_recipient_emails LOOP
    v_email := lower(btrim(COALESCE(v_email, '')));
    IF v_email = '' OR NOT public.staff_assistant_is_staff_email(v_email) THEN
      RAISE EXCEPTION 'All scheduled report recipients must be active Welile staff emails (%).', v_email
        USING ERRCODE = '42501';
    END IF;

    SELECT r.staff_user_id, r.full_name, r.email
      INTO v_rec
      FROM public.staff_assistant_email_recipients(v_email) r
     WHERE lower(r.email) = v_email
     LIMIT 1;

    IF v_rec.staff_user_id IS NULL THEN
      RAISE EXCEPTION 'All scheduled report recipients must be active Welile staff emails (%).', v_email
        USING ERRCODE = '42501';
    END IF;

    -- Finding H5: verify that every recipient's own roles can read the scheduled report
    IF NOT public.staff_assistant_can_user_read_report(v_rec.staff_user_id, v_rpc, v_uid) THEN
      RAISE EXCEPTION 'Recipient % (%) does not hold a role permitted to view report %.',
        v_rec.full_name, v_rec.email, v_rpc
        USING ERRCODE = '42501';
    END IF;

    IF NOT (v_rec.email = ANY(v_clean_emails)) THEN
      v_clean_emails := array_append(v_clean_emails, v_rec.email);
      v_clean_names  := array_append(v_clean_names, COALESCE(v_rec.full_name, v_rec.email));
    END IF;
  END LOOP;

  -- Consume server-stored draft
  PERFORM public.staff_assistant_consume_draft(
    p_draft_id,
    'schedule',
    jsonb_build_object(
      'kind', 'schedule',
      'title', v_title,
      'report_tool', v_tool,
      'report_rpc', v_rpc,
      'report_args', COALESCE(p_report_args, '{}'::jsonb),
      'frequency', v_freq,
      'day_of_week', v_dow,
      'send_time_kampala', v_time,
      'recipient_emails', to_jsonb(v_clean_emails),
      'custom_message', v_msg
    )
  );

  PERFORM pg_advisory_xact_lock(hashtext('zoe_sched_rate_' || v_uid::text));

  SELECT count(*)::integer
    INTO v_active_cnt
    FROM public.staff_assistant_schedules s
   WHERE s.user_id = v_uid
     AND s.is_active = true;

  IF v_active_cnt >= 20 THEN
    RAISE EXCEPTION 'You already have 20 active report schedules. Please cancel an existing schedule first.'
      USING ERRCODE = '22023';
  END IF;

  v_next_run := public.staff_assistant_compute_next_run_at(v_freq, v_dow, v_time, now());

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
    is_active,
    next_run_at,
    conversation_id,
    mfa_confirmed_at
  )
  VALUES (
    v_uid,
    v_title,
    v_tool,
    v_rpc,
    COALESCE(p_report_args, '{}'::jsonb),
    v_freq,
    v_dow,
    v_time,
    v_clean_emails,
    v_clean_names,
    v_msg,
    true,
    v_next_run,
    p_conversation_id,
    CASE WHEN v_aal = 'aal2' THEN now() ELSE NULL END
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_schedule_created',
    'staff_assistant_schedules',
    v_row.id::text,
    jsonb_build_object(
      'title', v_row.title,
      'report_tool', v_row.report_tool,
      'report_rpc', v_row.report_rpc,
      'frequency', v_row.frequency,
      'day_of_week', v_row.day_of_week,
      'send_time_kampala', v_row.send_time_kampala,
      'recipient_emails', v_row.recipient_emails,
      'next_run_at', v_row.next_run_at,
      'mfa_confirmed_at', v_row.mfa_confirmed_at,
      'draft_id', p_draft_id
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
      'is_active', v_row.is_active,
      'next_run_at', v_row.next_run_at,
      'next_run_kampala', to_char(v_row.next_run_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD HH24:MI'),
      'mfa_confirmed_at', v_row.mfa_confirmed_at
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_create_schedule(text, text, text, jsonb, text, text[], integer, text, text, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_create_schedule(text, text, text, jsonb, text, text[], integer, text, text, uuid, uuid) TO authenticated;

-- Allow an owner who has just completed a fresh two-step login (aal2) to re-confirm a schedule
CREATE OR REPLACE FUNCTION public.staff_assistant_confirm_schedule_mfa(
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
  v_aal text := COALESCE((SELECT auth.jwt() ->> 'aal'), 'aal1');
  v_row public.staff_assistant_schedules;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF v_aal <> 'aal2' THEN
    RAISE EXCEPTION 'Two-step verification (AAL2) is required to confirm MFA for this schedule.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.staff_assistant_schedules
     SET mfa_confirmed_at = now(),
         updated_at = now()
   WHERE id = p_schedule_id
     AND user_id = v_uid
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Schedule not found.' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'schedule_id', v_row.id,
    'mfa_confirmed_at', v_row.mfa_confirmed_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_confirm_schedule_mfa(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_confirm_schedule_mfa(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 9. Fix Schedule Runner SQL helpers (Finding H3):
--    - Never forge 'aal2' in request.jwt.claims (use 'aal1').
--    - Run inside a read-only transaction (SET LOCAL transaction_read_only = on).
--    - Pass p_report_args so the chosen period / filter is honored.
--    - Register the pg_cron job.
-- -----------------------------------------------------------------------------
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
  v_old_claims text := current_setting('request.jwt.claims', true);
  v_old_sub    text := current_setting('request.jwt.claim.sub', true);
  v_old_role   text := current_setting('request.jwt.claim.role', true);
  v_ok         boolean := false;
BEGIN
  IF p_owner_id IS NULL THEN
    RETURN false;
  END IF;

  -- Never forge aal2 in background checks; use aal1
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_owner_id::text, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', p_owner_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  v_ok := public.staff_assistant_has_access();

  PERFORM set_config('request.jwt.claims', COALESCE(v_old_claims, ''), true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_old_sub, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_old_role, ''), true);

  RETURN COALESCE(v_ok, false);
EXCEPTION
  WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claims', COALESCE(v_old_claims, ''), true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_old_sub, ''), true);
    PERFORM set_config('request.jwt.claim.role', COALESCE(v_old_role, ''), true);
    RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_check_owner_access(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_assistant_check_owner_access(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.staff_assistant_run_scheduled_report_as_owner(
  p_owner_id    uuid,
  p_report_rpc  text,
  p_report_args jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_old_claims text := current_setting('request.jwt.claims', true);
  v_old_sub    text := current_setting('request.jwt.claim.sub', true);
  v_old_role   text := current_setting('request.jwt.claim.role', true);
  v_rpc        text := lower(btrim(COALESCE(p_report_rpc, '')));
  v_args       jsonb := COALESCE(p_report_args, '{}'::jsonb);
  v_from       date := NULLIF(btrim(COALESCE(v_args ->> 'p_from', v_args ->> 'from', '')), '')::date;
  v_to         date := NULLIF(btrim(COALESCE(v_args ->> 'p_to', v_args ->> 'to', '')), '')::date;
  v_as_at_date date := NULLIF(btrim(COALESCE(v_args ->> 'p_as_at', v_args ->> 'as_at', '')), '')::date;
  v_days       integer := CASE WHEN (v_args ->> 'p_days') ~ '^[0-9]+$' THEN (v_args ->> 'p_days')::integer ELSE NULL END;
  v_limit      integer := CASE WHEN (v_args ->> 'p_limit') ~ '^[0-9]+$' THEN (v_args ->> 'p_limit')::integer ELSE NULL END;
  v_status     text := NULLIF(btrim(COALESCE(v_args ->> 'p_status', v_args ->> 'status', '')), '');
  v_search     text := NULLIF(btrim(COALESCE(v_args ->> 'p_search', v_args ->> 'search', '')), '');
  v_tab        text := NULLIF(btrim(COALESCE(v_args ->> 'p_tab', v_args ->> 'tab', '')), '');
  v_bucket     text := NULLIF(btrim(COALESCE(v_args ->> 'p_bucket', v_args ->> 'bucket', '')), '');
  v_result     jsonb;
BEGIN
  IF p_owner_id IS NULL THEN
    RAISE EXCEPTION 'owner_id is required' USING ERRCODE = '22023';
  END IF;

  IF v_rpc !~ '^assistant_staff_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Only assistant_staff_* report functions may be run by the schedule runner.'
      USING ERRCODE = '22023';
  END IF;

  -- Never forge aal2 in scheduled runs; set aal1
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_owner_id::text, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', p_owner_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  IF NOT public.staff_assistant_has_access()
     OR NOT public.staff_assistant_can_user_read_report(p_owner_id, v_rpc, p_owner_id)
  THEN
    PERFORM set_config('request.jwt.claims', COALESCE(v_old_claims, ''), true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_old_sub, ''), true);
    PERFORM set_config('request.jwt.claim.role', COALESCE(v_old_role, ''), true);
    RAISE EXCEPTION 'Owner no longer has Zoe staff access for this report.' USING ERRCODE = '42501';
  END IF;

  -- Dispatch to the matching STABLE assistant_staff_* function, passing p_report_args
  CASE v_rpc
    WHEN 'assistant_staff_my_profile' THEN
      v_result := public.assistant_staff_my_profile();
    WHEN 'assistant_staff_my_payslips' THEN
      v_result := public.assistant_staff_my_payslips();
    WHEN 'assistant_staff_my_tasks' THEN
      v_result := public.assistant_staff_my_tasks(v_status);
    WHEN 'assistant_staff_my_tickets' THEN
      v_result := public.assistant_staff_my_tickets();
    WHEN 'assistant_staff_my_requisitions' THEN
      v_result := public.assistant_staff_my_requisitions();
    WHEN 'assistant_staff_my_advances' THEN
      v_result := public.assistant_staff_my_advances();
    WHEN 'assistant_staff_my_pending_concerns' THEN
      v_result := public.assistant_staff_my_pending_concerns();
    WHEN 'assistant_staff_my_canteen' THEN
      v_result := public.assistant_staff_my_canteen(COALESCE(v_from, v_as_at_date));
    WHEN 'assistant_staff_my_wallet' THEN
      v_result := public.assistant_staff_my_wallet();
    WHEN 'assistant_staff_my_reminders_and_schedules' THEN
      v_result := public.assistant_staff_my_reminders_and_schedules(false);
    WHEN 'assistant_staff_tops_first_seven_summary' THEN
      v_result := public.assistant_staff_tops_first_seven_summary(v_from, v_to, NULLIF(btrim(COALESCE(v_args ->> 'p_frequency', '')), ''));
    WHEN 'assistant_staff_tops_arrears_ageing' THEN
      v_result := public.assistant_staff_tops_arrears_ageing(v_as_at_date, v_bucket, COALESCE(v_limit, 50), 0, 'desc');
    WHEN 'assistant_staff_tops_landlord_not_paid' THEN
      v_result := public.assistant_staff_tops_landlord_not_paid(v_as_at_date, COALESCE(v_limit, 200), 0);
    WHEN 'assistant_staff_tops_tenant_classification' THEN
      v_result := public.assistant_staff_tops_tenant_classification();
    WHEN 'assistant_staff_tops_smartphone_usage' THEN
      v_result := public.assistant_staff_tops_smartphone_usage(v_from, v_to);
    WHEN 'assistant_staff_tops_weekly_performance' THEN
      v_result := public.assistant_staff_tops_weekly_performance(COALESCE(v_as_at_date, v_to));
    WHEN 'assistant_staff_tops_no_payment_report' THEN
      v_result := public.assistant_staff_tops_no_payment_report(COALESCE(v_days, 20));
    WHEN 'assistant_staff_tops_rent_request_lifetime' THEN
      v_result := public.assistant_staff_tops_rent_request_lifetime();
    WHEN 'assistant_staff_tops_pipeline_waiting_on_lops' THEN
      v_result := public.assistant_staff_tops_pipeline_waiting_on_lops(COALESCE(v_limit, 50));
    WHEN 'assistant_staff_lops_home_range' THEN
      v_result := public.assistant_staff_lops_home_range(v_from, v_to);
    WHEN 'assistant_staff_lops_paid_lists' THEN
      v_result := public.assistant_staff_lops_paid_lists(COALESCE(v_tab, 'paid_repaying'), v_search, COALESCE(v_limit, 50), 0);
    WHEN 'assistant_staff_lops_principal_comparison' THEN
      v_result := public.assistant_staff_lops_principal_comparison(v_from, v_to);
    WHEN 'assistant_staff_lops_calling_summary' THEN
      v_result := public.assistant_staff_lops_calling_summary(v_from, v_to, NULLIF(btrim(COALESCE(v_args ->> 'p_week_start', '')), '')::date);
    WHEN 'assistant_staff_lops_calling_coverage' THEN
      v_result := public.assistant_staff_lops_calling_coverage(NULL);
    WHEN 'assistant_staff_aops_network_overview' THEN
      v_result := public.assistant_staff_aops_network_overview(v_from, v_to, 50000);
    WHEN 'assistant_staff_aops_metrics_totals' THEN
      v_result := public.assistant_staff_aops_metrics_totals(v_from, v_to);
    WHEN 'assistant_staff_aops_metrics_agents' THEN
      v_result := public.assistant_staff_aops_metrics_agents(v_from, v_to, v_search, 'houses_listed', 'qualifying', COALESCE(v_limit, 50));
    WHEN 'assistant_staff_aops_listing_quality_and_risk' THEN
      v_result := public.assistant_staff_aops_listing_quality_and_risk(v_from, v_to, COALESCE(v_limit, 50));
    WHEN 'assistant_staff_aops_silent_collectors' THEN
      v_result := public.assistant_staff_aops_silent_collectors(COALESCE(v_days, 3), COALESCE(v_limit, 50));
    WHEN 'assistant_staff_pops_pending_summary' THEN
      v_result := public.assistant_staff_pops_pending_summary(v_from);
    WHEN 'assistant_staff_pops_report_overview' THEN
      v_result := public.assistant_staff_pops_report_overview(v_from, v_to);
    WHEN 'assistant_staff_pops_search_supporters' THEN
      v_result := public.assistant_staff_pops_search_supporters(v_search, COALESCE(v_limit, 50));
    WHEN 'assistant_staff_pso_cohort_performance' THEN
      v_result := public.assistant_staff_pso_cohort_performance(v_from, v_to);
    WHEN 'assistant_staff_cfo_treasury_cash_position' THEN
      v_result := public.assistant_staff_cfo_treasury_cash_position(NULL);
    WHEN 'assistant_staff_cfo_money_flow_summary' THEN
      v_result := public.assistant_staff_cfo_money_flow_summary();
    WHEN 'assistant_staff_cfo_receivables_and_payables' THEN
      v_result := public.assistant_staff_cfo_receivables_and_payables('week', 4, v_as_at_date);
    WHEN 'assistant_staff_cfo_seven_day_expenses' THEN
      v_result := public.assistant_staff_cfo_seven_day_expenses();
    WHEN 'assistant_staff_cfo_budget_revised_position' THEN
      v_result := public.assistant_staff_cfo_budget_revised_position();
    WHEN 'assistant_staff_fops_verification_and_requisitions' THEN
      v_result := public.assistant_staff_fops_verification_and_requisitions(v_from, v_to);
    WHEN 'assistant_staff_coo_overview' THEN
      v_result := public.assistant_staff_coo_overview(COALESCE(v_days, 14), v_from, v_to);
    WHEN 'assistant_staff_ceo_growth_and_approvals' THEN
      v_result := public.assistant_staff_ceo_growth_and_approvals(COALESCE(v_days, 30));
    WHEN 'assistant_staff_hr_calling_detailed_report' THEN
      v_result := public.assistant_staff_hr_calling_detailed_report(v_from, v_to);
    WHEN 'assistant_staff_hr_contracts_and_birthdays' THEN
      v_result := public.assistant_staff_hr_contracts_and_birthdays(COALESCE(v_days, 60));
    WHEN 'assistant_staff_hr_payroll_cost_by_department' THEN
      v_result := public.assistant_staff_hr_payroll_cost_by_department(NULLIF(btrim(COALESCE(v_args ->> 'p_period_code', '')), ''));
    ELSE
      RAISE EXCEPTION 'Unknown assistant_staff_* report RPC: %', v_rpc USING ERRCODE = '22023';
  END CASE;

  PERFORM set_config('request.jwt.claims', COALESCE(v_old_claims, ''), true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_old_sub, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_old_role, ''), true);

  RETURN COALESCE(v_result, '{}'::jsonb);
EXCEPTION
  WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claims', COALESCE(v_old_claims, ''), true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_old_sub, ''), true);
    PERFORM set_config('request.jwt.claim.role', COALESCE(v_old_role, ''), true);
    RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_run_scheduled_report_as_owner(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_assistant_run_scheduled_report_as_owner(uuid, text, jsonb) TO service_role;

-- Register pg_cron job for staff-assistant-schedule-runner (every 15 minutes)
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('staff-assistant-schedule-runner-every-15m');
    EXCEPTION
      WHEN OTHERS THEN NULL;
    END;

    PERFORM cron.schedule(
      'staff-assistant-schedule-runner-every-15m',
      '*/15 * * * *',
      $cron$SELECT public.staff_assistant_dispatch_due_reminders();$cron$
    );
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END
$do$;

-- -----------------------------------------------------------------------------
-- 10. CRM Review Screen Redaction (Finding H1):
--     Reviewers see the question, time, role, tool names, outcome, thumbs and
--     comment — NEVER assistant answer content, report_payload, or any figures.
-- -----------------------------------------------------------------------------

-- Drop direct CRM SELECT policy on staff_assistant_messages so a CRM reviewer
-- cannot SELECT content or report_payload directly from the table
DROP POLICY IF EXISTS "CRM team reads staff_assistant_messages" ON public.staff_assistant_messages;

-- Create a redacted view for CRM reviewers that strips assistant answer text and report_payload
CREATE OR REPLACE VIEW public.v_staff_assistant_crm_messages_redacted
WITH (security_invoker = false)
AS
SELECT
  m.id,
  m.conversation_id,
  m.user_id,
  m.role,
  CASE
    WHEN m.role = 'user' THEN m.content
    ELSE NULL
  END AS question_text,
  m.outcome,
  m.tools_called,
  m.source_label,
  m.period_label,
  m.model,
  m.latency_ms,
  m.created_at
FROM public.staff_assistant_messages m
WHERE (SELECT public.staff_assistant_crm_can_review())
  AND (SELECT public.staff_mfa_ok());

REVOKE ALL ON TABLE public.v_staff_assistant_crm_messages_redacted FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.v_staff_assistant_crm_messages_redacted TO authenticated, service_role;

-- Update staff_assistant_crm_review_dashboard so it never returns last_assistant_reply,
-- assistant answer content, report_payload, or figures
CREATE OR REPLACE FUNCTION public.staff_assistant_crm_review_dashboard(
  p_role_filter     text    DEFAULT NULL,
  p_thumbs_down     boolean DEFAULT false,
  p_unanswered_only boolean DEFAULT false,
  p_search          text    DEFAULT NULL,
  p_days            integer DEFAULT 14,
  p_limit           integer DEFAULT 80
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid           uuid := (SELECT auth.uid());
  v_days          integer := LEAST(GREATEST(COALESCE(p_days, 14), 1), 90);
  v_limit         integer := LEAST(GREATEST(COALESCE(p_limit, 80), 1), 200);
  v_role_filter   text := NULLIF(lower(btrim(COALESCE(p_role_filter, ''))), '');
  v_search        text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_search_esc    text;
  v_now_kampala   timestamp := (now() AT TIME ZONE 'Africa/Kampala');
  v_today_kampala date := v_now_kampala::date;
  v_today_start   timestamptz := (v_today_kampala::timestamp AT TIME ZONE 'Africa/Kampala');
  v_since         timestamptz := ((v_today_kampala - (v_days - 1))::timestamp AT TIME ZONE 'Africa/Kampala');
  v_week_start    timestamptz := ((v_today_kampala - 6)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_cfg           record;
  v_conversations jsonb;
  v_weekly_unans  jsonb;
  v_daily_usage   jsonb;
  v_role_options  jsonb;
  v_totals        jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_crm_can_review() THEN
    RAISE EXCEPTION 'staff_assistant_crm_not_authorized'
      USING ERRCODE = '42501';
  END IF;

  IF v_search IS NOT NULL THEN
    v_search_esc := regexp_replace(v_search, '([\\_%])', '\\\1', 'g');
  END IF;

  SELECT
    COALESCE(c.enabled, true)              AS enabled,
    COALESCE(c.max_questions_per_day, 80)  AS max_questions_per_day,
    COALESCE(c.max_emails_per_day, 30)     AS max_emails_per_day,
    c.updated_at                           AS updated_at
  INTO v_cfg
  FROM public.staff_assistant_config c
  WHERE c.id = true;

  IF NOT FOUND THEN
    v_cfg := ROW(true, 80, 30, now());
  END IF;

  -- 1. Conversations list (REDACTED: question, time, role, tool names, outcome, thumbs, comment; NO assistant answer or report_payload)
  WITH staff_roles_by_user AS (
    SELECT
      ur.user_id,
      array_agg(DISTINCT ur.role::text ORDER BY ur.role::text) AS roles
    FROM public.user_roles ur
    WHERE ur.enabled = true
    GROUP BY ur.user_id
  ),
  conv_stats AS (
    SELECT
      m.conversation_id,
      count(*) FILTER (WHERE m.role = 'user')::int AS question_count,
      count(*) FILTER (WHERE m.role = 'assistant')::int AS answer_count,
      count(*) FILTER (
        WHERE m.role = 'assistant'
          AND m.outcome IN ('unmatched', 'out_of_scope', 'role_restricted', 'mfa_required', 'error', 'rate_limited', 'daily_limit')
      )::int AS could_not_answer_count,
      (
        ARRAY_AGG(m.content ORDER BY m.created_at DESC)
        FILTER (WHERE m.role = 'user')
      )[1] AS last_user_question,
      (
        ARRAY_AGG(m.outcome ORDER BY m.created_at DESC)
        FILTER (WHERE m.role = 'assistant')
      )[1] AS last_outcome,
      (
        ARRAY_AGG(m.source_label ORDER BY m.created_at DESC)
        FILTER (WHERE m.role = 'assistant' AND m.source_label IS NOT NULL)
      )[1] AS last_source_label,
      (
        ARRAY_AGG(m.period_label ORDER BY m.created_at DESC)
        FILTER (WHERE m.role = 'assistant' AND m.period_label IS NOT NULL)
      )[1] AS last_period_label,
      COALESCE(
        ARRAY(
          SELECT DISTINCT tool_name
          FROM public.staff_assistant_messages m2,
               unnest(COALESCE(m2.tools_called, ARRAY[]::text[])) AS tool_name
          WHERE m2.conversation_id = m.conversation_id
          ORDER BY tool_name
        ),
        ARRAY[]::text[]
      ) AS tools_called
    FROM public.staff_assistant_messages m
    WHERE m.created_at >= v_since
    GROUP BY m.conversation_id
  ),
  fb_stats AS (
    SELECT
      f.conversation_id,
      count(*) FILTER (WHERE f.rating = 'up')::int   AS thumbs_up_count,
      count(*) FILTER (WHERE f.rating = 'down')::int AS thumbs_down_count,
      (
        ARRAY_AGG(f.comment ORDER BY f.created_at DESC)
        FILTER (WHERE f.rating = 'down' AND f.comment IS NOT NULL AND btrim(f.comment) <> '')
      )[1] AS latest_down_comment
    FROM public.staff_assistant_feedback f
    GROUP BY f.conversation_id
  ),
  unans_conv AS (
    SELECT
      u.conversation_id,
      count(*)::int AS unanswered_logs_count,
      (ARRAY_AGG(u.reason ORDER BY u.created_at DESC))[1] AS latest_unanswered_reason
    FROM public.staff_assistant_unanswered u
    WHERE u.conversation_id IS NOT NULL
    GROUP BY u.conversation_id
  ),
  enriched AS (
    SELECT
      c.id AS conversation_id,
      c.user_id,
      COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff Member') AS staff_name,
      COALESCE(NULLIF(btrim(p.email), ''), '')                 AS staff_email,
      COALESCE(sr.roles, ARRAY['employee']::text[])            AS roles,
      COALESCE(NULLIF(btrim(c.title), ''), COALESCE(cs.last_user_question, 'Zoe Conversation')) AS title,
      c.created_at,
      c.last_message_at,
      COALESCE(cs.question_count, 0)         AS question_count,
      COALESCE(cs.answer_count, 0)           AS answer_count,
      COALESCE(cs.could_not_answer_count, 0) AS could_not_answer_count,
      COALESCE(uc.unanswered_logs_count, 0)  AS unanswered_logs_count,
      (COALESCE(cs.could_not_answer_count, 0) > 0 OR COALESCE(uc.unanswered_logs_count, 0) > 0) AS has_unanswered,
      cs.last_user_question,
      cs.last_outcome,
      cs.last_source_label,
      cs.last_period_label,
      COALESCE(cs.tools_called, ARRAY[]::text[]) AS tools_called,
      COALESCE(fb.thumbs_up_count, 0)        AS thumbs_up_count,
      COALESCE(fb.thumbs_down_count, 0)      AS thumbs_down_count,
      fb.latest_down_comment,
      uc.latest_unanswered_reason
    FROM public.staff_assistant_conversations c
    LEFT JOIN public.profiles p        ON p.id = c.user_id
    LEFT JOIN staff_roles_by_user sr   ON sr.user_id = c.user_id
    LEFT JOIN conv_stats cs            ON cs.conversation_id = c.id
    LEFT JOIN fb_stats fb              ON fb.conversation_id = c.id
    LEFT JOIN unans_conv uc            ON uc.conversation_id = c.id
    WHERE c.last_message_at >= v_since
  )
  SELECT COALESCE(jsonb_agg(row_to_json(e)::jsonb ORDER BY e.last_message_at DESC), '[]'::jsonb)
  INTO v_conversations
  FROM (
    SELECT *
    FROM enriched e
    WHERE (v_role_filter IS NULL OR v_role_filter = ANY(e.roles))
      AND (NOT COALESCE(p_thumbs_down, false) OR e.thumbs_down_count > 0)
      AND (NOT COALESCE(p_unanswered_only, false) OR e.has_unanswered = true)
      AND (
        v_search_esc IS NULL
        OR e.staff_name ILIKE '%' || v_search_esc || '%' ESCAPE '\'
        OR e.staff_email ILIKE '%' || v_search_esc || '%' ESCAPE '\'
        OR e.title ILIKE '%' || v_search_esc || '%' ESCAPE '\'
        OR COALESCE(e.last_user_question, '') ILIKE '%' || v_search_esc || '%' ESCAPE '\'
      )
    ORDER BY e.last_message_at DESC
    LIMIT v_limit
  ) e;

  -- 2. Weekly summary of most-asked unanswered questions (last 7 Kampala days)
  WITH staff_roles_by_user AS (
    SELECT
      ur.user_id,
      array_agg(DISTINCT ur.role::text ORDER BY ur.role::text) AS roles
    FROM public.user_roles ur
    WHERE ur.enabled = true
    GROUP BY ur.user_id
  ),
  unans_raw AS (
    SELECT
      u.id,
      u.user_id,
      lower(regexp_replace(btrim(u.question), '\s+', ' ', 'g')) AS norm_question,
      btrim(u.question) AS display_question,
      u.reason,
      u.status,
      u.created_at,
      COALESCE(sr.roles, ARRAY['employee']::text[]) AS caller_roles
    FROM public.staff_assistant_unanswered u
    LEFT JOIN staff_roles_by_user sr ON sr.user_id = u.user_id
    WHERE u.created_at >= v_week_start
      AND (v_role_filter IS NULL OR v_role_filter = ANY(COALESCE(sr.roles, ARRAY['employee']::text[])))
  ),
  grouped_unans AS (
    SELECT
      ur.norm_question,
      (ARRAY_AGG(ur.display_question ORDER BY ur.created_at DESC))[1] AS question,
      count(*)::int AS ask_count,
      count(DISTINCT ur.user_id)::int AS staff_count,
      (ARRAY_AGG(ur.reason ORDER BY ur.created_at DESC))[1] AS top_reason,
      (ARRAY_AGG(ur.status ORDER BY ur.created_at DESC))[1] AS latest_status,
      max(ur.created_at) AS last_asked_at,
      ARRAY(
        SELECT DISTINCT r_role
        FROM unans_raw u2,
             unnest(u2.caller_roles) AS r_role
        WHERE u2.norm_question = ur.norm_question
        ORDER BY r_role
      ) AS roles_asking
    FROM unans_raw ur
    WHERE ur.norm_question <> ''
    GROUP BY ur.norm_question
    ORDER BY count(*) DESC, max(ur.created_at) DESC
    LIMIT 15
  )
  SELECT COALESCE(jsonb_agg(row_to_json(g)::jsonb), '[]'::jsonb)
  INTO v_weekly_unans
  FROM grouped_unans g;

  -- 3. Daily usage per person against the budget in staff_assistant_config (Kampala today)
  WITH staff_roles_by_user AS (
    SELECT
      ur.user_id,
      array_agg(DISTINCT ur.role::text ORDER BY ur.role::text) AS roles
    FROM public.user_roles ur
    WHERE ur.enabled = true
    GROUP BY ur.user_id
  ),
  questions_today AS (
    SELECT
      m.user_id,
      count(*) FILTER (WHERE m.role = 'user')::int AS questions_today,
      count(*) FILTER (WHERE m.role = 'assistant' AND m.outcome = 'answered')::int AS answered_today,
      count(*) FILTER (
        WHERE m.role = 'assistant'
          AND m.outcome IN ('unmatched', 'out_of_scope', 'role_restricted', 'mfa_required', 'error', 'rate_limited', 'daily_limit')
      )::int AS unanswered_today,
      max(m.created_at) AS last_active_at
    FROM public.staff_assistant_messages m
    WHERE m.created_at >= v_today_start
    GROUP BY m.user_id
  ),
  emails_today AS (
    SELECT
      al.user_id,
      COALESCE(
        sum(
          GREATEST(
            CASE
              WHEN (al.metadata ->> 'recipient_count') ~ '^[0-9]+$'
                THEN (al.metadata ->> 'recipient_count')::integer
              ELSE 1
            END,
            1
          )
        ),
        0
      )::int AS emails_sent_today
    FROM public.audit_logs al
    WHERE al.action_type IN ('staff_assistant_report_email_sent', 'staff_assistant_schedule_email_sent')
      AND al.created_at >= v_today_start
      AND al.user_id IS NOT NULL
    GROUP BY al.user_id
  ),
  active_people AS (
    SELECT user_id FROM questions_today
    UNION
    SELECT user_id FROM emails_today
  ),
  usage_rows AS (
    SELECT
      ap.user_id,
      COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff Member') AS staff_name,
      COALESCE(NULLIF(btrim(p.email), ''), '')                 AS staff_email,
      COALESCE(sr.roles, ARRAY['employee']::text[])            AS roles,
      COALESCE(qt.questions_today, 0)                          AS questions_today,
      v_cfg.max_questions_per_day                              AS question_budget,
      GREATEST(v_cfg.max_questions_per_day - COALESCE(qt.questions_today, 0), 0) AS questions_remaining,
      ROUND(
        (COALESCE(qt.questions_today, 0)::numeric / GREATEST(v_cfg.max_questions_per_day, 1)::numeric) * 100,
        1
      )                                                        AS question_budget_pct,
      COALESCE(qt.answered_today, 0)                           AS answered_today,
      COALESCE(qt.unanswered_today, 0)                         AS unanswered_today,
      COALESCE(et.emails_sent_today, 0)                        AS emails_sent_today,
      v_cfg.max_emails_per_day                                 AS email_budget,
      GREATEST(v_cfg.max_emails_per_day - COALESCE(et.emails_sent_today, 0), 0) AS emails_remaining,
      qt.last_active_at
    FROM active_people ap
    LEFT JOIN public.profiles p       ON p.id = ap.user_id
    LEFT JOIN staff_roles_by_user sr  ON sr.user_id = ap.user_id
    LEFT JOIN questions_today qt      ON qt.user_id = ap.user_id
    LEFT JOIN emails_today et         ON et.user_id = ap.user_id
    WHERE (v_role_filter IS NULL OR v_role_filter = ANY(COALESCE(sr.roles, ARRAY['employee']::text[])))
    ORDER BY COALESCE(qt.questions_today, 0) DESC, COALESCE(et.emails_sent_today, 0) DESC, staff_name ASC
    LIMIT 100
  )
  SELECT COALESCE(jsonb_agg(row_to_json(u)::jsonb), '[]'::jsonb)
  INTO v_daily_usage
  FROM usage_rows u;

  SELECT COALESCE(jsonb_agg(r_name ORDER BY r_name), '[]'::jsonb)
  INTO v_role_options
  FROM (
    SELECT DISTINCT ur.role::text AS r_name
    FROM public.user_roles ur
    JOIN public.staff_assistant_conversations c ON c.user_id = ur.user_id
    WHERE ur.enabled = true
  ) sub;

  SELECT jsonb_build_object(
    'total_conversations', (
      SELECT count(*)::int
      FROM public.staff_assistant_conversations c
      WHERE c.last_message_at >= v_since
    ),
    'thumbs_down_conversations', (
      SELECT count(DISTINCT f.conversation_id)::int
      FROM public.staff_assistant_feedback f
      WHERE f.rating = 'down'
        AND f.created_at >= v_since
    ),
    'unanswered_questions_7d', (
      SELECT count(*)::int
      FROM public.staff_assistant_unanswered u
      WHERE u.created_at >= v_week_start
    ),
    'active_staff_today', jsonb_array_length(v_daily_usage)
  )
  INTO v_totals;

  RETURN jsonb_build_object(
    'source', 'staff_assistant_crm_review_dashboard',
    'period', jsonb_build_object(
      'days', v_days,
      'since', (v_since AT TIME ZONE 'Africa/Kampala')::date,
      'today_kampala', v_today_kampala,
      'weekly_summary_from', (v_week_start AT TIME ZONE 'Africa/Kampala')::date,
      'weekly_summary_to', v_today_kampala
    ),
    'config', jsonb_build_object(
      'enabled', v_cfg.enabled,
      'max_questions_per_day', v_cfg.max_questions_per_day,
      'max_emails_per_day', v_cfg.max_emails_per_day,
      'updated_at', v_cfg.updated_at
    ),
    'totals', v_totals,
    'available_roles', v_role_options,
    'conversations', v_conversations,
    'weekly_unanswered_summary', v_weekly_unans,
    'daily_usage', v_daily_usage
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_crm_review_dashboard(text, boolean, boolean, text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_crm_review_dashboard(text, boolean, boolean, text, integer, integer) TO authenticated;

-- Update staff_assistant_crm_conversation_thread so it never returns assistant answer text,
-- report_payload, or any figures (only user question, time, role, tool names, outcome, thumbs, comment)
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
  v_uid      uuid := (SELECT auth.uid());
  v_conv     record;
  v_roles    text[];
  v_messages jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_crm_can_review() THEN
    RAISE EXCEPTION 'staff_assistant_crm_not_authorized'
      USING ERRCODE = '42501';
  END IF;

  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    c.id,
    c.user_id,
    c.title,
    c.created_at,
    c.last_message_at,
    COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff Member') AS staff_name,
    COALESCE(NULLIF(btrim(p.email), ''), '')                 AS staff_email
  INTO v_conv
  FROM public.staff_assistant_conversations c
  LEFT JOIN public.profiles p ON p.id = c.user_id
  WHERE c.id = p_conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT ur.role::text ORDER BY ur.role::text), ARRAY['employee']::text[])
  INTO v_roles
  FROM public.user_roles ur
  WHERE ur.user_id = v_conv.user_id
    AND ur.enabled = true;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'role', m.role,
        -- REDACTED: only user questions are returned; assistant answers and report_payload are never exposed to CRM
        'question', CASE WHEN m.role = 'user' THEN m.content ELSE NULL END,
        'outcome', m.outcome,
        'tools_called', COALESCE(m.tools_called, ARRAY[]::text[]),
        'source_label', m.source_label,
        'period_label', m.period_label,
        'model', m.model,
        'latency_ms', m.latency_ms,
        'created_at', m.created_at,
        'feedback_rating', fb.rating,
        'feedback_comment', fb.comment,
        'feedback_at', fb.created_at,
        'unanswered_reason', ua.reason,
        'unanswered_status', ua.status
      )
      ORDER BY m.created_at ASC
    ),
    '[]'::jsonb
  )
  INTO v_messages
  FROM public.staff_assistant_messages m
  LEFT JOIN LATERAL (
    SELECT f.rating, f.comment, f.created_at
    FROM public.staff_assistant_feedback f
    WHERE f.message_id = m.id
    ORDER BY f.created_at DESC
    LIMIT 1
  ) fb ON true
  LEFT JOIN LATERAL (
    SELECT u.reason, u.status
    FROM public.staff_assistant_unanswered u
    WHERE u.message_id = m.id
    ORDER BY u.created_at DESC
    LIMIT 1
  ) ua ON true
  WHERE m.conversation_id = p_conversation_id;

  RETURN jsonb_build_object(
    'conversation', jsonb_build_object(
      'id', v_conv.id,
      'user_id', v_conv.user_id,
      'staff_name', v_conv.staff_name,
      'staff_email', v_conv.staff_email,
      'roles', v_roles,
      'title', v_conv.title,
      'created_at', v_conv.created_at,
      'last_message_at', v_conv.last_message_at
    ),
    'messages', v_messages
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_crm_conversation_thread(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_crm_conversation_thread(uuid) TO authenticated;

COMMIT;
