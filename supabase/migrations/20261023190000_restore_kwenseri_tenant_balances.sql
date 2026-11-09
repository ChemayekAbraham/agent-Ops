-- Restore the true balances of Kwenseri Rodgers' tenants (agent 0742579891), as confirmed by the agent and Tenant Ops.
--
-- Each tenant's balance (plan total minus amount repaid) is set to the confirmed figure. The amount repaid is NOT touched: only the plan
-- total moves, so new total = confirmed balance + amount repaid.
--   * outstanding_balance plans: initial_outstanding_balance is set; the existing trigger enforce_outstanding_total_repayment then sets
--     total_repayment to it and daily_repayment to CEIL(total / duration_days).
--   * NOT INCLUDED: Nabbanja Annet (120,000), Ebesu Samuel (14,000) and Kizito Abel (151,900). They are normal plans whose total is fixed by
--     the rent-plus-fees formula (trigger enforce_rent_request_formula puts any other total straight back). Reaching those balances would
--     mean crediting repayments that were never received, or changing the rent/fees. That needs the Tenant Ops balance edit
--     (ops_edit_tenant_balance, with CFO approval), not a migration.
--
-- SAFE TO RE-RUN: a plan is only changed when its balance today is exactly the "was" figure below. Anything else is skipped and reported,
-- so a plan that has been paid or edited since is never overwritten. The old values are kept in rent_balance_correction_20261023 and
-- every change is written to audit_logs (and to rent_amount_change_log by the existing trigger).
-- Not changed: the day-by-day expected schedule (agent_expected_day_plans). See the note at the end.
-- Roll back with 20261023190000_restore_kwenseri_tenant_balances.rollback.sql.

CREATE TABLE IF NOT EXISTS public.rent_balance_correction_20261023 (
  rent_request_id uuid PRIMARY KEY,
  tenant_name text,
  registration_type text,
  old_initial_outstanding numeric,
  old_total_repayment numeric,
  old_daily_repayment numeric,
  amount_repaid numeric,
  balance_before numeric,
  balance_after numeric,
  corrected_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.rent_balance_correction_20261023 ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.rent_balance_correction_20261023 TO service_role;

DO $fix$
DECLARE
  r record;
  v_new numeric;
  v_done int := 0;
  v_skipped int := 0;
BEGIN
  FOR r IN
    SELECT rr.id, t.full_name, rr.registration_type, rr.initial_outstanding_balance, rr.total_repayment, rr.daily_repayment, rr.amount_repaid,
           rr.duration_days, rr.status, c.was, c.target
      FROM (VALUES
        ('a8840497-392c-4f05-b6cb-d34c896ad0ea'::uuid, 415000::numeric, 390000::numeric),  -- Bwana Harman
        ('94e1d263-23c5-425d-87e0-b03baafade7f'::uuid, 380000::numeric, 380000::numeric),  -- Mutesasira Ashraf (already right)
        ('7ad2977a-bf36-469b-8364-f3db42404ee7'::uuid, 403000::numeric, 340000::numeric),  -- Wesonga Simon
        ('09d50bde-9121-41f5-a577-1a9f67cbbb9c'::uuid, 106200::numeric,  55000::numeric),  -- Nansubuga Teddy
        ('51fd665e-11b2-4c01-a89e-bf32171a9a01'::uuid, 101000::numeric,  80000::numeric),  -- Wabulebo Collins
        ('ea327573-23f0-40f6-b556-ad60f97c5b02'::uuid,  48200::numeric,  42200::numeric),  -- Namuwanga Fatuma
        ('8167361f-2370-4e0c-94f0-a63fd87de9c9'::uuid,  46000::numeric,  20000::numeric),  -- Mpirwe Dennis
        ('7540aa98-5819-49dd-aae7-73962e17dd4d'::uuid,  39000::numeric,  29000::numeric),  -- Katende Sharif
        ('340f267a-c507-43d6-b8a2-969e7dc86eb8'::uuid,  38000::numeric,  20000::numeric),  -- Ssewaya John
        ('204da47e-6bb4-4413-84ec-a749a747dacc'::uuid,  30000::numeric,  10000::numeric),  -- Mugisha Hakim
        ('373f19db-cc20-47eb-9c66-62b0e032f807'::uuid,  23000::numeric,  23000::numeric),  -- Wakabi Ivan (already right)
        ('709e133b-e12c-4fb6-9376-8a629bda2f93'::uuid, 226000::numeric,  88000::numeric)   -- Nagaba Bernard
      ) c(id, was, target)
      JOIN public.rent_requests rr ON rr.id = c.id
      LEFT JOIN public.profiles t ON t.id = rr.tenant_id
  LOOP
    IF r.was = r.target THEN
      RAISE NOTICE 'SAME     % : balance already % (nothing to change)', r.full_name, r.target;
      CONTINUE;
    END IF;
    IF r.registration_type <> 'outstanding_balance' THEN
      RAISE NOTICE 'SKIPPED  % : not an outstanding_balance plan (use the Tenant Ops balance edit)', r.full_name;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF r.total_repayment - r.amount_repaid <> r.was OR r.status NOT IN ('repaying', 'funded') THEN
      RAISE NOTICE 'SKIPPED  % : balance is now % (expected %), status %', r.full_name, r.total_repayment - r.amount_repaid, r.was, r.status;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_new := r.target + r.amount_repaid;
    INSERT INTO public.rent_balance_correction_20261023
      (rent_request_id, tenant_name, registration_type, old_initial_outstanding, old_total_repayment, old_daily_repayment, amount_repaid, balance_before, balance_after)
    VALUES (r.id, r.full_name, r.registration_type, r.initial_outstanding_balance, r.total_repayment, r.daily_repayment, r.amount_repaid, r.was, r.target)
    ON CONFLICT (rent_request_id) DO NOTHING;

    UPDATE public.rent_requests SET initial_outstanding_balance = v_new WHERE id = r.id;

    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, old_values, new_values, reason)
    VALUES (NULL, 'balance_restored_by_agent_and_tenant_ops', 'Restored the tenant balance confirmed by the agent and Tenant Ops', 'rent_requests', r.id::text,
            jsonb_build_object('balance', r.was, 'total_repayment', r.total_repayment, 'daily_repayment', r.daily_repayment),
            jsonb_build_object('balance', r.target, 'total_repayment', v_new, 'amount_repaid', r.amount_repaid),
            'Confirmed by the agent and Tenant Ops: balances before they were inflated');
    v_done := v_done + 1;
    RAISE NOTICE 'RESTORED % : balance % -> %', r.full_name, r.was, r.target;
  END LOOP;
  RAISE NOTICE 'Done: % restored, % skipped', v_done, v_skipped;
END
$fix$;

-- NOTE: agent_expected_day_plans holds the day-by-day expected amounts built from the OLD daily figure. This migration does not rewrite
-- them. Until the daily schedule is capped at the balance owed (separate change), the billed-to-date figure for these tenants still
-- counts days past the plan's end.
