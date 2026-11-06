-- =============================================================================
-- Rollback: 20261028100000_landlord_calling_hub_foundation.rollback.sql
-- Purpose:  Cleanly removes the Landlord Calling Hub foundation objects created
--           by 20261028100000_landlord_calling_hub_foundation.sql.
-- =============================================================================

DROP FUNCTION IF EXISTS public.landlord_hub_stats();
DROP FUNCTION IF EXISTS public.landlord_hub_detail(text);
DROP FUNCTION IF EXISTS public.landlord_hub_list(text, text, text, text, text, text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.landlord_hub_amend_call(uuid, jsonb, text);
DROP FUNCTION IF EXISTS public.landlord_hub_record_call(text, text, timestamptz, text, uuid, uuid, text, timestamptz, text, text, text, text, text, text, text, uuid[]);
DROP FUNCTION IF EXISTS public.landlord_hub_start_dial(text, text);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule('refresh-landlord-hub-registry-5m');
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

DROP FUNCTION IF EXISTS public.refresh_mv_landlord_hub_registry();
DROP MATERIALIZED VIEW IF EXISTS public.mv_landlord_hub_registry;

DROP VIEW IF EXISTS public.v_landlord_calls_effective;

DROP TRIGGER IF EXISTS landlord_call_amendments_no_change ON public.landlord_call_amendments;
DROP FUNCTION IF EXISTS public.landlord_call_amendments_append_only();
DROP TABLE IF EXISTS public.landlord_call_amendments;

DROP TABLE IF EXISTS public.landlord_call_dials;

DROP TRIGGER IF EXISTS landlord_calls_no_change ON public.landlord_calls;
DROP FUNCTION IF EXISTS public.landlord_calls_append_only();
DROP TABLE IF EXISTS public.landlord_calls;

DROP FUNCTION IF EXISTS public._landlord_hub_can_record();
DROP FUNCTION IF EXISTS public._landlord_hub_can_read();
