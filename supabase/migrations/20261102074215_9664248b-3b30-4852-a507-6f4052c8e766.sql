CREATE OR REPLACE FUNCTION public.lunch_next_weekday_slot(p_after timestamptz)
 RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $$
DECLARE d date := (p_after AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF (d::timestamp AT TIME ZONE 'Africa/Kampala') <= p_after THEN d := d + 1; END IF;
  WHILE extract(isodow FROM d) IN (6,7) LOOP d := d + 1; END LOOP;
  RETURN d::timestamp AT TIME ZONE 'Africa/Kampala';
END $$;

CREATE OR REPLACE FUNCTION public.snap_lunch_allowance_next_run()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.category_id = 'lunch_allowance' AND NEW.frequency = 'daily' THEN
    NEW.next_run_at := public.lunch_next_weekday_slot(now());
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.lunch_allowance_resume_no_catchup()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.category_id = 'lunch_allowance' AND NEW.frequency = 'daily'
     AND NEW.enabled AND NOT COALESCE(OLD.enabled, false) THEN
    NEW.next_run_at := public.lunch_next_weekday_slot(now());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_lunch_allowance_resume_no_catchup ON public.scheduled_payouts;
CREATE TRIGGER trg_lunch_allowance_resume_no_catchup
  BEFORE UPDATE OF enabled ON public.scheduled_payouts
  FOR EACH ROW EXECUTE FUNCTION public.lunch_allowance_resume_no_catchup();

UPDATE public.scheduled_payouts
   SET next_run_at = public.lunch_next_weekday_slot(now())
 WHERE category_id = 'lunch_allowance' AND frequency = 'daily';