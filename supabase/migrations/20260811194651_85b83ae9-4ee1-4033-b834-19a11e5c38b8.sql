CREATE TABLE IF NOT EXISTS public.merchant_float_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  desk_id uuid NOT NULL REFERENCES public.cashout_agents(id) ON DELETE CASCADE,
  agent_id uuid,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('opening_balance','reimbursement_recorded','payout_correction','write_off')),
  amount numeric NOT NULL CHECK (amount <> 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 10),
  evidence_note text,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfr_desk ON public.merchant_float_reconciliations(desk_id, created_at DESC);

GRANT SELECT, INSERT ON public.merchant_float_reconciliations TO authenticated;
GRANT ALL ON public.merchant_float_reconciliations TO service_role;

ALTER TABLE public.merchant_float_reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance can view merchant reconciliations"
ON public.merchant_float_reconciliations FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'financial_ops')
  OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'super_admin')
  OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'coo')
  OR agent_id = auth.uid()
);

CREATE POLICY "Finance can post merchant reconciliations"
ON public.merchant_float_reconciliations FOR INSERT TO authenticated
WITH CHECK (
  created_by = auth.uid() AND (
    public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'financial_ops')
    OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'super_admin')
  )
);

CREATE TRIGGER trg_mfr_updated_at
BEFORE UPDATE ON public.merchant_float_reconciliations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP FUNCTION IF EXISTS public.get_merchant_float_positions();

CREATE FUNCTION public.get_merchant_float_positions()
 RETURNS TABLE(desk_id uuid, agent_id uuid, agent_name text, agent_phone text, label text, is_active boolean, paid_out_total numeric, reimbursed_total numeric, float_credits_recorded numeric, email_matched_total numeric, adjustments_total numeric, owed_to_agent numeric, company_cash_with_agent numeric, last_payout_at timestamp with time zone, last_reimbursed_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor date;
  v_is_finance boolean;
BEGIN
  SELECT COALESCE(NULLIF(value, '')::date, '2026-08-01'::date) INTO v_anchor
  FROM public.treasury_controls WHERE control_key = 'merchant_float_anchor_date';
  v_anchor := COALESCE(v_anchor, '2026-08-01'::date);

  v_is_finance := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo');

  RETURN QUERY
  WITH desks AS (
    SELECT ca.id, ca.agent_id, ca.label, ca.is_active,
           p.full_name, p.phone,
           right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 9) AS phone9
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    WHERE v_is_finance OR ca.agent_id = auth.uid()
  ),
  paid AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(w.amount), 0) AS total,
           MAX(w.processed_at) AS last_at
    FROM desks d
    LEFT JOIN public.withdrawal_requests w
      ON w.status = 'completed'
     AND COALESCE(w.processed_at, w.updated_at) >= v_anchor
     AND (w.assigned_cashout_agent_id = d.id OR w.processed_by = d.agent_id)
    GROUP BY d.id
  ),
  float_credits AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(g.amount), 0) AS total,
           MAX(g.transaction_date) AS last_at
    FROM desks d
    LEFT JOIN public.general_ledger g
      ON g.user_id = d.agent_id
     AND g.wallet_bucket = 'float'
     AND g.direction = 'cash_in'
     AND g.category = 'agent_float_deposit'
     AND g.classification <> 'admin_correction'
     AND g.transaction_date >= v_anchor
    GROUP BY d.id
  ),
  emails AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(g.amount), 0) AS total,
           MAX(g.internal_date) AS last_at
    FROM desks d
    LEFT JOIN public.gmail_transactions g
      ON g.direction = 'out'
     AND g.channel IN ('mtn_momo', 'airtel_money')
     AND g.amount IS NOT NULL
     AND d.phone9 <> ''
     AND right(regexp_replace(COALESCE(g.counterparty, ''), '\D', '', 'g'), 9) = d.phone9
     AND g.internal_date >= v_anchor
    GROUP BY d.id
  ),
  adj AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(CASE WHEN r.adjustment_type = 'payout_correction' THEN -r.amount ELSE r.amount END), 0) AS total
    FROM desks d
    LEFT JOIN public.merchant_float_reconciliations r ON r.desk_id = d.id
    GROUP BY d.id
  )
  SELECT d.id, d.agent_id, d.full_name, d.phone, d.label, d.is_active,
         pd.total,
         fc.total + aj.total,
         fc.total,
         em.total,
         aj.total,
         GREATEST(pd.total - (fc.total + aj.total), 0),
         GREATEST((fc.total + aj.total) - pd.total, 0),
         pd.last_at,
         GREATEST(fc.last_at, em.last_at)
  FROM desks d
  JOIN paid pd ON pd.desk_id = d.id
  JOIN float_credits fc ON fc.desk_id = d.id
  JOIN emails em ON em.desk_id = d.id
  JOIN adj aj ON aj.desk_id = d.id
  ORDER BY GREATEST((fc.total + aj.total) - pd.total, 0) DESC, GREATEST(pd.total - (fc.total + aj.total), 0) DESC;
END;
$function$;