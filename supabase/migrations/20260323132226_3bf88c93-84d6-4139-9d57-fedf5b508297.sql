
-- Add missing columns to cashout_agents
ALTER TABLE public.cashout_agents 
  ADD COLUMN IF NOT EXISTS max_daily_payouts int DEFAULT 50,
  ADD COLUMN IF NOT EXISTS current_queue_count int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS handles_mtn boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS handles_airtel boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS priority_threshold numeric DEFAULT 500000;

-- Add missing columns to deposit_requests
ALTER TABLE public.deposit_requests 
  ADD COLUMN IF NOT EXISTS audit_flagged boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_approved boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS batch_run_id uuid;

-- Add missing columns to withdrawal_requests
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS priority_level text DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS auto_dispatched boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

-- Now create the function with correct columns
CREATE OR REPLACE FUNCTION public.get_agent_workload_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(row_to_json(agents)), '[]'::jsonb)
  FROM (
    SELECT 
      ca.agent_id,
      p.full_name as agent_name,
      p.phone as agent_phone,
      ca.is_active,
      ca.handles_cash,
      ca.handles_bank,
      ca.handles_mtn,
      ca.handles_airtel,
      ca.max_daily_payouts,
      ca.current_queue_count,
      (SELECT count(*) FROM withdrawal_requests wr WHERE wr.assigned_cashout_agent_id = ca.agent_id AND wr.status IN ('cfo_approved', 'manager_approved')) as pending_payouts,
      (SELECT count(*) FROM payout_codes pc WHERE pc.paid_by = ca.agent_id AND pc.paid_at >= CURRENT_DATE) as completed_today,
      (SELECT coalesce(sum(pc.amount), 0) FROM payout_codes pc WHERE pc.paid_by = ca.agent_id AND pc.paid_at >= CURRENT_DATE) as amount_paid_today
    FROM cashout_agents ca
    JOIN profiles p ON p.id = ca.agent_id
    WHERE ca.is_active = true
    ORDER BY ca.current_queue_count DESC
  ) agents;
$$;

-- Fix auto-dispatch function with correct column references
CREATE OR REPLACE FUNCTION public.auto_dispatch_withdrawals(p_batch_size int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_dispatched int := 0;
  v_rec RECORD;
  v_agent_id uuid;
BEGIN
  INSERT INTO batch_processing_runs (run_type) VALUES ('auto_dispatch_withdrawals') RETURNING id INTO v_run_id;

  FOR v_rec IN
    SELECT wr.id, wr.amount, wr.payout_method, wr.mobile_money_provider
    FROM withdrawal_requests wr
    WHERE wr.status = 'cfo_approved'
      AND wr.assigned_cashout_agent_id IS NULL
      AND wr.auto_dispatched = false
    ORDER BY
      CASE WHEN wr.amount >= 500000 THEN 0 ELSE 1 END,
      wr.created_at ASC
    LIMIT p_batch_size
  LOOP
    UPDATE withdrawal_requests SET priority_level = 
      CASE WHEN v_rec.amount >= 500000 THEN 'vip'
           WHEN v_rec.amount >= 100000 THEN 'high'
           ELSE 'standard' END
    WHERE id = v_rec.id;

    SELECT ca.agent_id INTO v_agent_id
    FROM cashout_agents ca
    WHERE ca.is_active = true
      AND ca.current_queue_count < ca.max_daily_payouts
      AND (
        (v_rec.payout_method = 'cash' AND ca.handles_cash = true) OR
        (v_rec.payout_method = 'bank_transfer' AND ca.handles_bank = true) OR
        (v_rec.payout_method = 'mobile_money' AND (
          (lower(v_rec.mobile_money_provider) LIKE '%mtn%' AND ca.handles_mtn = true) OR
          (lower(v_rec.mobile_money_provider) LIKE '%airtel%' AND ca.handles_airtel = true)
        ))
      )
    ORDER BY ca.current_queue_count ASC
    LIMIT 1;

    IF v_agent_id IS NOT NULL THEN
      UPDATE withdrawal_requests 
      SET assigned_cashout_agent_id = v_agent_id,
          auto_dispatched = true,
          dispatched_at = now()
      WHERE id = v_rec.id;

      UPDATE cashout_agents 
      SET current_queue_count = current_queue_count + 1
      WHERE agent_id = v_agent_id;

      v_dispatched := v_dispatched + 1;
    END IF;
  END LOOP;

  UPDATE batch_processing_runs 
  SET completed_at = now(), records_processed = v_dispatched, records_dispatched = v_dispatched
  WHERE id = v_run_id;

  RETURN jsonb_build_object('run_id', v_run_id, 'dispatched', v_dispatched);
END;
$$;
