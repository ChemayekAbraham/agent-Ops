-- 1. Payment plan flag on sales
ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS payment_plan text NOT NULL DEFAULT 'full';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'merchandise_sales_payment_plan_check'
  ) THEN
    ALTER TABLE public.merchandise_sales
      ADD CONSTRAINT merchandise_sales_payment_plan_check
      CHECK (payment_plan IN ('full','installment'));
  END IF;
END $$;

-- 2. Recovery plan trigger: installment orders recover at 40%
CREATE OR REPLACE FUNCTION public.create_merchandise_recovery_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_customer uuid;
  v_name text;
  v_rate numeric;
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

  IF v_customer IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  v_rate := CASE WHEN COALESCE(NEW.payment_plan, 'full') = 'installment' THEN 0.40 ELSE 0.15 END;

  INSERT INTO public.merchandise_recovery_plans (
    sale_id, customer_id, customer_name, customer_phone, item_name,
    original_amount, outstanding_balance, daily_rate, created_by
  ) VALUES (
    NEW.id, v_customer, COALESCE(v_name, NEW.client_name), NEW.client_phone, NEW.item_name,
    NEW.amount_outstanding, NEW.amount_outstanding, v_rate, NEW.created_by
  );

  RETURN NEW;
END;
$function$;

-- 3. Purchase RPC with payment mode
DROP FUNCTION IF EXISTS public.agent_purchase_merchandise(uuid, integer);

CREATE OR REPLACE FUNCTION public.agent_purchase_merchandise(
  p_catalog_id uuid,
  p_quantity integer,
  p_payment_mode text DEFAULT 'full'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_item     record;
  v_total    numeric;
  v_avail    numeric;
  v_name     text;
  v_phone    text;
  v_sale_id  uuid;
  v_mode     text := lower(COALESCE(p_payment_mode, 'full'));
  v_down     numeric;
  v_out      numeric;
  v_status   text;
  v_dupe     uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF v_mode NOT IN ('full','installment') THEN
    RAISE EXCEPTION 'Invalid payment mode';
  END IF;

  SELECT * INTO v_item
  FROM public.merchandise_catalog
  WHERE id = p_catalog_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This item is not available';
  END IF;

  v_total := COALESCE(v_item.unit_price, 0) * p_quantity;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Invalid order total';
  END IF;

  -- Duplicate guard: same item + quantity within 5 minutes
  SELECT id INTO v_dupe
  FROM public.merchandise_sales
  WHERE customer_id = v_uid
    AND item_name = v_item.item_name
    AND quantity = p_quantity
    AND created_at > now() - interval '5 minutes'
    AND COALESCE(order_status, 'submitted') NOT IN ('rejected','failed')
  LIMIT 1;
  IF v_dupe IS NOT NULL THEN
    RAISE EXCEPTION 'You already placed this exact order moments ago. Check your orders before trying again.';
  END IF;

  v_avail := COALESCE(public.get_user_available_balance(v_uid), 0);

  IF v_mode = 'full' THEN
    IF v_avail < v_total THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Your wallet has UGX % but this order needs UGX %', v_avail, v_total
        USING ERRCODE = 'P0001';
    END IF;
    v_down := v_total;
  ELSE
    -- Installment: first payment is 40% of the available wallet, capped at the price
    v_down := LEAST(v_total, GREATEST(round(v_avail * 0.40), 0));
    IF v_down <= 0 THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Your wallet has UGX % — you need a wallet balance to start an installment plan', v_avail
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_out := v_total - v_down;
  v_status := CASE WHEN v_out <= 0 THEN 'paid' ELSE 'partial' END;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes,
    order_status, payment_plan
  ) VALUES (
    v_item.item_name, p_quantity, v_item.unit_price, COALESCE(v_item.unit_cost, 0), v_total,
    v_name, v_phone, v_uid, v_status,
    v_down, v_out, current_date, v_uid,
    CASE WHEN v_mode = 'installment'
      THEN 'Agent store - installment plan (40% wallet recovery)'
      ELSE 'Agent store - instant wallet debit' END,
    'processing', v_mode
  ) RETURNING id INTO v_sale_id;

  IF v_down > 0 THEN
    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', v_uid,
          'ledger_scope', 'wallet',
          'direction', 'cash_out',
          'amount', v_down,
          'category', 'wallet_deduction',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', v_sale_id,
          'description', CASE WHEN v_mode = 'installment'
            THEN 'Merchandise Installment (40%) - ' || v_item.item_name
            ELSE 'Merchandise Purchase - ' || v_item.item_name END,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', CASE WHEN v_mode = 'installment' THEN 'merchandise_installment_downpayment' ELSE 'merchandise_instant_purchase' END,
            'sale_id', v_sale_id,
            'catalog_id', v_item.id,
            'quantity', p_quantity,
            'payment_plan', v_mode,
            'order_total', v_total
          )
        ),
        jsonb_build_object(
          'user_id', v_uid,
          'ledger_scope', 'platform',
          'direction', 'cash_in',
          'amount', v_down,
          'category', 'debt_recovery',
          'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_sales',
          'source_id', v_sale_id,
          'description', 'Merchandise Sale - ' || v_item.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', CASE WHEN v_mode = 'installment' THEN 'merchandise_installment_downpayment' ELSE 'merchandise_instant_purchase' END,
            'sale_id', v_sale_id,
            'catalog_id', v_item.id,
            'quantity', p_quantity,
            'payment_plan', v_mode,
            'order_total', v_total
          )
        )
      ),
      idempotency_key => 'merch_purchase_' || v_sale_id::text,
      skip_balance_check => false
    );
  END IF;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'item', v_item.item_name,
    'quantity', p_quantity,
    'total', v_total,
    'payment_plan', v_mode,
    'paid_now', v_down,
    'outstanding', v_out
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_purchase_merchandise(uuid, integer, text) TO authenticated;

