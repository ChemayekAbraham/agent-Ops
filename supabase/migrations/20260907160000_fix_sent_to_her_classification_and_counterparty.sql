-- get_money_at_bank_reconciliation (2026-09-07, third follow-up):
--
-- 1. Direction bug: "...UGX was sent to BAYO MERCY..." (a third-party's own
--    transaction-confirmation email, greeting blank -- someone ELSE paying
--    HER) matched the generic 'sent to' debit keyword and was classified
--    'out', when it's actually a credit (she is the recipient, not the
--    sender). Confirmed on a real UGX 60,000,000 "ROP payments" transfer.
--    Only "sent to <someone else>" while the email is addressed to her
--    ("Dear Bayo/Mercy, ... sent to X") is a genuine debit; "sent to
--    Bayo/Mercy" (any greeting) is a credit to her account.
--
-- 2. Adds a `counterparty` field so the UI can show who the money actually
--    moved to/from, instead of a hardcoded 'Bayo Mercy account' label that
--    read backwards on every row regardless of direction (frontend fix
--    lands separately in PhoneMoneyStatementSheet.tsx).
CREATE OR REPLACE FUNCTION public.get_money_at_bank_reconciliation()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_received numeric := 0;
  v_sent numeric := 0;
  v_banked numeric := 0;
  v_received_count integer := 0;
  v_sent_count integer := 0;
  v_banked_count integer := 0;
  v_rows json;
  v_cutoff timestamptz := timestamptz '2026-09-07 00:00:00+03';
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (v.deposit_request_id) v.deposit_request_id, v.amount, v.status
    FROM public.cash_deposit_verifications v
    ORDER BY v.deposit_request_id, v.created_at DESC
  )
  SELECT COALESCE(SUM(l.amount), 0), COUNT(*)
  INTO v_banked, v_banked_count
  FROM latest l
  JOIN public.deposit_requests dr ON dr.id = l.deposit_request_id
  WHERE l.status = 'verified'
    AND COALESCE(dr.purpose_audit->>'cash_location', 'cash_at_hand') = 'bank';

  WITH bank_emails AS (
    SELECT
      gt.id,
      gt.amount,
      COALESCE(gt.internal_date, gt.created_at) AS extracted_at,
      gt.transaction_id,
      gt.subject,
      gt.from_name,
      gt.from_email,
      gt.snippet,
      regexp_replace(lower(COALESCE(gt.snippet, '') || ' ' || COALESCE(gt.subject, '')), '[^a-z0-9]+', ' ', 'g') AS normalized_text
    FROM public.gmail_transactions gt
    WHERE gt.channel = 'bank'
      AND gt.amount IS NOT NULL
  ), classified AS (
    SELECT *,
      (
        (normalized_text ~ '(^| )dear (bayo|mercy|bayo mercy|mercy bayo)( |$)'
          OR normalized_text ~ '(to|for) (bayo mercy|mercy bayo)( |$)')
        AND lower(COALESCE(from_email, '')) ~ '@equitybank'
      ) AS is_bayo_account,
      normalized_text ~ '(you have received|credit(ed)? (to|into)|deposit(ed)? (to|into))' AS looks_credit,
      normalized_text ~ '(debit|sent to|withdraw|transfer(red)? (to|out)|payment to)' AS looks_debit,
      -- "sent to bayo/mercy" means someone else paid HER -- a credit, not a
      -- debit, no matter how the greeting reads (these confirmations are
      -- usually addressed to the SENDER, greeting blank).
      normalized_text ~ 'sent to (bayo mercy|mercy bayo|bayo|mercy)( |$)' AS sent_to_her,
      COALESCE(
        substring(snippet from 'received [0-9.,]+ UGX from ([A-Za-z'' .]+?) [0-9*]'),
        substring(snippet from 'sent to ([A-Za-z'' .]+?) [0-9*]')
      ) AS extracted_counterparty
    FROM bank_emails
  ), email_movements AS (
    SELECT
      id::text AS id,
      CASE
        WHEN (looks_credit OR sent_to_her) AND NOT (looks_debit AND NOT sent_to_her) THEN 'in'
        WHEN (looks_debit AND NOT sent_to_her) AND NOT (looks_credit OR sent_to_her) THEN 'out'
        ELSE 'ambiguous'
      END AS direction,
      amount,
      extracted_at,
      transaction_id,
      subject,
      from_name,
      from_email,
      snippet,
      (extracted_at >= v_cutoff) AS counted_in_balance,
      'email'::text AS movement_source,
      CASE
        -- "sent to BAYO MERCY" with no named sender in the snippet --
        -- extraction would just return her own name back; show it as
        -- unknown rather than a confusing self-reference.
        WHEN extracted_counterparty ~* '^(bayo|mercy)( |$)' THEN 'Unknown sender'
        ELSE extracted_counterparty
      END AS counterparty
    FROM classified
    WHERE is_bayo_account AND (looks_credit OR looks_debit OR sent_to_her)
  ), ledger_actions AS (
    SELECT DISTINCT ON (gl.reference_id)
      gl.reference_id AS id,
      'out'::text AS direction,
      gl.amount,
      gl.transaction_date AS extracted_at,
      gl.reference_id AS transaction_id,
      'Financial Ops reconciliation' AS subject,
      'Financial Ops' AS from_name,
      NULL::text AS from_email,
      gl.description AS snippet,
      false AS counted_in_balance,
      'ledger'::text AS movement_source,
      CASE
        WHEN gl.category = 'agent_float_deposit' THEN 'Sky Bubbles desk (float)'
        WHEN gl.category = 'cash_receipt_in_transit' THEN 'Welile Technologies Limited (Treasury)'
        ELSE 'Financial Ops'
      END AS counterparty
    FROM public.general_ledger gl
    WHERE gl.source_table IN ('cfo_direct_credit', 'financial_ops_manual_entry')
      AND gl.description ILIKE '%bayo mercy equity%'
    ORDER BY gl.reference_id, gl.amount DESC
  ), all_movements AS (
    SELECT * FROM email_movements
    UNION ALL
    SELECT * FROM ledger_actions
  )
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'in' AND counted_in_balance), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'out' AND counted_in_balance), 0),
    COUNT(*) FILTER (WHERE direction = 'in' AND counted_in_balance),
    COUNT(*) FILTER (WHERE direction = 'out' AND counted_in_balance),
    COALESCE(json_agg(json_build_object(
      'id', id,
      'direction', direction,
      'amount', amount,
      'extracted_at', extracted_at,
      'transaction_id', transaction_id,
      'subject', subject,
      'from_name', from_name,
      'from_email', from_email,
      'snippet', snippet,
      'counted_in_balance', counted_in_balance,
      'movement_source', movement_source,
      'counterparty', counterparty,
      'match_reason', CASE
        WHEN movement_source = 'ledger' THEN 'Recorded by Financial Ops -- cash moved out of Bayo Mercy custody, not a bank-alert email'
        WHEN direction = 'ambiguous' THEN 'Ambiguous -- matched both credit and debit language, excluded from totals, needs manual review'
        WHEN NOT counted_in_balance THEN
          (CASE WHEN direction = 'in' THEN 'Credit into Bayo Mercy account' ELSE 'Debit out of Bayo Mercy account' END)
          || ' -- before the 2026-09-07 reconciliation reset, not counted in the current balance'
        WHEN direction = 'in' THEN 'Credit into Bayo Mercy account'
        ELSE 'Debit out of Bayo Mercy account'
      END
      ) ORDER BY extracted_at DESC), '[]'::json)
  INTO v_received, v_sent, v_received_count, v_sent_count, v_rows
  FROM all_movements;

  RETURN json_build_object(
    'definition', 'Money at Bank = balance of funds managed in Bayo Mercy''s bank account (credits in less debits out), from bank emails extracted since the cutoff. qualifying_emails shows the full match history plus Financial Ops reconciliation actions on this cash (movement_source: email or ledger); only rows with counted_in_balance=true feed the total below.',
    'banked_base', 0,
    'banked_count', 0,
    'banked_cash_reference', v_banked,
    'banked_cash_reference_count', v_banked_count,
    'extracted_received', v_received,
    'extracted_sent', v_sent,
    'extracted_net', v_received - v_sent,
    'money_at_bank_total', v_received - v_sent,
    'received_count', v_received_count,
    'sent_count', v_sent_count,
    'email_cutoff_at', v_cutoff,
    'qualifying_emails', COALESCE(v_rows, '[]'::json),
    'computed_at', now()
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_money_at_bank_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_money_at_bank_reconciliation() TO authenticated;
