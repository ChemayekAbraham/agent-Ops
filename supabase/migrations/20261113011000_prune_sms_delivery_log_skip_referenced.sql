-- Cron job 513 prune-sms-delivery-log (25 2 * * *) deletes sms_delivery_log rows
-- older than 60 days. tenant_notification_log.sms_log_id references
-- sms_delivery_log(id), so a referenced row aborts the whole delete.
-- Skip rows that are still referenced. Do not update or delete
-- tenant_notification_log. Schedule, job name, and job id stay the same.

DO $do$
DECLARE
  v_jobid bigint;
  v_jobname text;
  v_schedule text;
  v_command text;
  v_old text := $cmd$DELETE FROM public.sms_delivery_log WHERE created_at < now() - interval '60 days'$cmd$;
  v_new text := $cmd$DELETE FROM public.sms_delivery_log WHERE created_at < now() - interval '60 days' AND NOT EXISTS (SELECT 1 FROM public.tenant_notification_log t WHERE t.sms_log_id = sms_delivery_log.id)$cmd$;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'cron.job is not available; leaving prune-sms-delivery-log unchanged';
    RETURN;
  END IF;

  SELECT jobid, jobname, schedule, command
    INTO v_jobid, v_jobname, v_schedule, v_command
  FROM cron.job
  WHERE jobid = 513;

  IF NOT FOUND THEN
    RAISE NOTICE 'cron job 513 prune-sms-delivery-log is not present; leaving it unchanged';
    RETURN;
  END IF;

  IF v_jobname IS DISTINCT FROM 'prune-sms-delivery-log' THEN
    RAISE EXCEPTION 'cron job 513 is named %, expected prune-sms-delivery-log', v_jobname;
  END IF;

  IF v_schedule IS DISTINCT FROM '25 2 * * *' THEN
    RAISE EXCEPTION 'cron job 513 schedule is %, expected 25 2 * * *', v_schedule;
  END IF;

  IF v_command = v_new THEN
    RETURN;
  END IF;

  IF v_command IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'cron job 513 command does not match the expected prune statement';
  END IF;

  PERFORM cron.alter_job(job_id := 513, command := v_new);
END
$do$;
