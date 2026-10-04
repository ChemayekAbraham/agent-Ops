CREATE OR REPLACE FUNCTION public.enforce_production_classification_april_cutoff()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.transaction_date >= TIMESTAMPTZ '2026-04-01 00:00:00+00' THEN
    IF NEW.classification IS DISTINCT FROM 'admin_correction'
       AND NEW.classification IS DISTINCT FROM 'production' THEN
      NEW.classification := 'production';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_production_april_cutoff ON public.general_ledger;
CREATE TRIGGER trg_enforce_production_april_cutoff
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_production_classification_april_cutoff();

DO $$
DECLARE
  promoted_count INTEGER := 0;
BEGIN
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;

  WITH promoted AS (
    UPDATE public.general_ledger
    SET classification = 'production'
    WHERE transaction_date >= TIMESTAMPTZ '2026-04-01 00:00:00+00'
      AND classification IN ('legacy_real', 'test_dev')
    RETURNING 1
  )
  SELECT COUNT(*) INTO promoted_count FROM promoted;

  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, action, metadata)
  VALUES (
    'ledger_classification_backfill',
    'general_ledger',
    gen_random_uuid()::text,
    'promote_april_to_production',
    jsonb_build_object(
      'reason', 'CEO directive: timestamp transactions from April going forward as production',
      'cutoff', '2026-04-01',
      'promoted_from', ARRAY['legacy_real','test_dev'],
      'preserved', ARRAY['admin_correction'],
      'rows_promoted', promoted_count,
      'guard_trigger_installed', 'trg_enforce_production_april_cutoff'
    )
  );

  INSERT INTO public.system_events (event_type, metadata)
  VALUES (
    'ledger_classification_backfilled'::system_event_type,
    jsonb_build_object(
      'description', format('Promoted %s April-onward ledger legs to production', promoted_count),
      'cutoff', '2026-04-01',
      'rows_promoted', promoted_count,
      'guard_trigger', 'trg_enforce_production_april_cutoff'
    )
  );

EXCEPTION WHEN OTHERS THEN
  BEGIN
    ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE;
END $$;