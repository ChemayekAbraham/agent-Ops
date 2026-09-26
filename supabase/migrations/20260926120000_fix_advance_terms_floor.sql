-- Blocker 1: update_agent_advance_terms silently destroys the registration fee
-- and any capitalised penalty when an advance is re-termed.
--
-- THE DEFECT
-- ----------
-- `outstanding_balance` is set at origination to
--     principal + access_fee + registration_fee
-- and the overdue penalty accrual capitalises into it on top of that. But the
-- re-term computed:
--     v_old_total := principal + access_fee              -- registration fee and
--                                                        -- penalty both missing
--     v_paid      := greatest(0, v_old_total - outstanding_balance)
--
-- For any advance whose balance still exceeds principal + access_fee, that
-- subtraction is negative, `greatest(0, ...)` floors it to zero, and the
-- recomputed balance becomes principal + new_access_fee -- dropping the
-- registration fee and every capitalised penalty in one step.
--
-- MEASURED BEFORE THIS FIX
--   270 of the 323 re-termable advances sit above principal + access_fee,
--   carrying 4,381,650.10 of exposure (2,550,333.10 registration fee +
--   1,831,317 capitalised penalty).
--   It has already fired twice: 17,344 lost on 2026-08-03 (advance 5894bd79)
--   and 20,000 -- exactly one registration fee -- on 2026-08-08 (bbb820d7).
--
-- THE FIX
-- -------
-- Include the registration fee and the capitalised penalty on BOTH sides of
-- the restatement, so they cancel and the identity holds:
--     new_outstanding = outstanding + (new_access_fee - old_access_fee)
-- The floor is retained purely as a defensive bound; with the corrected totals
-- it can no longer be reached by a well-formed row.
--
-- An explicit invariant check is added so that if the identity is ever broken
-- again the transaction aborts instead of quietly shrinking a receivable.
--
-- DELIBERATELY UNCHANGED
-- ----------------------
-- The installment basis stays exactly as it was (principal + new access fee
-- over the new number of installments). Re-basing it on the full payable would
-- change how much is swept from an agent's wallet each period, which is a
-- repayment-behaviour change and is out of scope here. Flagged for a separate
-- decision.
--
-- No GL entry is posted -- forward accounting for terms changes lands with the
-- A11/A20 matrix, not here. No wallet, no ledger, no balance is touched by
-- this migration itself; it only changes how a FUTURE re-term computes.

