-- One daily credit charge per draw per day. A second same-day run fails its credit_draw_ledger
-- insert, and process-credit-daily-charges then skips that draw before any money moves.

DO $chk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.credit_draw_ledger
     GROUP BY draw_id, date
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'credit_draw_ledger already has more than one row for a draw on the same date - stopping';
  END IF;
END
$chk$;

CREATE UNIQUE INDEX IF NOT EXISTS credit_draw_ledger_one_charge_per_draw_per_day
  ON public.credit_draw_ledger (draw_id, date);