-- =============================================================================
-- Rollback: 20261025233000_staff_assistant_email_recipients.rollback.sql
-- Reverses: 20261025233000_staff_assistant_email_recipients.sql
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.staff_assistant_is_staff_email(text);
DROP FUNCTION IF EXISTS public.staff_assistant_email_recipients(text);

COMMIT;
