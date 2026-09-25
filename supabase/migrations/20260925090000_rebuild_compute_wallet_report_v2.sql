-- Rebuild of the Daily Wallet Financial Summary (compute_wallet_report v2).
-- See docs/HANDOVER/131-daily-wallet-report-rebuilt.md.
--
-- v1 was faithful to the ledger but wrong as a money report:
--   * "Total Amount Deposited" counted float that WELILE itself sent out to
--     agents (merchant_float_deliveries / reconciliations) as a deposit, and
--     mixed hand-posted CFO direct credits in with real phone-line money.
--   * "Total Amount Paid Out" only counted wallet_withdrawal debits — i.e. the
--     moment a user's wallet was debited, not the moment cash actually left —
--     and missed every withdrawal a cashout agent paid out of float.
--   * "Closing Wallet Balance" was deposits minus payouts for the day, not a
--     balance anyone holds.
--   * "Merchant Agent Equity Bank Account" was every bank_transfer payout
--     (Stanbic, StanChart, Centenary, ...), not just Equity.
--
-- v2 splits the day into buckets that never double count:
--   money_in        real money credited to wallets from phone lines / bank / cash
--   manual_credits  credits a person posted by hand (no new cash by itself)
--   float_to_agents WELILE's own money moved onto agent phones (internal)
--   payouts         cash that actually left: agent-paid withdrawals (float
--                   settlement legs, principal + telecom fee) plus withdrawals
--                   treasury paid directly (never float-settled)
--   net_movement    money_in - payouts (labelled as a movement, not a balance)
--   provider_sms    independent cross-check from gmail_transactions (what the
--                   MTN/Airtel/bank SMS say came in and went out of company lines)
--   phone_float_at_end  last provider-SMS balance per line at/before period end
-- plus top deposits / top outgoing SMS so a reader can see who moved big money.

DROP FUNCTION IF EXISTS public.compute_wallet_report(timestamptz, timestamptz);

