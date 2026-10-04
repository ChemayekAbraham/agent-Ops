-- ============================================================
-- Merchandise Purchase Recovery from Customer Wallet
-- Automated daily 15% withdrawable-wallet recovery of merchandise cost,
-- replacing manual CFO balance corrections.
-- ============================================================

-- 1. Link a merchandise sale to a registered customer (wallet to recover from)
ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS customer_id uuid;

-- 2. Phone normalizer (compare on last 9 digits)
CREATE OR REPLACE FUNCTION public.normalize_phone_9(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT RIGHT(regexp_replace(COALESCE(p_phone,''), '\D', '', 'g'), 9);
$$;

-- 3. Recovery plans (one per merchandise debt to recover from a wallet)
CREATE TABLE public.merchandise_recovery_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid REFERENCES public.merchandise_sales(id) ON DELETE SET NULL,
  customer_id uuid NOT NULL,
  customer_name text,
  customer_phone text,
  item_name text NOT NULL,
  original_amount numeric NOT NULL DEFAULT 0 CHECK (original_amount >= 0),
  outstanding_balance numeric NOT NULL DEFAULT 0 CHECK (outstanding_balance >= 0),
  amount_recovered numeric NOT NULL DEFAULT 0 CHECK (amount_recovered >= 0),
  daily_rate numeric NOT NULL DEFAULT 0.15 CHECK (daily_rate > 0 AND daily_rate <= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  last_recovery_at timestamptz,
  completed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_merch_recovery_plans_customer ON public.merchandise_recovery_plans(customer_id);
CREATE INDEX idx_merch_recovery_plans_status ON public.merchandise_recovery_plans(status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_recovery_plans TO authenticated;
GRANT ALL ON public.merchandise_recovery_plans TO service_role;

ALTER TABLE public.merchandise_recovery_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leadership manage merchandise recovery plans"
ON public.merchandise_recovery_plans FOR ALL
TO authenticated
USING (has_role(auth.uid(),'cmo') OR has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'super_admin'))
WITH CHECK (has_role(auth.uid(),'cmo') OR has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'super_admin'));

CREATE POLICY "Customers view own merchandise recovery plans"
ON public.merchandise_recovery_plans FOR SELECT
TO authenticated
USING (customer_id = auth.uid());

CREATE TRIGGER update_merch_recovery_plans_updated_at
BEFORE UPDATE ON public.merchandise_recovery_plans
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Per-deduction log (transparent audit trail for dashboards)
CREATE TABLE public.merchandise_recovery_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.merchandise_recovery_plans(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  item_name text,
  amount numeric NOT NULL CHECK (amount > 0),
  withdrawable_before numeric NOT NULL DEFAULT 0,
  outstanding_after numeric NOT NULL DEFAULT 0,
  transaction_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_merch_recovery_deductions_plan ON public.merchandise_recovery_deductions(plan_id);
CREATE INDEX idx_merch_recovery_deductions_customer ON public.merchandise_recovery_deductions(customer_id);

GRANT SELECT, INSERT ON public.merchandise_recovery_deductions TO authenticated;
GRANT ALL ON public.merchandise_recovery_deductions TO service_role;

ALTER TABLE public.merchandise_recovery_deductions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leadership view merchandise recovery deductions"
ON public.merchandise_recovery_deductions FOR SELECT
TO authenticated
USING (has_role(auth.uid(),'cmo') OR has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'super_admin'));

CREATE POLICY "Customers view own merchandise recovery deductions"
ON public.merchandise_recovery_deductions FOR SELECT
TO authenticated
USING (customer_id = auth.uid());

-- 5. Auto-create a recovery plan when a sale has an unpaid balance and a registered buyer
CREATE OR REPLACE FUNCTION public.create_merchandise_recovery_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer uuid;
  v_name text;
BEGIN
  IF COALESCE(NEW.amount_outstanding, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_customer := NEW.customer_id;
  IF v_customer IS NULL AND NEW.client_phone IS NOT NULL
     AND public.normalize_phone_9(NEW.client_phone) <> '' THEN
    SELECT id INTO v_customer
    FROM public.profiles
    WHERE public.normalize_phone_9(phone) = public.normalize_phone_9(NEW.client_phone)
    LIMIT 1;
  END IF;

  -- Unregistered buyer: keep it as a plain receivable, no wallet recovery.
  IF v_customer IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  INSERT INTO public.merchandise_recovery_plans (
    sale_id, customer_id, customer_name, customer_phone, item_name,
    original_amount, outstanding_balance, daily_rate, created_by
  ) VALUES (
    NEW.id, v_customer, COALESCE(v_name, NEW.client_name), NEW.client_phone, NEW.item_name,
    NEW.amount_outstanding, NEW.amount_outstanding, 0.15, NEW.created_by
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_create_merchandise_recovery_plan
AFTER INSERT ON public.merchandise_sales
FOR EACH ROW EXECUTE FUNCTION public.create_merchandise_recovery_plan();

-- 6. Daily recovery engine: deduct 15% of each customer's withdrawable balance
CREATE OR REPLACE FUNCTION public.recover_merchandise_from_wallets()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan            record;
  v_avail           numeric;
  v_amount          numeric;
  v_closing         numeric;
  v_ref             uuid;
  v_idem            text;
  v_desc            text;
  v_plans_touched   int := 0;
  v_recovered_total numeric := 0;
BEGIN
  FOR v_plan IN
    SELECT * FROM public.merchandise_recovery_plans
    WHERE status = 'active' AND outstanding_balance > 0
    ORDER BY created_at ASC
  LOOP
    -- STRICT withdrawable only (never float/commission custody).
    v_avail := COALESCE(public.get_user_available_balance(v_plan.customer_id), 0);
    IF v_avail <= 0 THEN CONTINUE; END IF;

    -- 15% of available, capped at the remaining debt and the available balance.
    v_amount := LEAST(
      v_plan.outstanding_balance,
      v_avail,
      GREATEST(round(v_avail * v_plan.daily_rate), 1)
    );
    IF v_amount <= 0 THEN CONTINUE; END IF;

    v_ref  := gen_random_uuid();
    v_idem := 'merch_recover_' || v_plan.id::text || '_' || to_char(now(), 'YYYYMMDD');
    v_desc := 'Merchandise Payment – ' || COALESCE(v_plan.item_name, 'Item') || ' (Daily 15% Recovery)';

    BEGIN
      PERFORM public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', v_plan.customer_id,
            'ledger_scope', 'wallet',
            'direction', 'cash_out',
            'amount', v_amount,
            'category', 'wallet_deduction',
            'recipient_type', 'user',
            'wallet_bucket', 'withdrawable',
            'source_table', 'merchandise_recovery_plans',
            'source_id', v_plan.id,
            'description', v_desc,
            'currency', 'UGX',
            'metadata', jsonb_build_object(
              'source', 'merchandise_daily_recovery',
              'plan_id', v_plan.id,
              'sale_id', v_plan.sale_id,
              'recovery_rate', v_plan.daily_rate
            )
          ),
          jsonb_build_object(
            'user_id', v_plan.customer_id,
            'ledger_scope', 'platform',
            'direction', 'cash_in',
            'amount', v_amount,
            'category', 'debt_recovery',
            'recipient_type', 'operational_wallet',
            'source_table', 'merchandise_recovery_plans',
            'source_id', v_plan.id,
            'description', 'Merchandise cost recovered from customer wallet: ' || COALESCE(v_plan.item_name, 'Item'),
            'currency', 'UGX',
            'metadata', jsonb_build_object(
              'source', 'merchandise_daily_recovery',
              'plan_id', v_plan.id
            )
          )
        ),
        idempotency_key => v_idem
      );
    EXCEPTION WHEN OTHERS THEN
      -- Already recovered today (idempotency clash) or a transient failure: skip.
      CONTINUE;
    END;

    v_closing := v_plan.outstanding_balance - v_amount;

    UPDATE public.merchandise_recovery_plans
    SET outstanding_balance = GREATEST(0, v_closing),
        amount_recovered    = amount_recovered + v_amount,
        last_recovery_at    = now(),
        status              = CASE WHEN v_closing <= 0 THEN 'completed' ELSE 'active' END,
        completed_at        = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END,
        updated_at          = now()
    WHERE id = v_plan.id;

    INSERT INTO public.merchandise_recovery_deductions (
      plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref
    ) VALUES (
      v_plan.id, v_plan.customer_id, v_plan.item_name, v_amount, v_avail, GREATEST(0, v_closing), v_ref
    );

    -- Keep the originating sale receivable in sync so AR dashboards reflect payment.
    IF v_plan.sale_id IS NOT NULL THEN
      UPDATE public.merchandise_sales
      SET amount_paid        = amount_paid + v_amount,
          amount_outstanding = GREATEST(0, amount_outstanding - v_amount),
          payment_status     = CASE WHEN GREATEST(0, amount_outstanding - v_amount) <= 0 THEN 'paid' ELSE 'partial' END,
          updated_at         = now()
      WHERE id = v_plan.sale_id;
    END IF;

    v_plans_touched   := v_plans_touched + 1;
    v_recovered_total := v_recovered_total + v_amount;
  END LOOP;

  RETURN jsonb_build_object(
    'plans_recovered', v_plans_touched,
    'total_recovered', v_recovered_total,
    'ran_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recover_merchandise_from_wallets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recover_merchandise_from_wallets() TO service_role;

-- 7. Schedule the daily recovery run (05:00 UTC / 08:00 EAT)
DO $cron$
BEGIN
  PERFORM cron.unschedule('recover-merchandise-from-wallets');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$cron$;

SELECT cron.schedule(
  'recover-merchandise-from-wallets',
  '0 5 * * *',
  $$ SELECT public.recover_merchandise_from_wallets(); $$
);