-- D4: two collections on the same plan in one transaction silently lose the
-- second one's balance.
--
-- THE DEFECT
-- `guard_rent_request_agent_updates` decides whether an agent's increase to
-- `amount_repaid` is trusted by looking for the matching float debit in the
-- ledger. It did so with a SUM over every float leg written for that plan in
-- the current transaction:
--
--     SELECT COALESCE(sum(gl.amount), 0) INTO v_current_tx_float_debit
--       FROM general_ledger gl
--      WHERE ... gl.source_id = OLD.id
--        AND gl.xmin::text::bigint = txid_current();
--     ...
--     v_trusted_allocation := (v_current_tx_float_debit = v_repayment_delta) AND ...
--
-- With one collection per transaction - which is what the app does - the sum
-- is that one collection and the test passes. With two collections on the same
-- plan in one transaction the sum becomes a1 + a2 while the delta is only a2,
-- the test fails, and the guard SILENTLY reverts `amount_repaid` to its old
-- value (`NEW.amount_repaid := OLD.amount_repaid`). The float was spent, the
-- receipt was written, the tenant's balance never moved.
--
-- Reproduced twice: once on 2026-09-09 and again during the SMALLS Ronald
-- Musana test on 2026-09-10, where a scenario needed a set-up payment and a
-- test payment in the same transaction.
--
-- Not reachable from the app today - PostgREST gives every RPC call its own
-- transaction - but any future batch or bulk-collection path would hit it, and
-- lose money quietly rather than failing.
--
-- FIX 1: match the specific collection, not the sum. A trusted increase needs
-- a float debit of exactly that amount written in this transaction. Two
-- collections in one transaction now each find their own row.
--
-- FIX 2: `gl.xmin::text::bigint = txid_current()` is a latent time bomb. `xmin`
-- is a 32-bit xid; `txid_current()` is 64-bit - epoch * 2^32 + xid. They agree
-- only while the epoch is 0. At the first xid wraparound the test can never
-- match again, so every agent collection would stop crediting the tenant AND
-- start raising 'Agents cannot move a rent request from funded to repaying'.
-- The epoch is 0 today, so this is a correctness fix with no behaviour change
-- now. `pg_current_xact_id()::xid` compares like with like.
--
-- FIX 3: the comment above the float test still claimed the leg is `cash_in`
-- "because collection INCREASES cash at hand". That comment is the rationale
-- that was used to invert the collection path on 2026-09-10 and cost 6,064,036
-- in wrongly credited float. The code was corrected the same day; the comment
-- was not. Removing it so it cannot be cited again.
--
-- STILL OPEN, deliberately unchanged: the trusted test is satisfied by the
-- presence of a matching ledger row, not by consuming a one-shot authorisation,
-- so a caller who can UPDATE rent_requests directly could in principle apply
-- the same debit twice within one transaction. That hole is identical before
-- and after this migration; closing it means adding a token to
-- agent_allocate_tenant_payment_internal, which is deployed outside this
-- repository, and a redeploy without the token would break every collection.

