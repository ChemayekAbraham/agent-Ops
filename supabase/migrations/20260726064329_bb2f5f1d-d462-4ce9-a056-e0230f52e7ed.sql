
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
  v_principal numeric := ceil(GREATEST(p_shortfall, 0));
  v_rate numeric := 0.33;
  v_fee numeric;
  v_outstanding numeric;
  v_issuer uuid := COALESCE(p_actor_id, p_user_id);
BEGIN
  IF v_principal < 100 THEN
    RETURN NULL;
  END IF;

  v_fee := ceil(v_principal * v_rate);
  v_outstanding := v_principal + v_fee;

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
    v_principal,
    v_outstanding,
    30,
    v_rate,
    v_rate / 30,
    v_fee,
    0,
    0,
    'unpaid',
    0,
    'active',
    now() + interval '365 days'
  )
  RETURNING id INTO v_id;

  BEGIN
    INSERT INTO public.audit_logs (
      user_id, action_type, table_name, record_id, reason, metadata
    ) VALUES (
      v_issuer,
      'overdraft_recovery_advance_opened',
      'agent_advances',
      v_id,
      'Overdraft auto-recovery advance (33% platform fee)',
      jsonb_build_object(
        'user_id', p_user_id,
        'principal', v_principal,
        'fee', v_fee,
        'outstanding', v_outstanding,
        'rate', v_rate,
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
