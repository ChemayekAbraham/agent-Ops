-- =============================================================================
-- Rollback: 20261027100000_staff_assistant_security_hardening_down.sql
-- Purpose:  Reverts 20261027100000_staff_assistant_security_hardening.sql
-- =============================================================================

BEGIN;

DROP VIEW IF EXISTS public.v_staff_assistant_crm_messages_redacted;

DROP FUNCTION IF EXISTS public.staff_assistant_confirm_schedule_mfa(uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_can_user_read_report(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_write_or_read_roles_list();
DROP FUNCTION IF EXISTS public.staff_assistant_is_valid_link_path(text);
DROP FUNCTION IF EXISTS public.staff_assistant_consume_draft(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.staff_assistant_save_draft(text, jsonb, uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_compute_draft_hash(text, jsonb);
DROP FUNCTION IF EXISTS public.staff_assistant_check_email_budget(uuid, integer);
DROP FUNCTION IF EXISTS public.staff_assistant_check_question_rate_limit(uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_hide_my_history(uuid, uuid);

DROP TRIGGER IF EXISTS trg_staff_assistant_messages_no_user_delete ON public.staff_assistant_messages;
DROP FUNCTION IF EXISTS public.trg_guard_staff_assistant_messages_no_user_delete();

DROP TABLE IF EXISTS public.staff_assistant_drafts;

ALTER TABLE public.staff_assistant_schedules
  DROP COLUMN IF EXISTS mfa_confirmed_at;

ALTER TABLE public.staff_assistant_messages
  DROP COLUMN IF EXISTS hidden_by_user,
  DROP COLUMN IF EXISTS hidden_at;

ALTER TABLE public.staff_assistant_conversations
  DROP COLUMN IF EXISTS hidden_by_user,
  DROP COLUMN IF EXISTS hidden_at;

ALTER TABLE public.staff_assistant_config
  DROP COLUMN IF EXISTS max_model_rounds,
  DROP COLUMN IF EXISTS max_tool_calls,
  DROP COLUMN IF EXISTS max_notifications_per_day;

COMMIT;
