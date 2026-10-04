
-- 1) Re-enable agent-impacting cron jobs via cron.alter_job (avoids direct UPDATE on cron.job)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT jobid, jobname FROM cron.job
     WHERE jobname IN ('auto-charge-wallets-daily','daily-credit-charges','retry-no-smartphone-charges-3h')
  LOOP
    PERFORM cron.alter_job(job_id := r.jobid, active := true);
  END LOOP;
END $$;

-- 2) Refactor credit_agent_rent_commission
CREATE OR REPLACE FUNCTION public.credit_agent_rent_commission(
  p_rent_request_id uuid,
  p_repayment_amount numeric,
  p_tenant_id uuid,
  p_event_reference_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_source_agent_id  uuid;
  v_manager_agent_id uuid;
  v_recruiter_id     uuid;
  v_total_commission numeric;
  v_source_amount    numeric;
  v_manager_amount   numeric;
  v_recruiter_amount numeric;
  v_same_agent       boolean;
  v_credited         numeric := 0;
  v_result           jsonb := '[]'::jsonb;
  v_txn_group        uuid;
  v_idem_key         text;
BEGIN
  v_idem_key         := COALESCE(p_event_reference_id, p_rent_request_id::text);
  v_total_commission := round(p_repayment_amount * 0.10);

  SELECT agent_id, assigned_agent_id
    INTO v_source_agent_id, v_manager_agent_id
    FROM rent_requests WHERE id = p_rent_request_id;

  IF v_manager_agent_id IS NULL THEN v_manager_agent_id := v_source_agent_id; END IF;
  IF v_source_agent_id IS NULL AND v_manager_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','no_agents','total_commission',0,'credited_commission',0);
  END IF;

  v_same_agent := (v_source_agent_id = v_manager_agent_id);

  SELECT parent_agent_id INTO v_recruiter_id
    FROM agent_subagents WHERE sub_agent_id = v_manager_agent_id LIMIT 1;

  IF v_same_agent THEN
    IF v_recruiter_id IS NOT NULL AND v_recruiter_id <> v_source_agent_id THEN
      v_manager_amount   := round(p_repayment_amount * 0.08);
      v_recruiter_amount := v_total_commission - v_manager_amount;
      v_source_amount    := 0;
    ELSE
      v_manager_amount   := v_total_commission;
      v_recruiter_amount := 0;
      v_source_amount    := 0;
    END IF;
  ELSE
    v_source_amount := round(p_repayment_amount * 0.02);
    IF v_recruiter_id IS NOT NULL AND v_recruiter_id <> v_source_agent_id AND v_recruiter_id <> v_manager_agent_id THEN
      v_recruiter_amount := round(p_repayment_amount * 0.02);
      v_manager_amount   := v_total_commission - v_source_amount - v_recruiter_amount;
    ELSE
      v_recruiter_amount := 0;
      v_manager_amount   := v_total_commission - v_source_amount;
    END IF;
  END IF;

  IF v_source_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
       WHERE source_id = v_idem_key AND agent_id = v_source_agent_id
         AND commission_role = 'source_agent' AND event_type = 'repayment'
    ) THEN
      v_txn_group := gen_random_uuid();
      PERFORM public.create_ledger_transaction(
        'agent_rent_commission_source',
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_source_agent_id, 'amount', v_source_amount,
            'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'classification','production',
            'description', 'Onboarding commission (2%) on repayment',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text, 'recipient_type', 'user'
          ),
          jsonb_build_object(
            'user_id', v_source_agent_id, 'amount', v_source_amount,
            'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'classification','production',
            'description', 'Marketing expense: Source agent 2% commission',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text
          )
        )
      );
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_source_agent_id, p_tenant_id, v_source_amount, 2, 'repayment', 'source_agent', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Source agent 2% commission');
      v_credited := v_credited + v_source_amount;
      v_result := v_result || jsonb_build_object('source_agent', v_source_agent_id, 'source_amount', v_source_amount);
    END IF;
  END IF;

  IF v_manager_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
       WHERE source_id = v_idem_key AND agent_id = v_manager_agent_id
         AND commission_role = 'tenant_manager' AND event_type = 'repayment'
    ) THEN
      v_txn_group := gen_random_uuid();
      PERFORM public.create_ledger_transaction(
        'agent_rent_commission_manager',
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_manager_agent_id, 'amount', v_manager_amount,
            'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'classification','production',
            'description', 'Manager commission on repayment',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text, 'recipient_type', 'user'
          ),
          jsonb_build_object(
            'user_id', v_manager_agent_id, 'amount', v_manager_amount,
            'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'classification','production',
            'description', 'Marketing expense: Manager agent commission',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text
          )
        )
      );
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_manager_agent_id, p_tenant_id, v_manager_amount, 8, 'repayment', 'tenant_manager', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Manager agent commission');
      v_credited := v_credited + v_manager_amount;
      v_result := v_result || jsonb_build_object('manager_agent', v_manager_agent_id, 'manager_amount', v_manager_amount);
    END IF;
  END IF;

  IF v_recruiter_amount > 0 AND v_recruiter_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
       WHERE source_id = v_idem_key AND agent_id = v_recruiter_id
         AND commission_role = 'recruiter' AND event_type = 'repayment'
    ) THEN
      v_txn_group := gen_random_uuid();
      PERFORM public.create_ledger_transaction(
        'agent_rent_commission_recruiter',
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_recruiter_id, 'amount', v_recruiter_amount,
            'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'classification','production',
            'description', 'Recruiter commission on repayment',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text, 'recipient_type', 'user'
          ),
          jsonb_build_object(
            'user_id', v_recruiter_id, 'amount', v_recruiter_amount,
            'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'classification','production',
            'description', 'Marketing expense: Recruiter agent commission',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text
          )
        )
      );
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_recruiter_id, p_tenant_id, v_recruiter_amount, 2, 'repayment', 'recruiter', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Recruiter agent commission');
      v_credited := v_credited + v_recruiter_amount;
      v_result := v_result || jsonb_build_object('recruiter', v_recruiter_id, 'recruiter_amount', v_recruiter_amount);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_credited > 0 THEN 'credited' ELSE 'already_credited' END,
    'total_commission', v_total_commission,
    'credited_commission', v_credited,
    'splits', v_result
  );
END;
$function$;

-- 3) Cron health diagnostic RPC
CREATE OR REPLACE FUNCTION public.cron_jobs_health()
RETURNS TABLE (
  jobname text,
  schedule text,
  active boolean,
  last_run_at timestamptz,
  last_status text,
  is_stale boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public','cron'
AS $$
  SELECT
    j.jobname,
    j.schedule,
    j.active,
    r.last_run_at,
    r.last_status,
    (NOT j.active) OR (r.last_run_at IS NULL) OR (r.last_run_at < now() - interval '24 hours') AS is_stale
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT jrd.start_time AS last_run_at, jrd.status AS last_status
      FROM cron.job_run_details jrd
     WHERE jrd.jobid = j.jobid
     ORDER BY jrd.start_time DESC
     LIMIT 1
  ) r ON TRUE
  ORDER BY j.jobname;
$$;

GRANT EXECUTE ON FUNCTION public.cron_jobs_health() TO authenticated;
