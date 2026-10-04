-- Harden merchant own-money claims against tampering.
--
-- WHY. `merchant_out_of_pocket_advances` decides what the company owes its
-- merchant agents, and until now nothing protected its contents:
--
--   * RLS carried a blanket UPDATE policy for cfo / financial_ops /
--     super_admin covering EVERY column. A finance user could, straight from
--     the browser, raise `shortfall_amount` to any number, clear
--     `reimbursed_at` on an already-paid claim and have it settle a second
--     time, or write `evidence->>'finance_attested' = 'true'` and mint a
--     payable obligation out of nothing.
--   * No trigger existed at all, so a raw SQL or service-role connection had
--     completely free rein — inserting, rewriting and deleting decided claims
--     with no constraint and no trace.
--
-- Money movement itself was already safe (the wallet sole-writer rule and
-- `merchant_oop_settlements.advance_id UNIQUE` stop a double payout), but the
-- RECORD of what is owed was not, and that record is what settlement pays
-- against.
--
-- WHAT THIS ADDS
--
-- 1. `enforce_merchant_oop_integrity` — a BEFORE UPDATE OR DELETE trigger that
--    binds every writer including service_role and psql, because triggers fire
--    regardless of RLS. It enforces:
--      - a settled or written-off claim is frozen: no further updates at all;
--      - `reimbursed_at` can never be cleared back to NULL;
--      - `agent_id`, `withdrawal_id` and `kind` are immutable — a claim can
--        never be moved to a different agent or payout;
--      - the money columns may only change while the claim is still
--        undecided (`reviewed_at IS NULL AND attested_at IS NULL`), which is
--        precisely the window `classify_merchant_payout_funding` already
--        restricts its own ON CONFLICT update to;
--      - only legal status transitions;
--      - `finance_attested` may only be switched on with a substantive
--        `basis` (>= 20 chars), so an attested obligation always carries its
--        justification;
--      - DELETE only for a claim nobody has decided yet, which keeps the
--        classifier able to withdraw a row it invented while making a
--        reviewed, attested or settled claim undeletable.
--
-- 2. `log_merchant_oop_change` — an AFTER trigger writing every status change,
--    amount change and attestation into `audit_logs`. Tampering that is still
--    permitted (a finance reinstatement, say) can no longer be silent.
--
-- 3. The blanket finance UPDATE policy is dropped. Writes now go only through
--    `review_merchant_out_of_pocket` and `settle_merchant_out_of_pocket`, both
--    SECURITY DEFINER and therefore unaffected. The client never wrote this
--    table (reads and realtime only), so nothing in the app changes.

-- ── 1. Integrity trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_merchant_oop_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_attested boolean;
  v_new_attested boolean;
  v_basis text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only a claim nobody has decided on may be withdrawn. This is the exact
    -- predicate `classify_merchant_payout_funding` uses when a payout turns
    -- out to have been fully float-funded after all.
    IF OLD.reimbursed_at IS NOT NULL
       OR OLD.reviewed_at IS NOT NULL
       OR OLD.attested_at IS NOT NULL
       OR OLD.status NOT IN ('needs_review', 'pending_reimbursement') THEN
      RAISE EXCEPTION
        'MERCHANT_OOP_DELETE_BLOCKED: claim % has been decided (status=%, reviewed=%, attested=%, reimbursed=%) and cannot be deleted. Reject it instead so the record survives.',
        OLD.id, OLD.status, OLD.reviewed_at IS NOT NULL, OLD.attested_at IS NOT NULL, OLD.reimbursed_at IS NOT NULL
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- A settled or written-off claim is history. Nothing about it may change.
  IF OLD.status IN ('reimbursed', 'written_off') OR OLD.reimbursed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'MERCHANT_OOP_FROZEN: claim % is % and can no longer be modified. Raise a new claim or a correction instead.',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Never un-pay a claim.
  IF OLD.reimbursed_at IS NOT NULL AND NEW.reimbursed_at IS NULL THEN
    RAISE EXCEPTION 'MERCHANT_OOP_REIMBURSEMENT_CANNOT_BE_CLEARED: claim %', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Identity is fixed: a claim cannot be moved to another agent or payout.
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.withdrawal_id IS DISTINCT FROM OLD.withdrawal_id
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION
      'MERCHANT_OOP_IDENTITY_IMMUTABLE: agent_id, withdrawal_id and kind cannot change on claim %', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The money may only move while the claim is still undecided.
  IF (NEW.shortfall_amount IS DISTINCT FROM OLD.shortfall_amount
      OR NEW.payout_amount IS DISTINCT FROM OLD.payout_amount
      OR NEW.float_used IS DISTINCT FROM OLD.float_used
      OR NEW.telecom_charge IS DISTINCT FROM OLD.telecom_charge)
     AND (OLD.reviewed_at IS NOT NULL OR OLD.attested_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'MERCHANT_OOP_AMOUNT_LOCKED: claim % has been decided; its amounts cannot be rewritten (was %, attempted %).',
      OLD.id, OLD.shortfall_amount, NEW.shortfall_amount
      USING ERRCODE = 'check_violation';
  END IF;

  -- Legal transitions only.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'needs_review'          AND NEW.status IN ('pending_reimbursement','rejected','written_off'))
      OR (OLD.status = 'pending_reimbursement' AND NEW.status IN ('reimbursed','rejected','written_off','needs_review'))
      OR (OLD.status = 'rejected'              AND NEW.status IN ('pending_reimbursement','needs_review'))
    ) THEN
      RAISE EXCEPTION 'MERCHANT_OOP_ILLEGAL_TRANSITION: % -> % on claim %',
        OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- An attested obligation must always carry its justification.
  v_old_attested := COALESCE(OLD.evidence ->> 'finance_attested', '') = 'true';
  v_new_attested := COALESCE(NEW.evidence ->> 'finance_attested', '') = 'true';
  IF v_new_attested AND NOT v_old_attested THEN
    v_basis := btrim(COALESCE(NEW.evidence ->> 'basis', ''));
    IF length(v_basis) < 20 THEN
      RAISE EXCEPTION
        'MERCHANT_OOP_ATTESTATION_NEEDS_BASIS: setting finance_attested on claim % requires evidence->>''basis'' of at least 20 characters explaining why the books cannot corroborate it.',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_merchant_oop_integrity ON public.merchant_out_of_pocket_advances;
