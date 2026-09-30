-- Doc 174: notify-advance-deduction and gmail-intake-silence-alarm were callable by anyone.
--
-- Both edge functions text/email people from WELILE's sender using the service role,
-- and neither checked who was calling. Their DB callers authenticated with the PUBLIC
-- anon key (it ships in the client bundle), so the endpoint was open to the internet.
-- The functions now require the service-role key (_shared/requireServiceRole.ts).
-- This migration switches every caller to send it, from vault secret
-- email_queue_service_role_key (same source notify_merchants_new_withdrawal uses).
--
-- ORDER MATTERS: apply this migration FIRST (callers then send a service key to the
-- still-open functions, harmless), THEN deploy the two edge functions. Deploying first
-- would make every advance SMS and the silence alarm return 401.
--
-- If the vault secret is ever missing the header becomes "Bearer " and the endpoint
-- refuses: safe-fail (no SMS) rather than open.

DO $$
DECLARE
  v_fn   text;
  v_oid  oid;
  v_def  text;
  v_new  text;
  v_repl constant text :=
    'headers := jsonb_build_object(''Content-Type'',''application/json'',''Authorization'',''Bearer ''||coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''email_queue_service_role_key'' LIMIT 1),''''))';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'sweep_agent_advance_recovery',
    'send_daily_advance_deduction_summary',
    'sms_advance_deduction_on_ledger'
  ] LOOP
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'function % not found', v_fn;
    END IF;

    v_def := pg_get_functiondef(v_oid);
    v_new := regexp_replace(v_def, 'headers := ''\{[^'']*\}''::jsonb', v_repl);

    IF v_new = v_def THEN
      RAISE EXCEPTION 'no anon-key headers literal found in %, refusing to continue', v_fn;
    END IF;
    IF v_new ILIKE '%eyJhbGci%' THEN
      RAISE EXCEPTION 'a hard-coded JWT is still present in %', v_fn;
    END IF;

    EXECUTE v_new;
  END LOOP;
END $$;

-- Silence alarm cron: alter the existing job in place (never unschedule from inside a job).
DO $$
DECLARE v_job bigint;
BEGIN
  SELECT jobid INTO v_job FROM cron.job WHERE jobname = 'gmail-intake-silence-alarm-every-10min';
  IF v_job IS NULL THEN
    RAISE EXCEPTION 'cron job gmail-intake-silence-alarm-every-10min not found';
  END IF;
  PERFORM cron.alter_job(
    v_job,
    command := $cmd$
  SELECT net.http_post(
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/gmail-intake-silence-alarm',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1), '')
    ),
    body := jsonb_build_object('scheduled_at', now())
  );
  $cmd$
  );
END $$;
