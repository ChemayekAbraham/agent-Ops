
-- ============ TABLE ============
CREATE TABLE public.daily_wallet_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date date NOT NULL UNIQUE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  deposits_by_source jsonb NOT NULL DEFAULT '{}'::jsonb,
  payouts_by_channel jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_deposited numeric(18,2) NOT NULL DEFAULT 0,
  total_paid_out numeric(18,2) NOT NULL DEFAULT 0,
  closing_balance numeric(18,2) NOT NULL DEFAULT 0,
  pdf_path text,
  xlsx_path text,
  generated_by text NOT NULL DEFAULT 'system',
  generated_at timestamptz NOT NULL DEFAULT now(),
  email_sent_at timestamptz,
  email_recipients text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_daily_wallet_reports_date ON public.daily_wallet_reports (report_date DESC);

GRANT SELECT ON public.daily_wallet_reports TO authenticated;
GRANT ALL ON public.daily_wallet_reports TO service_role;

ALTER TABLE public.daily_wallet_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "finops_roles_read_daily_wallet_reports"
  ON public.daily_wallet_reports
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
  );

CREATE TRIGGER trg_daily_wallet_reports_updated_at
  BEFORE UPDATE ON public.daily_wallet_reports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ RPC ============
CREATE OR REPLACE FUNCTION public.compute_wallet_report(
  _start timestamptz,
  _end timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deposits jsonb;
  v_payouts jsonb;
  v_total_deposited numeric(18,2) := 0;
  v_total_paid_out numeric(18,2) := 0;
BEGIN
  -- Deposits: aggregated from deposit_requests where the operational row has been
  -- ratified into the immutable ledger (a matching general_ledger production leg
  -- with source_table='deposit_requests' exists). This is the audit-safe join
  -- between operational and ledger records.
  WITH posted_deposits AS (
    SELECT dr.id, dr.provider, dr.amount
    FROM deposit_requests dr
    WHERE dr.status = 'approved'
      AND dr.approved_at >= _start
      AND dr.approved_at <  _end
      AND EXISTS (
        SELECT 1
        FROM general_ledger gl
        WHERE gl.source_table = 'deposit_requests'
          AND gl.source_id    = dr.id
          AND gl.direction    = 'cash_in'
          AND gl.classification = 'production'
      )
  ),
  dep_agg AS (
    SELECT
      CASE
        WHEN provider IN ('cash','cash_deposit') THEN 'cash'
        WHEN lower(provider) = 'mtn'   THEN 'mtn'
        WHEN lower(provider) = 'airtel' THEN 'airtel'
        WHEN provider IN ('bank','bank_transfer') THEN 'bank'
        ELSE 'other'
      END AS bucket,
      COUNT(*)::int AS cnt,
      COALESCE(SUM(amount),0)::numeric(18,2) AS amt
    FROM posted_deposits
    GROUP BY 1
  )
  SELECT
    jsonb_build_object(
      'cash',   COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='cash'),   jsonb_build_object('count',0,'amount',0)),
      'mtn',    COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='mtn'),    jsonb_build_object('count',0,'amount',0)),
      'airtel', COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='airtel'), jsonb_build_object('count',0,'amount',0)),
      'bank',   COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='bank'),   jsonb_build_object('count',0,'amount',0)),
      'other',  COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='other'),  jsonb_build_object('count',0,'amount',0))
    ),
    COALESCE((SELECT SUM(amt) FROM dep_agg), 0)::numeric(18,2)
  INTO v_deposits, v_total_deposited;

  -- Payouts: aggregated from withdrawal_requests marked completed with a
  -- matching posted ledger leg. Grouped by channel: Merchant MTN, Merchant Airtel,
  -- Merchant Equity Bank (and Other for anything else).
  WITH posted_payouts AS (
    SELECT
      wr.id,
      wr.amount,
      wr.payout_method,
      lower(COALESCE(wr.mobile_money_provider,'')) AS provider,
      lower(COALESCE(wr.bank_name,'')) AS bank
    FROM withdrawal_requests wr
    WHERE wr.status = 'completed'
      AND wr.processed_at >= _start
      AND wr.processed_at <  _end
      AND EXISTS (
        SELECT 1 FROM general_ledger gl
        WHERE gl.source_table = 'withdrawal_requests'
          AND gl.source_id    = wr.id
          AND gl.direction    = 'cash_out'
          AND gl.classification = 'production'
      )
  ),
  pay_agg AS (
    SELECT
      CASE
        WHEN payout_method = 'mobile_money' AND provider = 'mtn'    THEN 'merchant_mtn'
        WHEN payout_method = 'mobile_money' AND provider = 'airtel' THEN 'merchant_airtel'
        WHEN payout_method = 'bank_transfer' AND (bank ILIKE '%equity%' OR bank = '' OR bank = 'bank') THEN 'merchant_equity'
        WHEN payout_method = 'bank_transfer'                        THEN 'merchant_equity'
        ELSE 'other'
      END AS bucket,
      COUNT(*)::int AS cnt,
      COALESCE(SUM(amount),0)::numeric(18,2) AS amt
    FROM posted_payouts
    GROUP BY 1
  )
  SELECT
    jsonb_build_object(
      'merchant_mtn',    COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM pay_agg WHERE bucket='merchant_mtn'),    jsonb_build_object('count',0,'amount',0)),
      'merchant_airtel', COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM pay_agg WHERE bucket='merchant_airtel'), jsonb_build_object('count',0,'amount',0)),
      'merchant_equity', COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM pay_agg WHERE bucket='merchant_equity'), jsonb_build_object('count',0,'amount',0)),
      'other',           COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM pay_agg WHERE bucket='other'),           jsonb_build_object('count',0,'amount',0))
    ),
    COALESCE((SELECT SUM(amt) FROM pay_agg), 0)::numeric(18,2)
  INTO v_payouts, v_total_paid_out;

  RETURN jsonb_build_object(
    'period_start', _start,
    'period_end',   _end,
    'deposits_by_source', v_deposits,
    'payouts_by_channel', v_payouts,
    'total_deposited',    v_total_deposited,
    'total_paid_out',     v_total_paid_out,
    'closing_balance',    v_total_deposited - v_total_paid_out
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_wallet_report(timestamptz, timestamptz) TO authenticated, service_role;
