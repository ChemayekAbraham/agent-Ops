-- Wrapper that swallows the SETOF result and never raises into the caller
CREATE OR REPLACE FUNCTION public.run_email_auto_match_retry(
  p_window_hours integer DEFAULT 24
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  BEGIN
    SELECT count(*) INTO v_count
      FROM public.auto_match_email_deposits(0, p_window_hours);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'run_email_auto_match_retry failed: %', SQLERRM;
    v_count := -1;
  END;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.run_email_auto_match_retry(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.run_email_auto_match_retry(integer) TO authenticated, service_role;

-- AFTER INSERT trigger: only fire for fresh, pending deposits
CREATE OR REPLACE FUNCTION public.trg_deposit_request_auto_rematch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM public.run_email_auto_match_retry(24);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deposit_request_auto_rematch ON public.deposit_requests;
CREATE TRIGGER trg_deposit_request_auto_rematch
AFTER INSERT ON public.deposit_requests
FOR EACH ROW EXECUTE FUNCTION public.trg_deposit_request_auto_rematch();

-- Background retry every 2 minutes via pg_cron (already enabled)
DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'email-auto-match-retry-24h';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'email-auto-match-retry-24h',
  '*/2 * * * *',
  $$ SELECT public.run_email_auto_match_retry(24); $$
);