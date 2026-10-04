CREATE TABLE IF NOT EXISTS public.merchant_float_morning_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  report_date date NOT NULL,
  generated_at timestamp with time zone NOT NULL DEFAULT now(),
  pdf_path text,
  emailed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT merchant_float_morning_reports_report_date_key UNIQUE (report_date)
);

GRANT SELECT ON public.merchant_float_morning_reports TO authenticated;
GRANT ALL ON public.merchant_float_morning_reports TO service_role;

ALTER TABLE public.merchant_float_morning_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance roles can view merchant float morning reports"
ON public.merchant_float_morning_reports
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
);

CREATE OR REPLACE FUNCTION public.touch_merchant_float_morning_reports()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_merchant_float_morning_reports ON public.merchant_float_morning_reports;
CREATE TRIGGER trg_touch_merchant_float_morning_reports
BEFORE UPDATE ON public.merchant_float_morning_reports
FOR EACH ROW EXECUTE FUNCTION public.touch_merchant_float_morning_reports();

-- Bulk (all active merchant desks) float position reader. Sources float exactly
-- like get_merchant_float_positions(): cashout_agents desks + wallets.float_balance,
-- with wallet_balances_projection raw net for overdraw visibility. Read-only.
CREATE OR REPLACE FUNCTION public.get_all_merchant_float_positions()
RETURNS TABLE(
  desk_id uuid,
  agent_id uuid,
  agent_name text,
  agent_phone text,
  label text,
  is_active boolean,
  ledger_float_held numeric,
  float_balance_raw numeric,
  paid_out_total numeric,
  float_credits_recorded numeric,
  owed_to_agent numeric,
  last_payout_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor date;
BEGIN
  SELECT COALESCE(NULLIF(value, '')::date, '2026-08-01'::date) INTO v_anchor
  FROM public.treasury_controls WHERE control_key = 'merchant_float_anchor_date';
  v_anchor := COALESCE(v_anchor, '2026-08-01'::date);

  RETURN QUERY
  WITH desks AS (
    SELECT ca.id, ca.agent_id, ca.label, ca.is_active,
           COALESCE(p.full_name, '') AS full_name,
           COALESCE(ca.float_phone, p.phone, '') AS phone
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    WHERE ca.is_active = true
  ),
  paid AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(w.amount), 0) AS total,
           MAX(COALESCE(w.processed_at, w.updated_at)) AS last_at
    FROM desks d
    LEFT JOIN public.withdrawal_requests w
      ON w.status = 'completed'
     AND COALESCE(w.processed_at, w.updated_at) >= v_anchor
     AND (w.assigned_cashout_agent_id = d.id OR w.processed_by = d.agent_id)
    GROUP BY d.id
  ),
  credits AS (
    SELECT d.id AS desk_id, COALESCE(SUM(g.amount), 0) AS total
    FROM desks d
    LEFT JOIN public.general_ledger g
      ON g.user_id = d.agent_id
     AND g.wallet_bucket = 'float'
     AND g.direction = 'cash_in'
     AND g.category IN ('agent_float_deposit', 'agent_float_assignment', 'agent_float_topup', 'agent_float_funding')
     AND g.classification <> 'admin_correction'
     AND g.transaction_date >= v_anchor
    GROUP BY d.id
  ),
  held AS (
    SELECT d.id AS desk_id,
           COALESCE(GREATEST(w.float_balance, 0), 0) AS ledger_float,
           COALESCE(wp.float_balance_raw, wp.float_balance, w.float_balance, 0) AS raw_net
    FROM desks d
    LEFT JOIN public.wallets w ON w.user_id = d.agent_id
    LEFT JOIN public.wallet_balances_projection wp ON wp.user_id = d.agent_id
  )
  SELECT d.id, d.agent_id, d.full_name, d.phone, d.label, d.is_active,
         h.ledger_float, h.raw_net, pd.total, cr.total,
         GREATEST(pd.total - cr.total, 0),
         pd.last_at
  FROM desks d
  JOIN paid pd ON pd.desk_id = d.id
  JOIN credits cr ON cr.desk_id = d.id
  JOIN held h ON h.desk_id = d.id
  ORDER BY h.ledger_float ASC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_all_merchant_float_positions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_all_merchant_float_positions() TO service_role;