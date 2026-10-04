CREATE OR REPLACE FUNCTION public.recover_merchandise_from_wallets()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
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
    v_desc := 'Merchandise Payment - ' || COALESCE(v_plan.item_name, 'Item') || ' (15% Wallet Recovery)';

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
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'merchandise recovery failed for plan %: % (%)', v_plan.id, SQLERRM, SQLSTATE;
      v_failures := v_failures + 1;
      v_last_error := SQLERRM;
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
    'failures', v_failures,
    'last_error', v_last_error,
    'ran_at', now()
  );
END;
$fn$;