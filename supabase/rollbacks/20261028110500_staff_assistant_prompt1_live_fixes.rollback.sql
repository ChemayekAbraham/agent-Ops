-- Rollback for 20261028110000_staff_assistant_prompt1_live_fixes.sql
-- Note: Re-apply 20261026000000_staff_assistant_read_tools_batch1.sql and
-- 20261026130000_staff_assistant_read_tools_batch2.sql to restore earlier function bodies.
BEGIN;
DROP INDEX IF EXISTS public.idx_staff_assistant_conversations_user_visible;
DROP INDEX IF EXISTS public.idx_staff_assistant_messages_user_visible;
COMMIT;