CREATE TRIGGER trg_enforce_merchant_oop_integrity
  BEFORE UPDATE OR DELETE ON public.merchant_out_of_pocket_advances
  FOR EACH ROW EXECUTE FUNCTION public.enforce_merchant_oop_integrity();

-- ── 2. Audit trail ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_merchant_oop_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changes text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 'merchant_oop_claim_created', 'merchant_out_of_pocket_advances', NEW.id::text,
      format('Own-money claim raised for UGX %s (status %s).',
             trim(to_char(COALESCE(NEW.shortfall_amount,0), 'FM999,999,999')), NEW.status),
      jsonb_build_object('agent_id', NEW.agent_id, 'withdrawal_id', NEW.withdrawal_id,
        'kind', NEW.kind, 'amount', NEW.shortfall_amount, 'status', NEW.status,
        'finance_attested', COALESCE(NEW.evidence ->> 'finance_attested', 'false')));
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_changes := v_changes || format('status %s -> %s', OLD.status, NEW.status);
  END IF;
  IF NEW.shortfall_amount IS DISTINCT FROM OLD.shortfall_amount THEN
    v_changes := v_changes || format('amount %s -> %s', OLD.shortfall_amount, NEW.shortfall_amount);
  END IF;
  IF COALESCE(NEW.evidence ->> 'finance_attested', '') IS DISTINCT FROM COALESCE(OLD.evidence ->> 'finance_attested', '') THEN
    v_changes := v_changes || format('finance_attested %s -> %s',
      COALESCE(OLD.evidence ->> 'finance_attested', 'false'),
      COALESCE(NEW.evidence ->> 'finance_attested', 'false'));
  END IF;

  IF array_length(v_changes, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'merchant_oop_claim_changed', 'merchant_out_of_pocket_advances', NEW.id::text,
    array_to_string(v_changes, '; '),
    jsonb_build_object('agent_id', NEW.agent_id, 'withdrawal_id', NEW.withdrawal_id,
      'changes', to_jsonb(v_changes),
      'old', jsonb_build_object('status', OLD.status, 'amount', OLD.shortfall_amount),
      'new', jsonb_build_object('status', NEW.status, 'amount', NEW.shortfall_amount),
      'review_note', NEW.review_note));
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_log_merchant_oop_change ON public.merchant_out_of_pocket_advances;
CREATE TRIGGER trg_log_merchant_oop_change
  AFTER INSERT OR UPDATE ON public.merchant_out_of_pocket_advances
  FOR EACH ROW EXECUTE FUNCTION public.log_merchant_oop_change();

-- ── 3. Close the client-side write path ────────────────────────────────────
-- The RPCs are SECURITY DEFINER and bypass RLS, so they are unaffected. The
-- app only ever read this table, so no UI behaviour changes.
DROP POLICY IF EXISTS "finance updates out of pocket" ON public.merchant_out_of_pocket_advances;
