
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='treasury_controls' AND column_name='value') THEN
    ALTER TABLE public.treasury_controls ADD COLUMN value text;
  END IF;
END$$;

INSERT INTO public.treasury_controls (control_key, enabled, value, updated_at)
VALUES
  ('maintenance_mode', true, NULL, now()),
  ('maintenance_until', true, (now() + interval '1 hour')::text, now()),
  ('maintenance_message', true, 'Welile is under scheduled maintenance for wallet reconciliation. All deposits, withdrawals, and transfers are paused. Service resumes shortly.', now()),
  ('withdrawals_paused', true, NULL, now()),
  ('credits_paused', true, NULL, now())
ON CONFLICT (control_key) DO UPDATE
  SET enabled = EXCLUDED.enabled,
      value = COALESCE(EXCLUDED.value, public.treasury_controls.value),
      updated_at = now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='treasury_controls' AND policyname='Public can read maintenance status'
  ) THEN
    EXECUTE 'CREATE POLICY "Public can read maintenance status" ON public.treasury_controls FOR SELECT USING (true)';
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'general_ledger_route_buckets') THEN
    EXECUTE 'ALTER TABLE public.general_ledger DISABLE TRIGGER general_ledger_route_buckets';
  END IF;
END$$;

DO $$
DECLARE j record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR j IN SELECT jobid FROM cron.job WHERE active = true LOOP
      PERFORM cron.alter_job(job_id := j.jobid, active := false);
    END LOOP;
  END IF;
END$$;
