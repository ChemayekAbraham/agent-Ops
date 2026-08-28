CREATE OR REPLACE FUNCTION public.hr_pay_period_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    open_run_count INTEGER;
BEGIN
    -- Closing a period: every run must be locked or cancelled
    IF OLD.status = 'open' AND NEW.status = 'closed' THEN
        SELECT COUNT(*)
        INTO open_run_count
        FROM public.hr_pay_runs
        WHERE period_id = OLD.id
          AND status NOT IN ('locked', 'cancelled');

        IF open_run_count > 0 THEN
            RAISE EXCEPTION 'Cannot close period: % run(s) are not locked or cancelled. Every run in the period must be locked or cancelled before the period can close.', open_run_count;
        END IF;
    END IF;

    -- Reopening a closed period is never allowed
    IF OLD.status = 'closed' AND NEW.status = 'open' THEN
        RAISE EXCEPTION 'A closed period cannot be reopened. A correction is an adjustment run against the same period.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hr_pay_period_guard_trg ON public.hr_pay_periods;

CREATE TRIGGER hr_pay_period_guard_trg
BEFORE UPDATE ON public.hr_pay_periods
FOR EACH ROW
EXECUTE FUNCTION public.hr_pay_period_guard();