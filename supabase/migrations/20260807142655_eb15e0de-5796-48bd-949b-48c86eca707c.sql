CREATE OR REPLACE FUNCTION public.compute_wallet_report(_start timestamp with time zone, _end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deposits jsonb;
  v_payouts jsonb;
  v_total_deposited numeric(18,2) := 0;
  v_total_paid_out numeric(18,2) := 0;
BEGIN
  WITH posted_deposits AS (
    SELECT
      gl.id,
      gl.amount,
      CASE
        WHEN gl.source_table = 'deposit_requests' THEN
          (
            SELECT CASE
              WHEN EXISTS (
                SELECT 1 FROM cash_deposit_verifications cdv
                WHERE cdv.deposit_request_id = dr.id
              ) THEN 'cash_code'
              WHEN dr.provider IN ('cash','cash_deposit') THEN 'cash'
              WHEN lower(dr.provider) = 'mtn'    THEN 'mtn'
              WHEN lower(dr.provider) = 'airtel' THEN 'airtel'
              WHEN dr.provider IN ('bank','bank_transfer') THEN 'bank'
              ELSE 'other'
            END
            FROM deposit_requests dr
            WHERE dr.id = gl.source_id
          )
        WHEN gl.source_table IN ('field_deposit_batches','field_collections','agent_cash_deposit_sessions') THEN 'cash'
        WHEN gl.source_table = 'cfo_direct_credit'  THEN 'cfo_direct_credit'
        WHEN gl.source_table = 'gmail_transactions' THEN 'gmail_auto_credit'
        WHEN gl.source_table = 'manual_recovery'    THEN 'manual_recovery'
        WHEN gl.source_table IN ('ledger_transaction','general_ledger') THEN 'ledger_adjustment'
        ELSE 'other'
      END AS bucket
    FROM general_ledger gl
    WHERE gl.transaction_date >= _start
      AND gl.transaction_date <  _end
      AND gl.classification = 'production'
      AND gl.ledger_scope   = 'wallet'
      AND gl.direction      = 'cash_in'
      AND gl.category IN ('agent_float_deposit','wallet_deposit')
  ),
  dep_agg AS (
    SELECT COALESCE(bucket,'other') AS bucket,
           COUNT(*)::int AS cnt,
           COALESCE(SUM(amount),0)::numeric(18,2) AS amt
    FROM posted_deposits
    GROUP BY 1
  )
  SELECT
    jsonb_build_object(
      'cash',              COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='cash'),              jsonb_build_object('count',0,'amount',0)),
      'cash_code',         COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='cash_code'),         jsonb_build_object('count',0,'amount',0)),
      'mtn',               COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='mtn'),               jsonb_build_object('count',0,'amount',0)),
      'airtel',            COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='airtel'),            jsonb_build_object('count',0,'amount',0)),
      'bank',              COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='bank'),              jsonb_build_object('count',0,'amount',0)),
      'cfo_direct_credit', COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='cfo_direct_credit'), jsonb_build_object('count',0,'amount',0)),
      'gmail_auto_credit', COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='gmail_auto_credit'), jsonb_build_object('count',0,'amount',0)),
      'manual_recovery',   COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='manual_recovery'),   jsonb_build_object('count',0,'amount',0)),
      'ledger_adjustment', COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='ledger_adjustment'), jsonb_build_object('count',0,'amount',0)),
      'other',             COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM dep_agg WHERE bucket='other'),             jsonb_build_object('count',0,'amount',0))
    ),
    COALESCE((SELECT SUM(amt) FROM dep_agg), 0)::numeric(18,2)
  INTO v_deposits, v_total_deposited;

  WITH posted_payouts AS (
    SELECT
      gl.id,
      gl.amount,
      CASE
        WHEN gl.source_table = 'withdrawal_requests' THEN (
          SELECT CASE
            WHEN lower(COALESCE(wr.mobile_money_provider,'')) = 'mtn'    THEN 'merchant_mtn'
            WHEN lower(COALESCE(wr.mobile_money_provider,'')) = 'airtel' THEN 'merchant_airtel'
            WHEN wr.payout_method = 'bank_transfer'
              OR lower(COALESCE(wr.bank_name,'')) LIKE '%equity%'        THEN 'merchant_equity_bank'
            ELSE 'other'
          END
          FROM withdrawal_requests wr
          WHERE wr.id = gl.source_id
        )
        ELSE 'other'
      END AS bucket
    FROM general_ledger gl
    WHERE gl.transaction_date >= _start
      AND gl.transaction_date <  _end
      AND gl.classification = 'production'
      AND gl.ledger_scope   = 'wallet'
      AND gl.direction      = 'cash_out'
      AND gl.category = 'wallet_withdrawal'
  ),
  pay_agg AS (
    SELECT COALESCE(bucket,'other') AS bucket,
           COUNT(*)::int AS cnt,
           COALESCE(SUM(amount),0)::numeric(18,2) AS amt
    FROM posted_payouts
    GROUP BY 1
  )
  SELECT
    jsonb_build_object(
      'merchant_mtn',         COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM pay_agg WHERE bucket='merchant_mtn'),         jsonb_build_object('count',0,'amount',0)),
      'merchant_airtel',      COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM pay_agg WHERE bucket='merchant_airtel'),      jsonb_build_object('count',0,'amount',0)),
      'merchant_equity_bank', COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM pay_agg WHERE bucket='merchant_equity_bank'), jsonb_build_object('count',0,'amount',0)),
      'other',                COALESCE((SELECT jsonb_build_object('count',cnt,'amount',amt) FROM pay_agg WHERE bucket='other'),                jsonb_build_object('count',0,'amount',0))
    ),
    COALESCE((SELECT SUM(amt) FROM pay_agg), 0)::numeric(18,2)
  INTO v_payouts, v_total_paid_out;

  RETURN jsonb_build_object(
    'period_start',        _start,
    'period_end',          _end,
    'deposits',            v_deposits,
    'payouts',             v_payouts,
    'total_deposited',     v_total_deposited,
    'total_paid_out',      v_total_paid_out,
    'closing_wallet_balance', (v_total_deposited - v_total_paid_out)
  );
END;
$function$;