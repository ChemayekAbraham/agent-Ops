-- Applied directly 2026-10-20 (migration tool returned 42P10). Not in schema_migrations.
CREATE OR REPLACE FUNCTION public.guard_pwo_approved_not_reopened()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status = 'approved'
     AND NEW.status IN ('pending','pending_coo_approval','coo_approved','pending_cfo_approval') THEN
    RAISE EXCEPTION 'Operation % is already approved and paid; it cannot be moved back to %', OLD.id, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_pwo_approved_not_reopened ON public.pending_wallet_operations;
CREATE TRIGGER trg_guard_pwo_approved_not_reopened
BEFORE UPDATE OF status ON public.pending_wallet_operations
FOR EACH ROW EXECUTE FUNCTION public.guard_pwo_approved_not_reopened();
