-- ============================================================
-- Merchandise: 4x/day recovery to company cash, agent notifications,
-- agent self-service storefront (catalog + order RPC)
-- ============================================================

-- 1. Recovered merchandise money goes to the COMPANY "money we have"
--    (platform cash_in) instead of an individual wallet, and the paying
--    agent is notified in-app on every deduction. Runs 4x/day.
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
    -- Per-slot idempotency so the 4 daily runs each recover once.
    v_idem := 'merch_recover_' || v_plan.id::text || '_' || to_char(now(), 'YYYYMMDDHH24');
    v_desc := 'Merchandise Payment – ' || COALESCE(v_plan.item_name, 'Item') || ' (15% Wallet Recovery)';

    BEGIN
      PERFORM public.create_ledger_transaction(
        entries => jsonb_build_array(
          -- Wallet leg: debit the agent's withdrawable wallet (shows in their statement)
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
          -- Company leg: platform cash_in -> increases CFO "money we have"
          jsonb_build_object(
            'user_id', v_plan.customer_id,
            'ledger_scope', 'platform',
            'direction', 'cash_in',
            'amount', v_amount,
            'category', 'debt_recovery',
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
    EXCEPTION WHEN OTHERS THEN
      -- Already recovered this slot (idempotency clash) or a transient failure: skip.
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

    -- In-app notification for the agent (tappable -> wallet / merchandise page)
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      v_plan.customer_id,
      'Merchandise payment deducted',
      'UGX ' || to_char(v_amount, 'FM999,999,999') ||
      ' was deducted from your wallet to pay for ' || COALESCE(v_plan.item_name, 'merchandise') ||
      '. Remaining: UGX ' || to_char(GREATEST(0, v_closing), 'FM999,999,999') || '.',
      'merchandise_recovery',
      jsonb_build_object(
        'kind', 'merchandise_recovery',
        'plan_id', v_plan.id,
        'amount', v_amount,
        'item', v_plan.item_name,
        'remaining', GREATEST(0, v_closing)
      )
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
    'credited_to', 'company_cash',
    'ran_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.recover_merchandise_from_wallets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recover_merchandise_from_wallets() TO service_role;

-- 2. Let merchandise-recovery notifications through the global suppression trigger
CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') = 'merchandise_recovery' THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

-- 3. Reschedule the recovery cron to run 4 times a day (05:00, 11:00, 17:00, 23:00 UTC)
DO $cron$
BEGIN
  PERFORM cron.unschedule('recover-merchandise-from-wallets');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$cron$;

SELECT cron.schedule(
  'recover-merchandise-from-wallets',
  '0 5,11,17,23 * * *',
  $$ SELECT public.recover_merchandise_from_wallets(); $$
);

-- 4. Merchandise storefront catalog (items agents can buy)
CREATE TABLE IF NOT EXISTS public.merchandise_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_name text NOT NULL,
  description text,
  unit_price numeric NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit_cost numeric NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  image_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_catalog TO authenticated;
GRANT ALL ON public.merchandise_catalog TO service_role;

ALTER TABLE public.merchandise_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view active catalog"
ON public.merchandise_catalog FOR SELECT
TO authenticated
USING (
  is_active
  OR has_role(auth.uid(),'cmo') OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'super_admin')
);

CREATE POLICY "Leadership manage catalog"
ON public.merchandise_catalog FOR ALL
TO authenticated
USING (has_role(auth.uid(),'cmo') OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'super_admin'))
WITH CHECK (has_role(auth.uid(),'cmo') OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'super_admin'));

CREATE TRIGGER update_merchandise_catalog_updated_at
BEFORE UPDATE ON public.merchandise_catalog
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_merchandise_catalog_active ON public.merchandise_catalog(is_active);

-- 5. Agent self-service order: records a credit sale against the agent's wallet.
--    The existing AFTER INSERT trigger auto-creates the recovery plan, so the
--    cost is recovered from their wallet and shows up in the CMO merchandise page.
CREATE OR REPLACE FUNCTION public.agent_order_merchandise(p_catalog_id uuid, p_quantity integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_item    record;
  v_total   numeric;
  v_name    text;
  v_phone   text;
  v_sale_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;

  SELECT * INTO v_item
  FROM public.merchandise_catalog
  WHERE id = p_catalog_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This item is not available';
  END IF;

  v_total := v_item.unit_price * p_quantity;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes
  ) VALUES (
    v_item.item_name, p_quantity, v_item.unit_price, COALESCE(v_item.unit_cost, 0), v_total,
    v_name, v_phone, v_uid, 'credit',
    0, v_total, current_date, v_uid, 'Agent self-order via merchandise store'
  ) RETURNING id INTO v_sale_id;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'item', v_item.item_name,
    'quantity', p_quantity,
    'total', v_total
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_order_merchandise(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_order_merchandise(uuid, integer) TO authenticated;