-- 4. Recovery statement wording reflects the plan's actual rate
CREATE OR REPLACE FUNCTION public.recover_merchandise_from_wallets()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_failures        int := 0;
  v_last_error      text;
BEGIN
  FOR v_plan IN
    SELECT * FROM public.merchandise_recovery_plans
    WHERE status = 'active' AND outstanding_balance > 0
    ORDER BY created_at ASC
  LOOP
    v_avail := COALESCE(public.get_user_available_balance(v_plan.customer_id), 0);
    IF v_avail <= 0 THEN CONTINUE; END IF;

    v_amount := LEAST(
      v_plan.outstanding_balance,
      v_avail,
      GREATEST(round(v_avail * v_plan.daily_rate), 1)
    );
    IF v_amount <= 0 THEN CONTINUE; END IF;

    v_ref  := gen_random_uuid();
    v_idem := 'merch_recover_' || v_plan.id::text || '_' || to_char(now(), 'YYYYMMDDHH24');
    v_desc := 'Merchandise Payment - ' || COALESCE(v_plan.item_name, 'Item')
              || ' (' || to_char(round(v_plan.daily_rate * 100), 'FM999') || '% Wallet Recovery)';

    BEGIN
      PERFORM public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', v_plan.customer_id,
            'ledger_scope', 'wallet',
            'direction', 'cash_out',
            'amount', v_amount,
            'category', 'agent_repayment',
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
            'category', 'agent_repayment',
            'recipient_type', 'operational_wallet',
            'source_table', 'merchandise_recovery_plans',
            'source_id', v_plan.id,
            'description', 'Merchandise cost recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Item'),
            'currency', 'UGX',
            'metadata', jsonb_build_object(
              'source', 'merchandise_daily_recovery',
              'plan_id', v_plan.id,
              'sale_id', v_plan.sale_id,
              'from_customer', v_plan.customer_id,
              'item_name', v_plan.item_name
            )
          )
        ),
        idempotency_key => v_idem
      );

      v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);

      INSERT INTO public.merchandise_recovery_deductions (
        plan_id, sale_id, customer_id, item_name, amount, outstanding_before, outstanding_after, ledger_reference
      ) VALUES (
        v_plan.id, v_plan.sale_id, v_plan.customer_id, v_plan.item_name,
        v_amount, v_plan.outstanding_balance, v_closing, v_ref
      );

      UPDATE public.merchandise_recovery_plans
      SET outstanding_balance = v_closing,
          amount_recovered = amount_recovered + v_amount,
          last_recovery_at = now(),
          status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
          completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END,
          updated_at = now()
      WHERE id = v_plan.id;

      IF v_plan.sale_id IS NOT NULL THEN
        UPDATE public.merchandise_sales
        SET amount_paid = LEAST(total_revenue, amount_paid + v_amount),
            amount_outstanding = v_closing,
            payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END,
            updated_at = now()
        WHERE id = v_plan.sale_id;
      END IF;

      BEGIN
        INSERT INTO public.notifications (user_id, title, message, type, metadata)
        VALUES (
          v_plan.customer_id,
          'Merchandise payment received',
          'UGX ' || to_char(v_amount, 'FM999,999,999') || ' was applied to your '
            || COALESCE(v_plan.item_name, 'merchandise') || ' balance. Remaining: UGX '
            || to_char(v_closing, 'FM999,999,999') || '.',
          'merchandise_recovery',
          jsonb_build_object('kind', 'merchandise_recovery', 'plan_id', v_plan.id, 'amount', v_amount, 'outstanding', v_closing)
        );
      EXCEPTION WHEN OTHERS THEN NULL;
      END;

      v_plans_touched := v_plans_touched + 1;
      v_recovered_total := v_recovered_total + v_amount;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures + 1;
      v_last_error := SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'plans_touched', v_plans_touched,
    'recovered_total', v_recovered_total,
    'failures', v_failures,
    'last_error', v_last_error
  );
END;
$function$;