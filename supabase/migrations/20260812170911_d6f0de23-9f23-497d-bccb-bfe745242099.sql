-- Per-merchant measured payout success matrix
CREATE OR REPLACE FUNCTION public.merchant_payout_success_matrix(p_days integer DEFAULT 30)
RETURNS TABLE (
  merchant_id uuid,
  merchant_name text,
  attempts bigint,
  actioned bigint,
  paid bigint,
  pct_paid numeric,
  pct_customer_debited numeric,
  pct_fully_recorded numeric,
  stranded_processing bigint,
  grade text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH w AS (
    SELECT wr.id,
           COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by) AS actor,
           wr.status
    FROM withdrawal_requests wr
    WHERE wr.created_at > now() - make_interval(days => GREATEST(p_days, 1))
      AND COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by)
          IN (SELECT ca.agent_id FROM cashout_agents ca)
  ), m AS (
    SELECT w.*,
      EXISTS (
        SELECT 1 FROM general_ledger g
        WHERE g.source_id = w.id AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
          AND g.category IN ('wallet_withdrawal', 'agent_commission_withdrawal')
      ) AS debit,
      EXISTS (SELECT 1 FROM merchant_payout_funding f WHERE f.withdrawal_id = w.id) AS fund,
      EXISTS (SELECT 1 FROM merchant_commission_awards c WHERE c.withdrawal_id = w.id) AS comm
    FROM w
  ), agg AS (
    SELECT m.actor AS merchant_id,
      COUNT(*) AS attempts,
      COUNT(*) FILTER (WHERE m.status <> 'pending') AS actioned,
      COUNT(*) FILTER (WHERE m.status IN ('paid','completed')) AS paid,
      COUNT(*) FILTER (WHERE m.status IN ('paid','completed') AND m.debit) AS debited,
      COUNT(*) FILTER (WHERE m.status IN ('paid','completed') AND m.debit AND m.fund AND m.comm) AS full_rec,
      COUNT(*) FILTER (WHERE m.status = 'processing') AS stranded
    FROM m GROUP BY m.actor
  )
  SELECT a.merchant_id,
    COALESCE(p.full_name, 'unknown'),
    a.attempts, a.actioned, a.paid,
    ROUND(100.0 * a.paid / GREATEST(a.actioned, 1), 1),
    ROUND(100.0 * a.debited / GREATEST(a.paid, 1), 1),
    ROUND(100.0 * a.full_rec / GREATEST(a.paid, 1), 1),
    a.stranded,
    CASE
      WHEN a.paid = 0 THEN 'no_payouts'
      WHEN a.debited = a.paid AND a.full_rec = a.paid AND a.stranded = 0 THEN 'healthy'
      WHEN a.debited < a.paid THEN 'money_risk'
      WHEN a.stranded > 0 THEN 'stranded_claims'
      ELSE 'recording_gap'
    END
  FROM agg a
  LEFT JOIN profiles p ON p.id = a.merchant_id
  ORDER BY a.attempts DESC;
$$;

-- Fleet-level single percentage
CREATE OR REPLACE FUNCTION public.merchant_payout_success_summary(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH mx AS (SELECT * FROM public.merchant_payout_success_matrix(p_days))
  SELECT jsonb_build_object(
    'window_days', GREATEST(p_days, 1),
    'measured_at', now(),
    'merchants_total', (SELECT count(*) FROM cashout_agents WHERE is_active),
    'merchants_with_attempts', (SELECT count(*) FROM mx WHERE attempts > 0),
    'merchants_healthy', (SELECT count(*) FROM mx WHERE grade = 'healthy'),
    'merchants_money_risk', (SELECT count(*) FROM mx WHERE grade = 'money_risk'),
    'attempts', COALESCE((SELECT sum(attempts) FROM mx), 0),
    'paid', COALESCE((SELECT sum(paid) FROM mx), 0),
    'stranded_processing', COALESCE((SELECT sum(stranded_processing) FROM mx), 0),
    'pct_paid_of_actioned', (
      SELECT ROUND(100.0 * COALESCE(sum(paid),0) / GREATEST(COALESCE(sum(actioned),0), 1), 1) FROM mx
    ),
    'pct_merchants_healthy', (
      SELECT ROUND(100.0 * count(*) FILTER (WHERE grade = 'healthy')
                   / GREATEST(count(*) FILTER (WHERE attempts > 0), 1), 1) FROM mx
    ),
    'missing_legs', (
      SELECT COALESCE(jsonb_object_agg(kind, n), '{}'::jsonb) FROM (
        SELECT CASE WHEN NOT debit THEN 'no_customer_debit'
                    WHEN NOT fund THEN 'no_funding_source'
                    ELSE 'no_commission' END AS kind, count(*) AS n
        FROM (
          SELECT wr.id,
            EXISTS (SELECT 1 FROM general_ledger g WHERE g.source_id = wr.id AND g.ledger_scope='wallet'
                    AND g.direction='cash_out' AND g.category IN ('wallet_withdrawal','agent_commission_withdrawal')) AS debit,
            EXISTS (SELECT 1 FROM merchant_payout_funding f WHERE f.withdrawal_id = wr.id) AS fund,
            EXISTS (SELECT 1 FROM merchant_commission_awards c WHERE c.withdrawal_id = wr.id) AS comm
          FROM withdrawal_requests wr
          WHERE wr.created_at > now() - make_interval(days => GREATEST(p_days, 1))
            AND wr.status IN ('paid','completed')
            AND COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by)
                IN (SELECT ca.agent_id FROM cashout_agents ca)
        ) s WHERE NOT (debit AND fund AND comm) GROUP BY 1
      ) k
    )
  );
$$;

CREATE TABLE IF NOT EXISTS public.merchant_payout_success_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  window_days integer NOT NULL,
  summary jsonb NOT NULL,
  per_merchant jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.merchant_payout_success_runs TO authenticated;
GRANT ALL ON public.merchant_payout_success_runs TO service_role;
ALTER TABLE public.merchant_payout_success_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finance staff read merchant payout success runs" ON public.merchant_payout_success_runs;
CREATE POLICY "finance staff read merchant payout success runs"
ON public.merchant_payout_success_runs FOR SELECT TO authenticated
USING (
  public.has_role((SELECT auth.uid()), 'cfo')
  OR public.has_role((SELECT auth.uid()), 'financial_ops')
  OR public.has_role((SELECT auth.uid()), 'ceo')
  OR public.has_role((SELECT auth.uid()), 'coo')
  OR public.has_role((SELECT auth.uid()), 'manager')
  OR public.has_role((SELECT auth.uid()), 'super_admin')
);

DROP TRIGGER IF EXISTS trg_merchant_payout_success_runs_updated ON public.merchant_payout_success_runs;
CREATE TRIGGER trg_merchant_payout_success_runs_updated
BEFORE UPDATE ON public.merchant_payout_success_runs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.record_merchant_payout_success_run(p_days integer DEFAULT 30)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.merchant_payout_success_runs (window_days, summary, per_merchant)
  SELECT GREATEST(p_days, 1),
         public.merchant_payout_success_summary(p_days),
         COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM public.merchant_payout_success_matrix(p_days) x), '[]'::jsonb)
  RETURNING id INTO v_id;

  DELETE FROM public.merchant_payout_success_runs WHERE created_at < now() - interval '180 days';
  RETURN v_id;
END;
$$;

SELECT cron.unschedule('merchant-payout-success-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'merchant-payout-success-daily');

SELECT cron.schedule(
  'merchant-payout-success-daily',
  '10 3 * * *',
  $cron$SELECT public.record_merchant_payout_success_run(30);$cron$
);