CREATE OR REPLACE FUNCTION public.update_agent_advance_terms(
  p_advance_id uuid,
  p_monthly_rate numeric,
  p_cycle_days integer,
  p_repayment_frequency text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_adv public.agent_advances%ROWTYPE;
  v_penalty numeric;
  v_old_total numeric;
  v_paid numeric;
  v_new_access_fee numeric;
  v_new_total numeric;
  v_new_outstanding numeric;
  v_expected_outstanding numeric;
  v_schedule_total numeric;
  v_period integer;
  v_installments integer;
  v_installment numeric;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  ) THEN
    RAISE EXCEPTION 'Only the CFO or Agent Ops may edit advance terms';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;
  IF p_monthly_rate IS NULL OR p_monthly_rate < 0 OR p_monthly_rate > 1 THEN
    RAISE EXCEPTION 'Rate must be between 0%% and 100%% per month';
  END IF;
  IF p_cycle_days IS NULL OR p_cycle_days < 1 OR p_cycle_days > 365 THEN
    RAISE EXCEPTION 'Term must be between 1 and 365 days';
  END IF;
  IF lower(coalesce(p_repayment_frequency,'daily')) NOT IN ('daily','weekly','biweekly','monthly') THEN
    RAISE EXCEPTION 'Invalid repayment frequency';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found'; END IF;
  IF v_adv.status NOT IN ('active','overdue') THEN
    RAISE EXCEPTION 'Only active or overdue advances can be re-termed';
  END IF;

  -- Penalty already capitalised into outstanding_balance by the overdue
  -- accrual. The subledger is the only place it is separable.
  SELECT COALESCE(SUM(interest_accrued), 0) INTO v_penalty
  FROM public.agent_advance_ledger
  WHERE advance_id = p_advance_id;

  -- Gross payable as the balance actually reflects it: principal + access fee
  -- + registration fee + capitalised penalty.
  v_old_total := COALESCE(v_adv.principal,0)
               + COALESCE(v_adv.access_fee,0)
               + COALESCE(v_adv.registration_fee,0)
               + v_penalty;

  v_paid := GREATEST(0, v_old_total - COALESCE(v_adv.outstanding_balance,0));

  v_new_access_fee := round(
    COALESCE(v_adv.principal,0) * (power(1 + p_monthly_rate, p_cycle_days::numeric / 30) - 1)
  );

  v_new_total := COALESCE(v_adv.principal,0)
               + v_new_access_fee
               + COALESCE(v_adv.registration_fee,0)
               + v_penalty;

  v_new_outstanding := GREATEST(0, v_new_total - v_paid);

  -- Invariant: a re-term only ever moves the balance by the change in the
  -- access fee. Anything else means a component was dropped.
  v_expected_outstanding := GREATEST(0,
    COALESCE(v_adv.outstanding_balance,0)
    + (v_new_access_fee - COALESCE(v_adv.access_fee,0))
  );
  IF abs(v_new_outstanding - v_expected_outstanding) > 0.5 THEN
    RAISE EXCEPTION
      'ADVANCE_TERMS_BALANCE_DRIFT: advance % would move from % to % but only the access fee changed (% -> %); expected %',
      p_advance_id, v_adv.outstanding_balance, v_new_outstanding,
      v_adv.access_fee, v_new_access_fee, v_expected_outstanding;
  END IF;

  -- Installment basis unchanged from the previous version on purpose: the
  -- schedule still amortises principal + access fee, not the full payable.
  v_schedule_total := COALESCE(v_adv.principal,0) + v_new_access_fee;
  v_period := public.advance_period_days(p_repayment_frequency);
  v_installments := greatest(1, ceil(p_cycle_days::numeric / v_period));
  v_installment := ceil(v_schedule_total / v_installments);

  UPDATE public.agent_advances
  SET monthly_rate = p_monthly_rate,
      daily_rate = p_monthly_rate,
      cycle_days = p_cycle_days,
      repayment_frequency = lower(p_repayment_frequency),
      access_fee = v_new_access_fee,
      installment_amount = v_installment,
      outstanding_balance = v_new_outstanding,
      expires_at = coalesce(v_adv.issued_at, now()) + (p_cycle_days || ' days')::interval,
      status = CASE WHEN v_new_outstanding <= 0 THEN 'completed' ELSE v_adv.status END,
      updated_at = now()
  WHERE id = p_advance_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (auth.uid(), 'advance_terms_edited', 'agent_advances', p_advance_id, jsonb_build_object(
    'reason', trim(p_reason),
    'old', jsonb_build_object('monthly_rate', v_adv.monthly_rate, 'cycle_days', v_adv.cycle_days,
                              'repayment_frequency', v_adv.repayment_frequency, 'access_fee', v_adv.access_fee,
                              'outstanding_balance', v_adv.outstanding_balance),
    'new', jsonb_build_object('monthly_rate', p_monthly_rate, 'cycle_days', p_cycle_days,
                              'repayment_frequency', lower(p_repayment_frequency), 'access_fee', v_new_access_fee,
                              'outstanding_balance', v_new_outstanding, 'installment_amount', v_installment),
    -- Components carried through the restatement, so a reviewer can see that
    -- nothing was dropped.
    'preserved', jsonb_build_object('registration_fee', COALESCE(v_adv.registration_fee,0),
                                    'capitalised_penalty', v_penalty,
                                    'paid_to_date', v_paid,
                                    'old_total_payable', v_old_total,
                                    'new_total_payable', v_new_total)
  ));

  RETURN jsonb_build_object(
    'advance_id', p_advance_id,
    'access_fee', v_new_access_fee,
    'total_payable', v_new_total,
    'outstanding_balance', v_new_outstanding,
    'installment_amount', v_installment,
    'installments', v_installments,
    'registration_fee_preserved', COALESCE(v_adv.registration_fee,0),
    'capitalised_penalty_preserved', v_penalty
  );
END;
$function$;
