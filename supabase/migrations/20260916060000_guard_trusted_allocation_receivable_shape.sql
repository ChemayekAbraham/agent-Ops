-- Agents blocked from collecting rent: "Agents cannot move a rent request
-- from funded to repaying", plus a quieter twin bug on plans already
-- 'repaying' where the same collection reports success but never actually
-- moves amount_repaid.
--
-- THE DEFECT
-- Sometime around 2026-09-15 15:12 UTC, `agent_allocate_tenant_payment_internal`
-- was redesigned in production (outside this repo — not reflected in any
-- migration file here) so that agent float is a non-consuming eligibility
-- gate rather than cash that gets debited. It stopped writing the
-- `agent_float_used_for_rent` / `tenant_repayment` wallet-float legs that
-- `guard_rent_request_agent_updates` (see 20260910130000) requires before it
-- will trust an agent's own write to `rent_requests.amount_repaid`/`status`.
--
-- The guard was never updated to match. Since the cutoff:
--   - First payment on a plan (status funded/disbursed/approved -> repaying):
--     the guard finds no trusted shape and hard-blocks the status change,
--     surfacing as "Agents cannot move a rent request from funded to
--     repaying" in the Confirm Payment dialog. Reported live 2026-09-16 by
--     agent Nattu Sharifah, tenant Mugisha David (rent_request
--     d00189d1-2721-458e-b5b9-8f3f042b4a79) — still status='funded',
--     amount_repaid=0 after the attempt, transaction rolled back cleanly.
--   - Any later payment on an already-'repaying' plan: no exception (status
--     isn't changing), so the RPC returns success, commission is paid, and
--     ledger legs are written — but the guard silently reverts
--     NEW.amount_repaid to OLD.amount_repaid. Confirmed live: rent_request
--     294797c8-0c1a-4a31-ac82-00d8560173ee took three separate 20,000
--     collections inside one minute and amount_repaid read 226,000 after all
--     three. 660 collections totalling UGX 73,768,785 have posted since the
--     2026-09-15 15:12 UTC cutoff with this problem.
--
-- THE FIX
-- Add a third trusted-allocation shape that matches what the RPC actually
-- writes today: the `tenant_repayment_collected` cash_out leg on
-- ledger_scope='platform' — source_table/source_id pin it to this exact rent
-- request, user_id pins it to this tenant, amount must equal the repayment
-- delta, and xmin pins it to this transaction. This is the leg that
-- represents "this rent request's receivable was reduced by exactly this
-- amount right now" under the current design, so it is at least as strong a
-- trust signal as the wallet-float legs it replaces. Shapes 1 and 2 are left
-- in place (harmless — they simply will not match going forward) rather than
-- removed, in case the wallet-float leg ever comes back.
--
-- NOT in scope here: backfilling amount_repaid/status for the 660
-- collections already silently dropped since the cutoff. That needs a
-- careful reconciliation against the ledger as source of truth and is
-- tracked separately in docs/HANDOVER.

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
  v_receivable_reduced_matched boolean := false;
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

    -- Shape 1 (legacy, not written since ~2026-09-15): the agent spent their
    -- operational float to settle this tenant's rent. cash_out on the float
    -- bucket, matched per collection.
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

    -- Shape 2 (legacy, not written since ~2026-09-15): tenant self-repayment
    -- via deposit, same-amount tenant_repayment debit on the float bucket.
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

    -- Shape 3 (current design, 2026-09-15+): float is a non-consuming
    -- eligibility gate, not spent cash, so no wallet-float leg is written any
    -- more. Trust the leg that is still written for every collection: the
    -- tenant's receivable reduced by exactly this amount, for this rent
    -- request, in this transaction.
    SELECT EXISTS (
      SELECT 1
        FROM public.general_ledger gl
       WHERE gl.source_table = 'agent_collections'
         AND gl.source_id = OLD.id
         AND gl.user_id = NEW.tenant_id
         AND gl.category = 'tenant_repayment_collected'
         AND gl.direction = 'cash_out'
         AND gl.ledger_scope = 'platform'
         AND gl.amount = v_repayment_delta
         AND gl.xmin = v_this_xid
    ) INTO v_receivable_reduced_matched;

    v_expected_status := CASE
      WHEN COALESCE(NEW.amount_repaid, 0) >= COALESCE(NEW.total_repayment, 0)
        THEN 'completed'
      WHEN OLD.status IN ('disbursed', 'funded', 'approved')
        THEN 'repaying'
      ELSE OLD.status
    END;

    v_trusted_allocation :=
      (v_float_debit_matched OR v_tenant_paid_matched OR v_receivable_reduced_matched)
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

-- Post-condition: the new shape must be present and the two legacy shapes
-- (dead but harmless) must still be there.
DO $verify$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_rent_request_agent_updates'
   LIMIT 1;

  IF position('tenant_repayment_collected' in v_src) = 0 THEN
    RAISE EXCEPTION 'guard is missing the new receivable-reduced trust shape';
  END IF;
  IF position('agent_float_used_for_rent' in v_src) = 0 THEN
    RAISE EXCEPTION 'guard lost the legacy float-debit shape';
  END IF;
END
$verify$;
