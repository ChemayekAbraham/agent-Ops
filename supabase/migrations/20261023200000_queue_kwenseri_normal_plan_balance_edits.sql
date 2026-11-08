-- Kwenseri Rodgers' three NORMAL-plan tenants: file the balance corrections for the CFO to approve.
--
-- The twelve outstanding_balance plans were corrected directly in 20261023190000. These three cannot be: a normal plan's total is fixed by the
-- rent-plus-fees formula, so the only way to reach the confirmed balance is the Tenant Ops balance edit, which the CFO approver must decide
-- (cfo_decide_tenant_balance_edit). This file only FILES the three requests as pending, in the name of Joshua Wanda (Tenant Ops), exactly as
-- ops_edit_tenant_balance would. Nothing on the tenants' plans changes until the CFO approves each one.
--
-- WHAT APPROVAL DOES (existing behaviour, not changed here): the plan total stays; amount_repaid is set to total minus the target balance.
--   Nabbanja Annet : balance 199,000 -> 120,000   amount repaid 77,000  -> 156,000  (+79,000)
--   Ebesu Samuel   : balance 151,000 ->  14,000   amount repaid 268,000 -> 405,000  (+137,000)
--   Kizito Abel    : balance 271,900 -> 151,900   amount repaid 4,100   -> 124,100  (+120,000)
-- That records UGX 336,000 as repaid with no money collected: it is a correction of the balance, not a payment. The reason text says so.
-- Skips any plan whose balance is no longer the expected figure, or that already has a pending edit. Safe to re-run.

DO $q$
DECLARE
  v_editor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';  -- Joshua Wanda
  v_name text;
  r record;
  v_outstanding numeric;
BEGIN
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_editor;
  FOR r IN
    SELECT rr.*, c.was, c.target
      FROM (VALUES
        ('565980f5-f9ac-4b61-bbda-b44f5ccac706'::uuid, 199000::numeric, 120000::numeric),  -- Nabbanja Annet
        ('e03b6dde-e984-46e4-a822-05bcc0b57621'::uuid, 151000::numeric,  14000::numeric),  -- Ebesu Samuel
        ('cad4635a-c7f6-4efe-b8ef-243ab00b4976'::uuid, 271900::numeric, 151900::numeric)   -- Kizito Abel
      ) c(id, was, target)
      JOIN public.rent_requests rr ON rr.id = c.id
  LOOP
    v_outstanding := GREATEST(COALESCE(r.total_repayment, 0) - COALESCE(r.amount_repaid, 0), 0);
    IF v_outstanding <> r.was THEN
      RAISE NOTICE 'SKIPPED % : balance is now % (expected %)', r.id, v_outstanding, r.was;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenant_balance_edits WHERE rent_request_id = r.id AND status = 'pending') THEN
      RAISE NOTICE 'SKIPPED % : already has a change waiting for CFO approval', r.id;
      CONTINUE;
    END IF;
    INSERT INTO public.tenant_balance_edits (
      rent_request_id, tenant_id, agent_id, editor_id, editor_name,
      old_rent_amount, new_rent_amount, old_total_repayment, new_total_repayment, old_amount_repaid, new_amount_repaid,
      old_daily_repayment, new_daily_repayment, old_outstanding, new_outstanding,
      target_rent_amount, target_outstanding, reason, status, source
    ) VALUES (
      r.id, r.tenant_id, COALESCE(r.assigned_agent_id, r.agent_id), v_editor, v_name,
      r.rent_amount, r.rent_amount, r.total_repayment, NULL, COALESCE(r.amount_repaid, 0), NULL,
      r.daily_repayment, NULL, v_outstanding, r.target,
      NULL, r.target,
      'Balance correction, not a payment: the agent (Kwenseri Rodgers) and Tenant Ops confirmed this tenant''s true balance is UGX '
        || to_char(r.target, 'FM999,999,999') || ' before it was inflated. No money was collected for the difference.',
      'pending', 'tenant_ops_balance'
    );
    RAISE NOTICE 'FILED   % : balance % -> % (pending CFO approval)', r.id, v_outstanding, r.target;
  END LOOP;
END
$q$;
