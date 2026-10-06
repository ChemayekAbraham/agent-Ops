CREATE OR REPLACE FUNCTION public.trg_auto_issue_landlord_payout_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('awaiting_agent_receipt','completed')
     AND COALESCE(NEW.disbursed_at, NEW.finops_disbursed_at) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.landlord_payout_receipts WHERE payout_id = NEW.id) THEN
    BEGIN
      PERFORM public.issue_landlord_payout_receipt(NEW.id, NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'auto receipt issue failed for payout %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_zz_auto_issue_landlord_payout_receipt ON public.landlord_payouts;
CREATE TRIGGER trg_zz_auto_issue_landlord_payout_receipt
AFTER INSERT OR UPDATE OF status, disbursed_at, finops_disbursed_at ON public.landlord_payouts
FOR EACH ROW EXECUTE FUNCTION public.trg_auto_issue_landlord_payout_receipt();