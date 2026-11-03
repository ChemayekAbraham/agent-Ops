-- =============================================================================
-- Rollback: 20261030140000_staff_assistant_prompt4_learning_kb_and_starters.rollback.sql
-- =============================================================================

DROP FUNCTION IF EXISTS public.staff_assistant_weekly_manager_learning_view(integer);
DROP FUNCTION IF EXISTS public.staff_assistant_promote_to_eval_set(text, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.staff_assistant_upsert_knowledge_entry(text, text, text, text, text, text, text, text, text[], text);
DROP FUNCTION IF EXISTS public.staff_assistant_get_memory_prefs();
DROP FUNCTION IF EXISTS public.staff_assistant_set_memory_prefs(boolean, text);
DROP FUNCTION IF EXISTS public.staff_assistant_update_note(uuid, text);
DROP FUNCTION IF EXISTS public.assistant_staff_morning_brief_what_changed();
DROP FUNCTION IF EXISTS public.assistant_staff_personalised_starters();
DROP FUNCTION IF EXISTS public.assistant_staff_search_knowledge_base(text, text, integer);

DROP TABLE IF EXISTS public.staff_assistant_knowledge_base;
DROP TABLE IF EXISTS public.staff_assistant_eval_candidates;
DROP TABLE IF EXISTS public.staff_assistant_learning_log;

ALTER TABLE public.staff_assistant_preferences
  DROP COLUMN IF EXISTS dismissed_memory_prompts,
  DROP COLUMN IF EXISTS memory_enabled;
