-- Agent Advance waterfall, Stages D and E (path 1 of 7):
-- record_advance_deduction_atomic -- the 6-hourly cron deduction path.
--
-- NOT YET APPLIED as part of this package.
--
-- Stage D and Stage E both land in this one function, so they cannot be split
-- across migrations: a CREATE OR REPLACE replaces the whole body.
--
-- STAGE D -- Late Fee accrual, post-effective advances only
--   DR A10  agent_advance_penalty_accrued
--   CR L8   agent_advance_penalty_unearned
-- No wallet leg and no `interest_expense`. An accrued Late Fee is a
-- receivable, not an expense, and is not income until collected.
-- Pre-effective advances keep the existing wallet `agent_advance_credit`
-- (bucket advance_credit) + platform `interest_expense` pair, byte for byte.
-- A separate idempotency key ('advance_late_fee:') keeps the two regimes from
-- colliding on the same advance and date.
--
-- STAGE E -- repayment allocation
-- The wallet funding leg is built ONCE and used by both branches, so it is
-- identical in the old and new regime: one leg, for exactly p_amount_deducted.
-- The waterfall changes only how the platform side is split, never how much
-- leaves the wallet. When the helper returns NULL -- every one of the existing
-- 327 advances -- the function posts the single A10 credit exactly as before.
--
-- VERIFIED ROLLED-BACK AGAINST LIVE DATA before this file was written
--   accrual, post-effective   platform/agent_advance_penalty_accrued/cash_out
--                           + platform/agent_advance_penalty_unearned/cash_in
--                           0 wallet legs, 0 X1 legs, late fee == L8
--   accrual, pre-effective    unchanged: wallet/agent_advance_credit/advance_credit
--                           + platform/interest_expense
--   repayment 50,000 on-time  1 wallet leg = 50,000; access fee 50,000 -> A11
--   repayment 25,000 late     1 wallet leg = 25,000; late fee 25,000 ->
--                             A10 CR + L8 DR + R3 CR
--   repayment 15,000 boundary 1 wallet leg = 15,000; late fee tier exhausted
--   final state  late 0 / access 22,000 / reg 20,000 / principal 480,000
--                sum 522,000 == outstanding_balance 522,000
--                L8 0 == remaining late fee; R3 income 40,000 == late fee collected
--
-- Production body before this change: 145861c39bd38e81a287b136c4ac6922 (78 lines).

CREATE OR REPLACE FUNCTION public.record_advance_deduction_atomic(p_advance_id uuid, p_agent_id uuid, p_date date, p_opening_balance numeric, p_interest_accrued numeric, p_amount_deducted numeric, p_closing_balance numeric, p_deduction_status text, p_new_status text, p_new_fee_collected numeric, p_fee_status text, p_new_arrears numeric, p_penalty_description text DEFAULT NULL::text, p_penalty_meta jsonb DEFAULT '{}'::jsonb, p_repayment_description text DEFAULT NULL::text, p_repayment_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_penalty_group   uuid;
  v_repayment_group uuid;
  v_alloc           jsonb;
  v_funding         jsonb;
BEGIN
  IF p_advance_id IS NULL OR p_agent_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'record_advance_deduction_atomic: advance, agent and date are required';
  END IF;

  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status)
  VALUES
    (p_advance_id, p_date, p_opening_balance, p_interest_accrued, p_amount_deducted,
     p_closing_balance, p_deduction_status);

  UPDATE public.agent_advances
  SET outstanding_balance  = GREATEST(0, p_closing_balance),
      status               = p_new_status,
      access_fee_collected = p_new_fee_collected,
      access_fee_status    = p_fee_status,
      arrears_balance      = p_new_arrears,
      updated_at           = now()
  WHERE id = p_advance_id;

  IF COALESCE(p_interest_accrued, 0) > 0 THEN
    IF public.agent_advance_is_post_effective(p_advance_id) THEN
      v_penalty_group := public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
            'amount', p_interest_accrued, 'category', 'agent_advance_penalty_accrued',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Late Fee accrued and capitalised into the advance',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          ),
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', p_interest_accrued, 'category', 'agent_advance_penalty_unearned',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Unearned Late Fee income held until collected',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          )
        ),
        idempotency_key => 'advance_late_fee:' || p_advance_id::text || ':' || p_date::text
      );
    ELSE
      v_penalty_group := public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
            'amount', p_interest_accrued, 'category', 'agent_advance_credit',
            'recipient_type', 'user', 'wallet_bucket', 'advance_credit',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', p_penalty_description,
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          ),
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
            'amount', p_interest_accrued, 'category', 'interest_expense',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Overdue advance penalty interest accrued (receivable)',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          )
        ),
        idempotency_key => 'advance_penalty_interest:' || p_advance_id::text || ':' || p_date::text
      );
    END IF;
  END IF;

  IF COALESCE(p_amount_deducted, 0) > 0 THEN
    v_funding := jsonb_build_array(
      jsonb_build_object(
        'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
        'amount', p_amount_deducted, 'category', 'agent_repayment',
        'recipient_type', 'user',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', p_repayment_description,
        'currency', 'UGX', 'transaction_date', p_date,
        'metadata', p_repayment_meta
      ));

    v_alloc := public.agent_advance_allocation_entries(
                 p_advance_id, p_agent_id, p_amount_deducted, p_date::timestamptz, false);

    IF v_alloc IS NULL THEN
      v_repayment_group := public.create_ledger_transaction(
        entries => v_funding || jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', p_amount_deducted, 'category', 'agent_repayment',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Advance repayment received from agent',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_repayment_meta
          ))
      );
    ELSE
      v_repayment_group := public.create_ledger_transaction(entries => v_funding || v_alloc);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'advance_id', p_advance_id,
    'amount_deducted', p_amount_deducted,
    'interest_accrued', p_interest_accrued,
    'closing_balance', GREATEST(0, p_closing_balance),
    'penalty_group_id', v_penalty_group,
    'repayment_group_id', v_repayment_group
  );
END;
$function$;
