-- Rollback for 20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql
BEGIN;

DROP FUNCTION IF EXISTS public.zoe_glossary_upsert_entry(text, text, text, text, text, text, text, text[], boolean);
DROP FUNCTION IF EXISTS public.zoe_glossary_can_manage(uuid);
DROP FUNCTION IF EXISTS public.assistant_staff_get_glossary(text, text);

DROP TABLE IF EXISTS public.staff_assistant_glossary;
DROP TABLE IF EXISTS public.staff_assistant_notes;

ALTER TABLE public.staff_assistant_conversations
  DROP COLUMN IF EXISTS rolling_summary;

ALTER TABLE public.staff_assistant_config
  DROP COLUMN IF EXISTS max_cost_usd_per_question,
  DROP COLUMN IF EXISTS max_deep_tool_calls,
  DROP COLUMN IF EXISTS max_deep_model_rounds,
  DROP COLUMN IF EXISTS max_tokens,
  DROP COLUMN IF EXISTS temperature,
  DROP COLUMN IF EXISTS model_deep,
  DROP COLUMN IF EXISTS model_fast;

COMMIT;
