-- =============================================================================
-- Rollback for 20261103180000_staff_assistant_consolidated_security_defences.sql
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.staff_assistant_update_push_and_voice_prefs(boolean, boolean, boolean, boolean, boolean);
DROP FUNCTION IF EXISTS public.staff_assistant_can_send_web_push(uuid, text);

ALTER TABLE public.staff_assistant_preferences
  DROP COLUMN IF EXISTS voice_disclosure_acknowledged_at,
  DROP COLUMN IF EXISTS web_push_soft_prompt_dismissed,
  DROP COLUMN IF EXISTS web_push_taught_updates_topic,
  DROP COLUMN IF EXISTS web_push_morning_brief_topic;

ALTER TABLE public.staff_assistant_knowledge_base
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS created_by;

DELETE FROM supabase_migrations.schema_migrations
WHERE version = '20261103180000';

COMMIT;
