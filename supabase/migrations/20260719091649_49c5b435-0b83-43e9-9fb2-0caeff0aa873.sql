-- Backfill daily_installment for active advances where it was left at 0,
-- and add a safety trigger so it can never be 0 on an active advance again.

UPDATE public.agent_advances a
SET daily_installment = GREATEST(
  1,
  CEIL(
    (a.principal + COALESCE(a.access_fee, 0) +
     CASE WHEN a.principal <= 200000 THEN 10000 ELSE 20000 END
    )::numeric / NULLIF(a.cycle_days, 0)
  )
)
WHERE a.status IN ('active','overdue')
  AND (a.daily_installment IS NULL OR a.daily_installment = 0)
  AND a.cycle_days > 0
  AND a.principal > 0;

CREATE OR REPLACE FUNCTION public.enforce_advance_daily_installment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('active','overdue')
     AND (NEW.daily_installment IS NULL OR NEW.daily_installment = 0)
     AND COALESCE(NEW.cycle_days,0) > 0
     AND COALESCE(NEW.principal,0) > 0 THEN
    NEW.daily_installment := GREATEST(
      1,
      CEIL(
        (NEW.principal + COALESCE(NEW.access_fee,0) +
         CASE WHEN NEW.principal <= 200000 THEN 10000 ELSE 20000 END
        )::numeric / NEW.cycle_days
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_advance_daily_installment ON public.agent_advances;
CREATE TRIGGER trg_enforce_advance_daily_installment
BEFORE INSERT OR UPDATE ON public.agent_advances
FOR EACH ROW EXECUTE FUNCTION public.enforce_advance_daily_installment();