-- get_money_at_bank_reconciliation (2026-09-07, second follow-up): the
-- movement list only ever showed bank-alert EMAILS (gmail_transactions).
-- It was missing the two Financial Ops reconciliation actions posted
-- directly to general_ledger today for this same cash event -- the 126M
-- float credit to Sky Bubbles (source_table=cfo_direct_credit) and the 62M
-- treasury entry for Welile Technologies Limited (source_table=
-- financial_ops_manual_entry) -- both explicitly sourced to "Bayo Mercy
-- Equity account ...7542" in their description, but invisible on this
-- panel since it never looked at general_ledger.
--
-- Adds those as extra movement rows (one per reference_id, representing
-- cash leaving Mercy's custody -- direction 'out' from her point of view,
-- regardless of which side of the double-entry the underlying leg is on).
-- Matched narrowly by source_table + a specific phrase this session wrote
-- ("bayo mercy equity") -- NOT a broad name search, which pulls in 173
-- unrelated entries going back to March from her routine desk activity.
-- Like the email-derived rows, these do not feed money_at_bank_total --
-- they're cash movements Financial Ops recorded, not bank transactions.
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
      normalized_text ~ '(debit|sent to|withdraw|transfer(red)? (to|out)|payment to)' AS looks_debit
    FROM bank_emails
  ), email_movements AS (
    SELECT
      id::text AS id,
      CASE
        WHEN looks_credit AND NOT looks_debit THEN 'in'
        WHEN looks_debit AND NOT looks_credit THEN 'out'
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
      'email'::text AS movement_source
    FROM classified
    WHERE is_bayo_account AND (looks_credit OR looks_debit)
  ), ledger_actions AS (
    -- One row per reconciliation action (reference_id), not one per
    -- double-entry leg -- a Financial Ops action moving cash out of her
    -- custody is a single event from her account's point of view.
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
      'ledger'::text AS movement_source
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
