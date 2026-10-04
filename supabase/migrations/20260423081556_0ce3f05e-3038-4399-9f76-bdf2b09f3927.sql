CREATE TABLE public.agent_daily_commission_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL,
  report_date DATE NOT NULL,
  total_transactions INTEGER NOT NULL DEFAULT 0,
  total_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT agent_daily_commission_reports_unique UNIQUE (agent_id, report_date)
);

CREATE INDEX idx_agent_daily_commission_reports_date_agent
  ON public.agent_daily_commission_reports (report_date DESC, agent_id);

ALTER TABLE public.agent_daily_commission_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view their own daily commission reports"
ON public.agent_daily_commission_reports
FOR SELECT
USING (auth.uid() = agent_id);

CREATE POLICY "Operations staff can view all daily commission reports"
ON public.agent_daily_commission_reports
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.enabled = true
      AND user_roles.role IN ('manager','cfo','coo','ceo','operations','super_admin')
  )
);

CREATE TRIGGER update_agent_daily_commission_reports_updated_at
BEFORE UPDATE ON public.agent_daily_commission_reports
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.generate_daily_merchant_commission_report(
  p_date DATE DEFAULT (CURRENT_DATE - 1)
)
RETURNS TABLE (agents_processed INTEGER, total_commission NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agents_processed INTEGER := 0;
  v_total_commission NUMERIC := 0;
BEGIN
  WITH upserted AS (
    INSERT INTO public.agent_daily_commission_reports
      (agent_id, report_date, total_transactions, total_value, commission)
    SELECT
      agent_id,
      p_date,
      COUNT(*)::INTEGER,
      COALESCE(SUM(amount), 0),
      ROUND(COALESCE(SUM(amount), 0) * 0.01, 2)
    FROM public.tenant_merchant_payments
    WHERE payment_date = p_date
    GROUP BY agent_id
    ON CONFLICT (agent_id, report_date) DO UPDATE
      SET total_transactions = EXCLUDED.total_transactions,
          total_value        = EXCLUDED.total_value,
          commission         = EXCLUDED.commission,
          updated_at         = now()
    RETURNING agent_id, commission
  )
  SELECT COUNT(*)::INTEGER, COALESCE(SUM(commission), 0)
    INTO v_agents_processed, v_total_commission
  FROM upserted;

  BEGIN
    PERFORM public.log_system_event(
      'daily_merchant_commission_report',
      NULL,
      'agent_daily_commission_reports',
      NULL,
      jsonb_build_object(
        'date', p_date,
        'agents_processed', v_agents_processed,
        'total_commission', v_total_commission
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY SELECT v_agents_processed, v_total_commission;
END;
$$;