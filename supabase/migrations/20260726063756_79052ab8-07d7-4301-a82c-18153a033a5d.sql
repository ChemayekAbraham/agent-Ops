
-- Auto-recovery "Overdraft" advance
-- When a payout is approved and the user ends up with negative strict withdrawable,
-- we open a zero-interest advance for the shortfall so `sweep_agent_advance_recovery`
-- clears it automatically from future earnings.

CREATE OR REPLACE FUNCTION public.create_overdraft_recovery_advance(
  p_user_id uuid,
  p_shortfall numeric,
  p_withdrawal_id uuid,
  p_actor_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_amount numeric := ceil(GREATEST(p_shortfall, 0));
  v_issuer uuid := COALESCE(p_actor_id, p_user_id);
BEGIN
  IF v_amount < 100 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agent_advances (
    agent_id,
    issued_by,
    principal,
    outstanding_balance,
    cycle_days,
    monthly_rate,
    daily_rate,
    access_fee,
    registration_fee,
    access_fee_collected,
    access_fee_status,
    daily_installment,
    status,
    expires_at
  ) VALUES (
    p_user_id,
    v_issuer,
    v_amount,
    v_amount,
    30,
    0,           -- ZERO interest — this is a strict cost-recovery advance, not credit
    0,
    0,
    0,
    0,
    'unpaid',
    0,           -- no scheduled daily installment; sweep clears it from any earning
    'active',
    now() + interval '365 days'
  )
  RETURNING id INTO v_id;

  -- Best-effort audit trail
  BEGIN
    INSERT INTO public.audit_logs (
      user_id, action_type, table_name, record_id, reason, metadata
    ) VALUES (
      v_issuer,
      'overdraft_recovery_advance_opened',
      'agent_advances',
      v_id,
      'Auto recovery advance opened for withdrawal overdraft',
      jsonb_build_object(
        'user_id', p_user_id,
        'shortfall', v_amount,
        'withdrawal_id', p_withdrawal_id
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_overdraft_recovery_advance(uuid, numeric, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_overdraft_recovery_advance(uuid, numeric, uuid, uuid) TO service_role;
