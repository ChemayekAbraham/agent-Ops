ALTER TABLE public.agent_advance_ledger
  DROP CONSTRAINT IF EXISTS agent_advance_ledger_deduction_status_check;
ALTER TABLE public.agent_advance_ledger
  ADD CONSTRAINT agent_advance_ledger_deduction_status_check
  CHECK (deduction_status = ANY (ARRAY['full','partial','none','voluntary_payment','prepaid','ahead','not_due']));