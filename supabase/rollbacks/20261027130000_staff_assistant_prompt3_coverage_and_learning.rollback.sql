-- =============================================================================
-- Rollback: 20261027130000_staff_assistant_prompt3_coverage_and_learning.rollback.sql
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.staff_assistant_crm_weekly_learning_report(integer, text);
DROP FUNCTION IF EXISTS public.assistant_staff_fops_merchant_cashouts(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_fops_disbursements(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_pops_topups_and_withdrawals_waiting(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_pops_returns_due(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_aops_subagent_teams(date, date, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_lops_verification_queue(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_tops_awareness_calls(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_tops_find_tenant(text, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_tops_time_on_desk(text, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_tops_rent_requests_by_stage(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_my_calls(date, date);
DROP FUNCTION IF EXISTS public.staff_assistant_rename_conversation(uuid, text);

ALTER TABLE public.staff_assistant_conversations
  DROP COLUMN IF EXISTS conversation_summary;

COMMIT;
