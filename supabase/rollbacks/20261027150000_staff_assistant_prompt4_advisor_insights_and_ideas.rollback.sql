-- =============================================================================
-- Rollback: 20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.rollback.sql
-- Reverts `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql`.
-- =============================================================================

BEGIN;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('zoe-daily-anomaly-insights');
    EXCEPTION
      WHEN OTHERS THEN NULL;
    END;
  END IF;
EXCEPTION
  WHEN OTHERS THEN NULL;
END
$cron$;

DROP FUNCTION IF EXISTS public.staff_assistant_weekly_focus_summary();
DROP FUNCTION IF EXISTS public.staff_assistant_update_idea_status(uuid, text, text);
DROP FUNCTION IF EXISTS public.staff_assistant_list_ideas(text, integer);
DROP FUNCTION IF EXISTS public.staff_assistant_save_idea(text, text, text, text, jsonb, text, text, text, uuid, uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_compute_daily_insights(date);

DROP FUNCTION IF EXISTS public.assistant_staff_insight_anomalies(text, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_insight_zoe_unanswered_and_feedback(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_insight_payout_delays(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_insight_calling_reach_and_themes(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_insight_collection_coverage_trends(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_insight_desk_wait_times(integer);

DROP TABLE IF EXISTS public.staff_assistant_ideas;
DROP TABLE IF EXISTS public.staff_assistant_insights;

DROP FUNCTION IF EXISTS public.staff_assistant_can_manage_ideas();

COMMIT;