CREATE FUNCTION public.compute_wallet_report(_start timestamptz, _end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  -- Service-role callers (cron edge function) have no auth.uid(). Signed-in
  -- callers must hold one of the roles that can already read daily_wallet_reports:
  -- v2 exposes depositor names, which v1 did not.
  IF v_uid IS NOT NULL AND NOT (
       public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'financial_ops'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
    OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'ceo'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorised to view the wallet report' USING ERRCODE = '42501';
  END IF;

  WITH gl AS (
    SELECT g.*
    FROM general_ledger g
    WHERE g.transaction_date >= _start
      AND g.transaction_date <  _end
      AND g.classification = 'production'
      AND g.ledger_scope   = 'wallet'
  ),
  credits AS (
    SELECT
      g.id, g.user_id, g.amount, g.transaction_date, g.source_id,
      CASE
        WHEN g.source_table = 'deposit_requests' THEN COALESCE((
          SELECT CASE
            WHEN EXISTS (SELECT 1 FROM cash_deposit_verifications c WHERE c.deposit_request_id = dr.id) THEN 'cash'
            WHEN lower(COALESCE(dr.provider,'')) IN ('cash','cash_deposit') THEN 'cash'
            WHEN lower(COALESCE(dr.provider,'')) = 'mtn'    THEN 'mtn'
            WHEN lower(COALESCE(dr.provider,'')) = 'airtel' THEN 'airtel'
            WHEN lower(COALESCE(dr.provider,'')) IN ('bank','bank_transfer') THEN 'bank'
            ELSE 'other'
          END
          FROM deposit_requests dr WHERE dr.id = g.source_id), 'other')
        WHEN g.source_table IN ('field_deposit_batches','field_collections','agent_cash_deposit_sessions') THEN 'cash'
        WHEN g.source_table = 'gmail_transactions' THEN 'gmail_auto'
        WHEN g.source_table IN ('merchant_float_deliveries','merchant_float_reconciliations') THEN 'float_to_agents'
        WHEN g.source_table = 'cfo_direct_credit' THEN 'manual_cfo_direct'
        WHEN g.source_table = 'manual_recovery'   THEN 'manual_recovery'
        WHEN g.source_table IN ('ledger_transaction','general_ledger') THEN 'manual_ledger_adjustment'
        ELSE 'unclassified'
      END AS bucket,
      g.source_table
    FROM gl g
    WHERE g.direction = 'cash_in'
      AND g.category IN ('agent_float_deposit','wallet_deposit')
  ),
  money_in AS (
    SELECT * FROM credits WHERE bucket IN ('mtn','airtel','bank','cash','gmail_auto','other')
  ),
  exec_staff_in AS (
    SELECT m.* FROM money_in m
    WHERE EXISTS (
      SELECT 1 FROM user_roles r
      WHERE r.user_id = m.user_id
        AND r.role::text IN ('ceo','cfo','coo','cto','cmo','financial_ops','super_admin')
    )
  ),
  -- Withdrawals a cashout agent paid out of float: every settlement leg is cash
  -- that left an agent phone (principal leg = withdrawal amount; the rest is
  -- the telecom fee, part of the same float debit).
  agent_paid AS (
    SELECT g.amount, g.source_id,
           (wr.amount IS NOT NULL AND g.amount = wr.amount) AS is_principal,
           lower(COALESCE(wr.mobile_money_provider,'')) AS prov
    FROM gl g
    LEFT JOIN withdrawal_requests wr ON wr.id = g.source_id
    WHERE g.direction = 'cash_out'
      AND g.category = 'agent_float_settlement'
  ),
  -- Withdrawals never float-settled were paid by treasury directly; count them
  -- on the day the wallet was debited.
  treasury_paid AS (
    SELECT g.amount, g.source_id,
           CASE
             WHEN wr.payout_method = 'bank_transfer' THEN 'bank_transfer'
             WHEN lower(COALESCE(wr.mobile_money_provider,'')) = 'mtn'    THEN 'mtn'
             WHEN lower(COALESCE(wr.mobile_money_provider,'')) = 'airtel' THEN 'airtel'
             ELSE 'other'
           END AS channel,
           wr.bank_name
    FROM gl g
    JOIN withdrawal_requests wr ON wr.id = g.source_id
    WHERE g.direction = 'cash_out'
      AND g.category = 'wallet_withdrawal'
      AND g.source_table = 'withdrawal_requests'
      AND NOT EXISTS (
        SELECT 1 FROM general_ledger s
        WHERE s.category = 'agent_float_settlement'
          AND s.source_table = 'withdrawal_requests'
          AND s.source_id = g.source_id
          AND s.classification = 'production'
      )
  ),
  sms AS (
    SELECT t.*
    FROM gmail_transactions t
    WHERE t.internal_date >= _start
      AND t.internal_date <  _end
      AND t.parsed
      AND t.amount IS NOT NULL
  ),
  sms_bal AS (
    SELECT DISTINCT ON (t.channel) t.channel, t.balance, t.internal_date
    FROM gmail_transactions t
    WHERE t.internal_date < _end
      AND t.balance IS NOT NULL
      AND t.channel IN ('mtn_momo','airtel_money')
    ORDER BY t.channel, t.internal_date DESC
  )
  SELECT jsonb_build_object(
    'version', 2,
    'period_start', _start,
    'period_end', _end,

    'money_in', jsonb_build_object(
      'mtn',        (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM money_in WHERE bucket='mtn'),
      'airtel',     (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM money_in WHERE bucket='airtel'),
      'bank',       (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM money_in WHERE bucket='bank'),
      'cash',       (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM money_in WHERE bucket='cash'),
      'gmail_auto', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM money_in WHERE bucket='gmail_auto'),
      'other',      (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM money_in WHERE bucket='other')
    ),
    'money_in_total', (SELECT COALESCE(sum(amount),0) FROM money_in),
    'money_in_from_exec_staff', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM exec_staff_in),

    'manual_credits', jsonb_build_object(
      'cfo_direct',        (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM credits WHERE bucket='manual_cfo_direct'),
      'ledger_adjustment', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM credits WHERE bucket='manual_ledger_adjustment'),
      'manual_recovery',   (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM credits WHERE bucket='manual_recovery'),
      'unclassified',      (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM credits WHERE bucket='unclassified')
    ),
    'manual_credits_total', (SELECT COALESCE(sum(amount),0) FROM credits WHERE bucket IN ('manual_cfo_direct','manual_ledger_adjustment','manual_recovery','unclassified')),

    'float_to_agents', jsonb_build_object(
      'deliveries',      (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM credits WHERE bucket='float_to_agents' AND source_table='merchant_float_deliveries'),
      'reconciliations', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM credits WHERE bucket='float_to_agents' AND source_table='merchant_float_reconciliations'),
      'recipients', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', name, 'count', n, 'amount', amt) ORDER BY amt DESC)
        FROM (
          SELECT COALESCE(p.full_name, c.user_id::text) AS name, count(*) AS n, sum(c.amount) AS amt
          FROM credits c LEFT JOIN profiles p ON p.id = c.user_id
          WHERE c.bucket = 'float_to_agents'
          GROUP BY 1
        ) x), '[]'::jsonb)
    ),
    'float_to_agents_total', (SELECT COALESCE(sum(amount),0) FROM credits WHERE bucket='float_to_agents'),

    'payouts', jsonb_build_object(
      'agent_paid', jsonb_build_object(
        'withdrawals', (SELECT count(DISTINCT source_id) FROM agent_paid),
        'principal',   (SELECT COALESCE(sum(amount),0) FROM agent_paid WHERE is_principal),
        'fees',        (SELECT COALESCE(sum(amount),0) FROM agent_paid WHERE NOT is_principal),
        'amount',      (SELECT COALESCE(sum(amount),0) FROM agent_paid)
      ),
      'treasury_bank_transfer', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM treasury_paid WHERE channel='bank_transfer'),
      'treasury_mtn',           (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM treasury_paid WHERE channel='mtn'),
      'treasury_airtel',        (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM treasury_paid WHERE channel='airtel'),
      'treasury_other',         (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM treasury_paid WHERE channel='other'),
      'bank_transfer_banks', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('bank', bank, 'count', n, 'amount', amt) ORDER BY amt DESC)
        FROM (
          SELECT COALESCE(NULLIF(regexp_replace(upper(trim(bank_name)), '\s+(UGANDA\s+)?(LIMITED|LTD)\.?$', ''), ''), 'UNKNOWN') AS bank, count(*) AS n, sum(amount) AS amt
          FROM treasury_paid WHERE channel='bank_transfer' GROUP BY 1
        ) x), '[]'::jsonb)
    ),
    'payouts_total', (SELECT COALESCE(sum(amount),0) FROM agent_paid) + (SELECT COALESCE(sum(amount),0) FROM treasury_paid),

    'net_movement',
      (SELECT COALESCE(sum(amount),0) FROM money_in)
      - (SELECT COALESCE(sum(amount),0) FROM agent_paid)
      - (SELECT COALESCE(sum(amount),0) FROM treasury_paid),

    'internal_movements', jsonb_build_object(
      'wallet_to_rent_plan_portfolios', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM gl WHERE direction='cash_out' AND category='partner_funding'),
      'agent_float_used_for_rent',      (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM gl WHERE direction='cash_out' AND category='agent_float_used_for_rent')
    ),

    'provider_sms', jsonb_build_object(
      'in', jsonb_build_object(
        'mtn',    (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM sms WHERE direction='in' AND channel='mtn_momo'),
        'airtel', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM sms WHERE direction='in' AND channel='airtel_money'),
        'bank',   (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM sms WHERE direction='in' AND channel='bank')
      ),
      'out', jsonb_build_object(
        'mtn',    (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0), 'fees', COALESCE(sum(fee),0)) FROM sms WHERE direction IN ('out','charge') AND channel='mtn_momo'),
        'airtel', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0), 'fees', COALESCE(sum(fee),0)) FROM sms WHERE direction IN ('out','charge') AND channel='airtel_money'),
        'bank',   (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0), 'fees', COALESCE(sum(fee),0)) FROM sms WHERE direction IN ('out','charge') AND channel='bank')
      ),
      'in_not_linked', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM sms WHERE direction='in' AND linked_deposit_request_id IS NULL),
      'top_out', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('to', cp, 'channel', channel, 'count', n, 'amount', amt) ORDER BY amt DESC)
        FROM (
          SELECT COALESCE(NULLIF(split_part(COALESCE(counterparty_name, counterparty), '. TX Charge', 1), ''), 'unknown') AS cp,
                 channel, count(*) AS n, sum(amount) AS amt
          FROM sms WHERE direction IN ('out','charge')
          GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 10
        ) x), '[]'::jsonb)
    ),

    'phone_float_at_end', jsonb_build_object(
      'mtn',    (SELECT jsonb_build_object('balance', balance, 'as_of', internal_date) FROM sms_bal WHERE channel='mtn_momo'),
      'airtel', (SELECT jsonb_build_object('balance', balance, 'as_of', internal_date) FROM sms_bal WHERE channel='airtel_money'),
      'total',  (SELECT COALESCE(sum(balance),0) FROM sms_bal)
    ),

    'top_deposits', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', name, 'channel', bucket, 'count', n, 'amount', amt, 'exec_staff', is_exec) ORDER BY amt DESC)
      FROM (
        SELECT COALESCE(p.full_name, m.user_id::text) AS name, m.bucket, count(*) AS n, sum(m.amount) AS amt,
               EXISTS (SELECT 1 FROM exec_staff_in e WHERE e.user_id = m.user_id) AS is_exec
        FROM money_in m LEFT JOIN profiles p ON p.id = m.user_id
        GROUP BY m.user_id, p.full_name, m.bucket
        ORDER BY 4 DESC LIMIT 10
      ) x), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.compute_wallet_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_wallet_report(timestamptz, timestamptz) TO authenticated, service_role;

-- Stored snapshots keep their v1 columns for history; v2 rows also carry the
-- full payload. closing_balance now holds net_movement for v2 rows.
ALTER TABLE public.daily_wallet_reports
  ADD COLUMN IF NOT EXISTS report jsonb,
  ADD COLUMN IF NOT EXISTS report_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.daily_wallet_reports.closing_balance IS
  'v1: deposits minus wallet withdrawals (mislabelled "Closing Wallet Balance"). v2 (report_version=2): net_movement = money_in_total - payouts_total. Neither is a balance anyone holds.';
COMMENT ON COLUMN public.daily_wallet_reports.report IS
  'Full compute_wallet_report v2 payload (report_version=2). NULL on v1 rows.';
