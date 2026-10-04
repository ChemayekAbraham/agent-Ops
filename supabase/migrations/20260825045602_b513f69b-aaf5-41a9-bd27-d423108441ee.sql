CREATE OR REPLACE FUNCTION public.attach_cfo_correction_subcategory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.source_table = 'cfo_direct_credit'
     AND NEW.reference_id IS NOT NULL
     AND NEW.sub_category IS NULL THEN
    SELECT NULLIF(p.metadata->>'sub_category', '')
      INTO NEW.sub_category
    FROM public.platform_wallet_corrections p
    WHERE p.reference_id = NEW.reference_id
    LIMIT 1;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_cfo_correction_subcategory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attach_cfo_correction_subcategory() TO service_role;

DROP TRIGGER IF EXISTS trg_attach_cfo_correction_subcategory ON public.general_ledger;
CREATE TRIGGER trg_attach_cfo_correction_subcategory
BEFORE INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.attach_cfo_correction_subcategory();