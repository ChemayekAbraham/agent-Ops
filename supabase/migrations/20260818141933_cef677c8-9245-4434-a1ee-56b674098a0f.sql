-- 1. Durable, evidenced record for every platform-wide wallet correction.
CREATE TABLE public.platform_wallet_corrections (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tool text NOT NULL CHECK (tool IN ('cfo_direct_credit','admin_float_to_withdrawable','admin_withdrawable_to_float')),
  operation text NOT NULL CHECK (operation IN ('credit','debit','reclass')),
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0),
  evidence text NOT NULL,
  reference_id text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  system_authored boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_wallet_corrections_target ON public.platform_wallet_corrections(target_user_id, created_at DESC);
CREATE INDEX idx_platform_wallet_corrections_tool ON public.platform_wallet_corrections(tool, created_at DESC);

GRANT SELECT ON public.platform_wallet_corrections TO authenticated;
GRANT ALL ON public.platform_wallet_corrections TO service_role;

ALTER TABLE public.platform_wallet_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leadership can read platform wallet corrections"
ON public.platform_wallet_corrections
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'super_admin')
);

-- 2. Same guard shape as guard_merchant_float_reconciliation().
CREATE OR REPLACE FUNCTION public.guard_platform_wallet_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NOT NULL THEN
    IF NEW.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'WALLET_CORRECTION_AUTHOR_MISMATCH: the correction must be recorded under the signed-in author'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Role gate on the recorded author (works for both JWT and service-role posts).
  IF NOT (
    public.has_role(NEW.created_by, 'cfo')
    OR public.has_role(NEW.created_by, 'financial_ops')
    OR public.has_role(NEW.created_by, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_NOT_AUTHORIZED: only the CFO, Financial Ops or a super admin can record a platform wallet correction'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Self-authorship block: never correct your own wallet.
  IF NOT NEW.system_authored AND NEW.created_by = NEW.target_user_id THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_SELF_BLOCKED: you cannot record a wallet correction for your own account'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Evidence floor.
  IF NEW.evidence IS NULL OR length(btrim(NEW.evidence)) < 20 THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_EVIDENCE_REQUIRED: written evidence of at least 20 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_guard_platform_wallet_correction
BEFORE INSERT ON public.platform_wallet_corrections
FOR EACH ROW EXECUTE FUNCTION public.guard_platform_wallet_correction();

-- 3. Immutability, mirroring block_merchant_float_reconciliation_mutation().
CREATE OR REPLACE FUNCTION public.block_platform_wallet_correction_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'WALLET_CORRECTION_IMMUTABLE: platform wallet corrections are permanent. Record a further evidenced, authorized correction instead.'
    USING ERRCODE = 'check_violation';
END;
$function$;

CREATE TRIGGER trg_block_platform_wallet_correction_update
BEFORE UPDATE ON public.platform_wallet_corrections
FOR EACH ROW EXECUTE FUNCTION public.block_platform_wallet_correction_mutation();

CREATE TRIGGER trg_block_platform_wallet_correction_delete
BEFORE DELETE ON public.platform_wallet_corrections
FOR EACH ROW EXECUTE FUNCTION public.block_platform_wallet_correction_mutation();

-- 4. The ledger refuses correction-tool legs with no evidenced record.
CREATE OR REPLACE FUNCTION public.enforce_wallet_correction_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.source_table NOT IN ('cfo_direct_credit','admin_float_to_withdrawable','admin_withdrawable_to_float') THEN
    RETURN NEW;
  END IF;

  IF NEW.reference_id IS NULL THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_REFERENCE_REQUIRED: % legs must carry a reference_id tied to an evidenced correction record', NEW.source_table
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.platform_wallet_corrections c
    WHERE c.reference_id = NEW.reference_id
  ) THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_EVIDENCE_MISSING: no authorized, evidenced correction record exists for reference % (tool %)', NEW.reference_id, NEW.source_table
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_enforce_wallet_correction_evidence
BEFORE INSERT ON public.general_ledger
FOR EACH ROW EXECUTE FUNCTION public.enforce_wallet_correction_evidence();