CREATE OR REPLACE FUNCTION public.guard_rent_request_agent_updates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_repayment_delta numeric := COALESCE(NEW.amount_repaid, 0) - COALESCE(OLD.amount_repaid, 0);
  v_this_xid xid := pg_current_xact_id()::xid;
  v_float_debit_matched boolean := false;
  v_tenant_paid_matched boolean := false;
  v_trusted_allocation boolean := false;
  v_expected_status text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_sensitive_field_editor(v_uid)
     OR public.has_role(v_uid, 'manager'::app_role) THEN
    RETURN NEW;
  END IF;

  IF NOT (public.has_role(v_uid, 'agent'::app_role)
          OR public.has_role(v_uid, 'senior_agent'::app_role)
          OR public.has_role(v_uid, 'sub_agent'::app_role)) THEN
    RETURN NEW;
  END IF;

  IF v_repayment_delta > 0
     AND OLD.agent_id = v_uid
     AND NEW.agent_id = OLD.agent_id
     AND NEW.tenant_id = OLD.tenant_id
     AND NEW.total_repayment = OLD.total_repayment THEN

    -- Shape 1: the agent spent their operational float to settle this tenant's
    -- rent. The leg is cash_out on the float bucket - a collection DEBITS the
    -- agent's float. Matched per collection: exactly this increase must have a
    -- float debit of exactly this amount written in this transaction, so two
    -- collections on one plan in one transaction each find their own row
    -- instead of colliding on a sum.
    SELECT EXISTS (
      SELECT 1
        FROM public.general_ledger gl
       WHERE gl.source_table = 'agent_collections'
         AND gl.source_id = OLD.id
         AND gl.user_id = v_uid
         AND gl.category = 'agent_float_used_for_rent'
         AND gl.direction = 'cash_out'
         AND gl.ledger_scope = 'wallet'
         AND gl.wallet_bucket = 'float'
         AND gl.recipient_type = 'operational_wallet'
         AND gl.amount = v_repayment_delta
         AND gl.xmin = v_this_xid
    ) INTO v_float_debit_matched;

    -- Shape 2 (tenant self-repayment): a same-amount tenant_repayment debit on
    -- the operational wallet, float bucket, backed by a non-agent_float
    -- collection row carrying a deposit reference and float_before = float_after.
    SELECT EXISTS (
      SELECT 1
        FROM public.general_ledger gl
       WHERE gl.source_table = 'agent_collections'
         AND gl.source_id = OLD.id
         AND gl.category = 'tenant_repayment'
         AND gl.direction = 'cash_out'
         AND gl.ledger_scope = 'wallet'
         AND gl.wallet_bucket = 'float'
         AND gl.recipient_type = 'operational_wallet'
         AND gl.amount = v_repayment_delta
         AND gl.xmin = v_this_xid
         AND EXISTS (
           SELECT 1 FROM public.agent_collections ac
            WHERE ac.rent_request_id = OLD.id
              AND ac.amount = gl.amount
              AND ac.collection_channel <> 'agent_float'
              AND ac.deposit_request_id IS NOT NULL
              AND ac.float_before = ac.float_after
         )
    ) INTO v_tenant_paid_matched;

    v_expected_status := CASE
      WHEN COALESCE(NEW.amount_repaid, 0) >= COALESCE(NEW.total_repayment, 0)
        THEN 'completed'
      WHEN OLD.status IN ('disbursed', 'funded', 'approved')
        THEN 'repaying'
      ELSE OLD.status
    END;

    v_trusted_allocation :=
      (v_float_debit_matched OR v_tenant_paid_matched)
      AND COALESCE(NEW.amount_repaid, 0) <= COALESCE(NEW.total_repayment, 0)
      AND NEW.status = v_expected_status;
  END IF;

  NEW.approved_by := OLD.approved_by;
  NEW.approved_at := OLD.approved_at;
  NEW.funded_at := OLD.funded_at;
  NEW.disbursed_at := OLD.disbursed_at;
  NEW.fund_routed_at := OLD.fund_routed_at;
  NEW.fund_recipient_id := OLD.fund_recipient_id;
  NEW.fund_recipient_type := OLD.fund_recipient_type;
  NEW.fund_recipient_name := OLD.fund_recipient_name;
  NEW.manager_verified := OLD.manager_verified;
  NEW.manager_verified_at := OLD.manager_verified_at;
  NEW.manager_verified_by := OLD.manager_verified_by;

  IF NOT v_trusted_allocation THEN
    NEW.amount_repaid := OLD.amount_repaid;
    NEW.last_payment_amount := OLD.last_payment_amount;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.status = 'rejected'
     AND OLD.agent_id = v_uid
     AND NEW.status <> 'repaying'
     AND NEW.status <> 'deleted_by_agent' THEN
    NEW.status := 'pending';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      v_trusted_allocation
      OR NEW.status IN ('pending', 'rejected', 'deleted_by_agent')
      OR (OLD.status = 'rejected' AND NEW.status = 'repaying')
    ) THEN
      RAISE EXCEPTION 'Agents cannot move a rent request from % to %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Post-conditions: the two defects must be gone, and the collection path must
-- still be the cash_out shape the 2026-09-10 incident fix restored.
DO $verify$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_rent_request_agent_updates'
   LIMIT 1;

  IF position('xmin::text::bigint' in v_src) > 0 THEN
    RAISE EXCEPTION 'guard still compares a 32-bit xmin against a 64-bit txid';
  END IF;
  IF position('sum(gl.amount)' in v_src) > 0 THEN
    RAISE EXCEPTION 'guard still sums float legs across the transaction';
  END IF;
  IF position('gl.direction = ''cash_in''' in v_src) > 0 THEN
    RAISE EXCEPTION 'guard expects an inverted collection leg - refusing';
  END IF;
END
$verify$;
