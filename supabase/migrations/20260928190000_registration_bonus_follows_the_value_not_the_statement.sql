-- The registration bonus never fired for landlords verified in the pipeline.
--
-- THE BUG, EXACTLY
--
-- `trg_pay_landlord_registration_verified_bonus` was declared
-- `AFTER UPDATE OF verified ON public.landlords`. In Postgres, `UPDATE OF col`
-- fires on whether the column appears in the statement's SET LIST — not on
-- whether the value changed.
--
-- `sync_landlord_verified_on_pipeline_approval`, which runs when Landlord Ops
-- reviews a rent request, updated `verification_status`, `verification_source`,
-- `verification_reason`, `verified_at` and `verified_by` — and never named
-- `verified`. The BEFORE gate `landlord_verification_gate` then derives
-- `NEW.verified := (NEW.verification_status = 'verified')`, so the value DID
-- flip to true. The trigger simply never ran.
--
-- The agent's UGX 5,000 was silently skipped, and the landlord was left with
-- `registration_verification_bonus_paid = false` forever.
--
-- IT GETS WORSE ON THE SECOND PASS. The bonus function requires
-- `OLD.verified IS DISTINCT FROM true`. Once the pipeline had quietly set
-- `verified = true`, any LATER proper verification through
-- `set_landlord_verification` — which does name the column — found OLD.verified
-- already true and skipped the bonus as a duplicate. The money was not
-- deferred, it was lost.
--
-- MEASURED 2026-09-28, payment rate by how the landlord was verified:
--
--   registration        105 verified,    0 paid    0.0%   <- pipeline path
--   ops_manual          580 verified,   60 paid   10.3%   <- second-pass loss
--   agent_request       166 verified,  138 paid   83.1%
--   pipeline_auto     1,892 verified, 1,850 paid  97.8%
--   house_verification  531 verified,  531 paid  100.0%
--
-- A bucket at exactly 0 of 105 is not a coincidence.
--
-- THE FIX
--
-- The trigger now fires on ANY update and tests the VALUE in a WHEN clause,
-- which is what was meant all along. The WHEN clause also stops the recursion
-- the function would otherwise cause when it writes back
-- `registration_verification_bonus_paid`: on that second pass OLD.verified is
-- already true, so it does not re-enter.
--
-- `trg_mature_on_landlord_verified` carried the identical declaration and the
-- identical bug — it silently skipped bonus maturation and referral maturation
-- on the same path. Fixed the same way.
--
-- The LC1 trigger was already `AFTER UPDATE` and fired correctly, but it never
-- covered INSERT, so an LC1 created already verified never paid. It now covers
-- both, and the function takes a TG_OP guard because reading OLD.verified
-- during an INSERT raises "record old is not assigned yet".
--
-- Proved on a rolled-back transaction against production, using the exact
-- pipeline shape that failed (no `verified` in the SET list):
--   bonus_paid f -> t, 2 ledger legs written, agent wallet 7,632.70 -> 12,632.70.

DROP TRIGGER IF EXISTS trg_pay_landlord_registration_verified_bonus ON public.landlords;
CREATE TRIGGER trg_pay_landlord_registration_verified_bonus
  AFTER UPDATE ON public.landlords
  FOR EACH ROW
  WHEN (NEW.verified IS TRUE AND OLD.verified IS DISTINCT FROM TRUE)
  EXECUTE FUNCTION public.pay_landlord_registration_verified_bonus();

DROP TRIGGER IF EXISTS trg_mature_on_landlord_verified ON public.landlords;
CREATE TRIGGER trg_mature_on_landlord_verified
  AFTER UPDATE ON public.landlords
  FOR EACH ROW
  WHEN (NEW.verified IS TRUE AND OLD.verified IS DISTINCT FROM TRUE)
  EXECUTE FUNCTION public.trg_mature_on_landlord_verified_fn();

-- LC1: same class of gap, at INSERT rather than UPDATE.
CREATE OR REPLACE FUNCTION public.pay_lc1_registration_verified_bonus()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  -- TG_OP guard first: on INSERT there is no OLD record, and touching
  -- OLD.verified there raises "record old is not assigned yet".
  IF NEW.verified = true
     AND (TG_OP = 'INSERT' OR OLD.verified IS DISTINCT FROM true)
     AND NEW.registered_by IS NOT NULL
     AND COALESCE(NEW.registration_verification_bonus_paid, false) = false
  THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', NEW.registered_by,'amount',2000,'direction','cash_in','category','agent_commission','ledger_scope','wallet','recipient_type','user','source_table','lc1_chairpersons','source_id',NEW.id::text,'description','UGX 2,000 LC1 chairperson registration bonus — verified: ' || COALESCE(NEW.name, 'LC1 chairperson'),'currency','UGX'),
        jsonb_build_object('user_id', NEW.registered_by,'amount',2000,'direction','cash_out','category','marketing_expense','ledger_scope','platform','source_table','lc1_chairpersons','source_id',NEW.id::text,'description','Platform expense: LC1 chairperson registration bonus (verified) — ' || COALESCE(NEW.name, 'LC1 chairperson'),'currency','UGX')
      ),
      'lc1_reg_verify_v1:' || NEW.id::text
    );

    UPDATE public.lc1_chairpersons
      SET registration_verification_bonus_paid = true,
          registration_verification_bonus_paid_at = now()
      WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pay_lc1_registration_verified_bonus ON public.lc1_chairpersons;
CREATE TRIGGER trg_pay_lc1_registration_verified_bonus
  AFTER INSERT OR UPDATE ON public.lc1_chairpersons
  FOR EACH ROW
  WHEN (NEW.verified IS TRUE)
  EXECUTE FUNCTION public.pay_lc1_registration_verified_bonus();

-- ---------------------------------------------------------------------------
-- Landlord Ops verifies the landlord AND the LC1 in one transaction.
--
-- They are confirmed on the same call in the field, so splitting them across
-- two reviews only delayed the LC1 bonus and left plans sitting with a verified
-- landlord beside an unverified LC1. The landlord UPDATE now also names
-- `verified` explicitly — belt and braces, so the bonus survives even if
-- someone reinstates an `UPDATE OF verified` trigger later.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_landlord_verified_on_pipeline_approval()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.landlord_ops_reviewed_at IS NOT NULL AND NEW.landlord_id IS NOT NULL THEN
    PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
    UPDATE public.landlords
       SET verification_status = 'verified',
           verified            = true,
           verification_source = COALESCE(verification_source, 'pipeline_auto'),
           verification_reason = COALESCE(verification_reason, 'Auto-verified after landlord pipeline review'),
           verified_at         = COALESCE(verified_at, NEW.landlord_ops_reviewed_at),
           verified_by         = COALESCE(verified_by, NEW.landlord_ops_reviewed_by)
     WHERE id = NEW.landlord_id
       AND COALESCE(verification_status, 'pending') = 'pending';
    PERFORM set_config('landlord_verification.sync_authorized', 'false', true);
  END IF;

  IF NEW.landlord_ops_reviewed_at IS NOT NULL AND NEW.lc1_id IS NOT NULL THEN
    UPDATE public.lc1_chairpersons
       SET verified            = true,
           verification_status = 'verified',
           verified_at         = COALESCE(verified_at, NEW.landlord_ops_reviewed_at),
           verified_by         = COALESCE(verified_by, NEW.landlord_ops_reviewed_by),
           verification_reason = COALESCE(verification_reason,
                                          'Verified alongside the landlord at Landlord Ops review')
     WHERE id = NEW.lc1_id
       AND COALESCE(verified, false) = false;
  END IF;

  RETURN NEW;
END;
$function$;
