-- Rollback for 20261026150000_staff_assistant_crm_review_and_usage.sql
DROP FUNCTION IF EXISTS public.staff_assistant_crm_conversation_thread(uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_crm_review_dashboard(text, boolean, boolean, integer);

DROP TRIGGER IF EXISTS staff_assistant_unanswered_stamp_review_trg ON public.staff_assistant_unanswered;
DROP FUNCTION IF EXISTS public.staff_assistant_unanswered_stamp_review();

REVOKE UPDATE (status, review_note) ON TABLE public.staff_assistant_unanswered FROM authenticated;

DROP POLICY IF EXISTS "CRM team updates staff_assistant_unanswered" ON public.staff_assistant_unanswered;
DROP POLICY IF EXISTS "CRM team reads staff_assistant_unanswered" ON public.staff_assistant_unanswered;
DROP POLICY IF EXISTS "CRM team reads staff_assistant_feedback" ON public.staff_assistant_feedback;
DROP POLICY IF EXISTS "CRM team reads staff_assistant_messages" ON public.staff_assistant_messages;
DROP POLICY IF EXISTS "CRM team reads staff_assistant_conversations" ON public.staff_assistant_conversations;

DROP FUNCTION IF EXISTS public.staff_assistant_is_crm_reviewer();
