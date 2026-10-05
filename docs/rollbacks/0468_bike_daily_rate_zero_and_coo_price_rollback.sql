-- Rollback for bike daily_rate=0 + COO price lock (2026-10-05)
DROP TRIGGER IF EXISTS trg_zz_bike_plan_zero_daily_rate ON public.merchandise_recovery_plans;
DROP FUNCTION IF EXISTS public.trg_bike_plan_zero_daily_rate();
UPDATE public.merchandise_recovery_plans SET daily_rate = 0.15 WHERE id = 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9';
UPDATE public.merchandise_recovery_plans SET daily_rate = 0.33 WHERE id = 'c95555c7-6363-4f09-b7c4-220a272db6ab';
UPDATE public.merchandise_recovery_plans SET daily_rate = 0.15 WHERE id = '08f711e2-927a-43dd-bce0-73831c4dd16a';
UPDATE public.merchandise_recovery_plans SET daily_rate = 0.33 WHERE id = '9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0';
UPDATE public.merchandise_recovery_plans SET daily_rate = 0.33 WHERE id = 'bc2acdbe-8e2c-4c90-aab4-5e922bf50c93';
UPDATE public.merchandise_recovery_plans SET daily_rate = 0.33 WHERE id = '48c09a3f-b128-4671-8e01-8a9a88af429f';
UPDATE public.merchandise_recovery_plans SET daily_rate = 0.15 WHERE id = '93d95269-34da-45f0-9845-fff6b7312220';
UPDATE public.merchandise_recovery_plans SET daily_rate = 0.33 WHERE id = 'b782182a-0e04-4f63-bd7b-9b94b95d4ca5';
ALTER TABLE public.merchandise_recovery_plans DROP CONSTRAINT merchandise_recovery_plans_daily_rate_check;
ALTER TABLE public.merchandise_recovery_plans ADD CONSTRAINT merchandise_recovery_plans_daily_rate_check CHECK (((daily_rate > (0)::numeric) AND (daily_rate <= (1)::numeric)));
CREATE OR REPLACE FUNCTION public.cfo_disburse_bike_lease(p_sale_id uuid, p_valuation numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_valuation numeric;
  v_recover numeric;
  v_term integer;
  v_projection numeric;
  v_fee numeric;
  v_total numeric;
  v_customer uuid;
  v_name text;
  v_ref text;
  v_group uuid;
BEGIN

  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;
  IF NOT public.can_cfo_disburse_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to release Spiro bikes';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'coo_approved' THEN
    RAISE EXCEPTION 'Application must be COO approved before disbursement (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;

  v_customer := v_sale.customer_id;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  v_valuation := COALESCE(NULLIF(p_valuation, 0), v_sale.valuation_amount, v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_valuation <= 0 THEN
    RAISE EXCEPTION 'Bike valuation must be greater than zero';
  END IF;
  v_recover := GREATEST(v_valuation - COALESCE(v_sale.amount_paid, 0), 0);
  IF v_recover <= 0 THEN
    RAISE EXCEPTION 'Lease has no amount to recover';
  END IF;
  v_term := GREATEST(COALESCE(v_sale.lease_term_months, 12), 1);
  v_projection := (SELECT m.daily FROM public._spiro_lease_month(v_valuation, v_term, 1) m);
  -- Bike price + 28% monthly fee on the principal still owed (matches src/lib/spiroBikeLease.ts).
  v_fee := public._spiro_lease_fee_total(v_valuation, v_term);
  v_total := v_recover + v_fee;

  -- Money goes to the ordering agent's own wallet. Idempotent on reference.
  v_ref := 'bike-lease-disbursement-' || p_sale_id::text;

  IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_ref) THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_customer,
          'amount', v_valuation,
          'direction', 'cash_in',
          'category', 'agent_advance_credit',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_ref,
          'currency', 'UGX',
          'description', 'Bike lease disbursement to ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_uid,
          'amount', v_valuation,
          'direction', 'cash_out',
          'category', 'equipment_expense',
          'ledger_scope', 'platform',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_ref,
          'currency', 'UGX',
          'description', 'Bike lease funded for ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        )
      ),
      v_ref
    );
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      valuation_amount = v_valuation,
      total_amount = v_valuation,
      total_revenue = v_valuation,
      unit_price = v_valuation / GREATEST(COALESCE(quantity, 1), 1),
      amount_outstanding = v_total,
      payment_projection = v_projection,
      lease_daily_rate = NULL,
      payment_status = 'credit',
      cfo_disbursed_by = v_uid,
      cfo_disbursed_at = now(),
      disbursed_amount = v_valuation,
      disbursement_group_id = COALESCE(v_group, disbursement_group_id),
      lease_activated_at = now(),
      notes = COALESCE(notes, '') || ' | CFO disbursed to the agent wallet and activated the lease '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at valuation ' || to_char(v_valuation, 'FM999,999,999')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  -- daily_rate is 0 for bikes: recovery uses the 28% reducing-balance month / 30.
  IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id) THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, daily_rate, created_by,
      pricing_basis, fee_total, principal_total
    ) VALUES (
      p_sale_id, v_customer, COALESCE(v_name, v_sale.client_name), v_sale.client_phone,
      COALESCE(v_sale.item_name, 'Welile Spiro Bike'), v_total, v_total, 0, v_uid,
      'spiro_28pct_v2', v_fee, v_recover
    );
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET original_amount = v_total,
        outstanding_balance = GREATEST(v_total - COALESCE(amount_recovered, 0), 0),
        daily_rate = 0,
        pricing_basis = 'spiro_28pct_v2',
        fee_total = v_fee,
        principal_total = v_recover,
        fee_recovered = 0,
        principal_recovered = COALESCE(amount_recovered, 0)
    WHERE sale_id = p_sale_id AND status = 'active';
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_cfo_disbursed', 'merchandise_sales', p_sale_id,
            'CFO disbursed the bike funds to the ordering agent wallet and activated the recovery lease',
            jsonb_build_object('valuation', v_valuation, 'recovery_amount', v_total,
                               'principal', v_recover, 'access_fee', v_fee,
                               'monthly_rate_pct', 28, 'lease_term_months', v_term,
                               'credited_agent_id', v_customer, 'reference_id', v_ref));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'valuation', v_valuation,
    'recovery_amount', v_total,
    'principal', v_recover,
    'access_fee', v_fee,
    'daily_recovery', v_projection,
    'monthly_rate_pct', 28,
    'lease_term_months', v_term,
    'credited_agent_id', v_customer,
    'disbursement_group_id', v_group
  );
END;
$function$

;
