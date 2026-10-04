ALTER TABLE public.withdrawal_hold_reconciliation_config
  ALTER COLUMN auto_release_pre_anchor_holds SET DEFAULT false;

UPDATE public.withdrawal_hold_reconciliation_config
   SET auto_release_pre_anchor_holds = false;