-- Puts back the trigger that takes an agent's advance arrears out of each commission as it is earned.

DROP TRIGGER IF EXISTS trg_recover_advance_arrears_on_earning ON public.general_ledger;
CREATE TRIGGER trg_recover_advance_arrears_on_earning
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_recover_advance_arrears_on_earning();
