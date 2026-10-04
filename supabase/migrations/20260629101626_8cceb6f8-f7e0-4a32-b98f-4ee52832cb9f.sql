-- 1. Add CFO-adjustable daily recovery rate to advance config
ALTER TABLE public.advance_fee_config
  ADD COLUMN IF NOT EXISTS daily_recovery_rate numeric NOT NULL DEFAULT 0.10;

-- Bounds guard via trigger (CHECK avoided per validation-trigger guidance not needed here, but simple range is immutable so a CHECK is fine)
ALTER TABLE public.advance_fee_config
  DROP CONSTRAINT IF EXISTS advance_fee_config_daily_recovery_rate_range;
ALTER TABLE public.advance_fee_config
  ADD CONSTRAINT advance_fee_config_daily_recovery_rate_range
  CHECK (daily_recovery_rate > 0 AND daily_recovery_rate <= 1);

-- 2. Rewrite the recovery sweep to take only a configured percentage of the
--    agent's available withdrawable commission (default 10%), once per day.
CREATE OR REPLACE FUNCTION public.sweep_agent_advance_recovery()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent           record;
  v_adv             record;
  v_avail           numeric;
  v_cap             numeric;
  v_remaining_cap   numeric;
  v_deduct          numeric;
  v_closing         numeric;
  v_total_payable   numeric;
  v_total_deducted  numeric;
  v_fee_ratio       numeric;
  v_new_fee         numeric;
  v_fee_status      text;
  v_new_status      text;
  v_rate            numeric;
  v_recovered_total numeric := 0;
  v_agents_touched  int := 0;
  v_idem            text;
BEGIN
  -- CFO-adjustable recovery percentage (fraction). Default 10%.
  v_rate := COALESCE((SELECT daily_recovery_rate FROM public.advance_fee_config LIMIT 1), 0.10);
  IF v_rate <= 0 OR v_rate > 1 THEN
    v_rate := 0.10;
  END IF;

  FOR v_agent IN
    SELECT DISTINCT agent_id
    FROM public.agent_advances
    WHERE status IN ('active','overdue') AND outstanding_balance > 0
  LOOP
    -- STRICT: withdrawable-only figure (already pending-hold adjusted).
    -- Never read wallets.balance; float / commission custody is untouchable.
    v_avail := COALESCE(public.get_user_available_balance(v_agent.agent_id), 0);
    IF v_avail <= 0 THEN CONTINUE; END IF;

    -- Only recover a percentage of the available commission per daily run.
    v_cap := round(v_avail * v_rate);
    IF v_cap <= 0 THEN CONTINUE; END IF;
    v_remaining_cap := v_cap;

    FOR v_adv IN
      SELECT *
      FROM public.agent_advances
      WHERE agent_id = v_agent.agent_id
        AND status IN ('active','overdue')
        AND outstanding_balance > 0
      ORDER BY issued_at ASC   -- oldest debt first (FIFO)
    LOOP
      EXIT WHEN v_remaining_cap <= 0;

      v_deduct := LEAST(v_remaining_cap, v_adv.outstanding_balance);
      IF v_deduct <= 0 THEN CONTINUE; END IF;

      v_idem := 'adv_recover_' || v_adv.id::text || '_'
                || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;

      -- Balanced double-entry recovery with explicit Wallet Routing v2 tags:
      -- wallet leg -> recipient_type='user' (withdrawable bucket);
      -- platform leg -> recipient_type='operational_wallet'.
      PERFORM public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', v_agent.agent_id,
            'ledger_scope', 'wallet',
            'direction', 'cash_out',
            'amount', v_deduct,
            'category', 'agent_repayment',
            'recipient_type', 'user',
            'source_table', 'agent_advances',
            'source_id', v_adv.id,
            'description', 'Automatic advance recovery from withdrawable balance',
            'currency', 'UGX',
            'metadata', jsonb_build_object(
              'source', 'auto_withdrawable_sweep',
              'advance_id', v_adv.id,
              'recovery_rate', v_rate,
              'bucket_intent', 'advance_balance_recovery'
            )
          ),
          jsonb_build_object(
            'user_id', v_agent.agent_id,
            'ledger_scope', 'platform',
            'direction', 'cash_in',
            'amount', v_deduct,
            'category', 'agent_repayment',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances',
            'source_id', v_adv.id,
            'description', 'Advance repayment received from agent (auto-sweep)',
            'currency', 'UGX',
            'metadata', jsonb_build_object(
              'source', 'auto_withdrawable_sweep',
              'advance_id', v_adv.id,
              'recovery_rate', v_rate,
              'bucket_intent', 'advance_balance_recovery'
            )
          )
        ),
        idempotency_key => v_idem
      );

      v_closing := v_adv.outstanding_balance - v_deduct;
      v_new_status := CASE
        WHEN v_closing <= 0 THEN 'completed'
        WHEN v_adv.expires_at < now() THEN 'overdue'
        ELSE 'active'
      END;

      v_total_payable  := COALESCE(v_adv.principal, 0) + COALESCE(v_adv.access_fee, 0);
      v_total_deducted := v_total_payable - GREATEST(0, v_closing);
      v_fee_ratio := CASE WHEN v_total_payable > 0
                          THEN LEAST(1, v_total_deducted / v_total_payable)
                          ELSE 0 END;
      v_new_fee := round(COALESCE(v_adv.access_fee, 0) * v_fee_ratio);
      v_fee_status := CASE
        WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
        WHEN v_new_fee > 0 THEN 'partial'
        ELSE 'unpaid'
      END;

      UPDATE public.agent_advances
      SET outstanding_balance  = GREATEST(0, v_closing),
          status               = v_new_status,
          access_fee_collected = v_new_fee,
          access_fee_status    = v_fee_status,
          updated_at           = now()
      WHERE id = v_adv.id;

      INSERT INTO public.agent_advance_ledger
        (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
      VALUES
        (v_adv.id, current_date, v_adv.outstanding_balance, 0, v_deduct, GREATEST(0, v_closing),
         CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

      v_remaining_cap   := v_remaining_cap - v_deduct;
      v_recovered_total := v_recovered_total + v_deduct;
    END LOOP;

    v_agents_touched := v_agents_touched + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'agents_touched', v_agents_touched,
    'recovered_total', v_recovered_total,
    'recovery_rate', v_rate,
    'ran_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_agent_advance_recovery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sweep_agent_advance_recovery() TO service_role;

-- 3. Reschedule the sweep from every 15 minutes to once daily at 04:00 UTC (07:00 EAT).
DO $cron$
BEGIN
  PERFORM cron.unschedule('sweep-agent-advance-recovery');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$cron$;

SELECT cron.schedule(
  'sweep-agent-advance-recovery',
  '0 4 * * *',
  $$ SELECT public.sweep_agent_advance_recovery(); $$
);