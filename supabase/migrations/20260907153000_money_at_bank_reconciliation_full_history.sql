-- get_money_at_bank_reconciliation (2026-09-07, follow-up to the classifier
-- fix in 20260907150000): the cutoff advance that reset the stale balance
-- also emptied `qualifying_emails`, since both the totals AND the movement
-- list were computed from the same cutoff-bounded query. That took away
-- audit visibility into Bayo Mercy's account history along with the
-- (correctly) reset balance.
--
-- Split the two: `extracted_received` / `extracted_sent` / `money_at_bank_total`
-- stay bounded to the cutoff (the balance genuinely starts fresh, per the
-- prior migration). `qualifying_emails` now returns the FULL match history,
-- each row flagged `counted_in_balance` so it's clear which ones feed the
-- current total and which are historical (already resolved / withdrawn as
-- cash before the reset).
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

  -- Reference only: verified cash deposits recorded as banked. No longer part of the total.
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
    -- Unbounded by cutoff -- full history, for display.
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
      -- The account holder is Bayo Mercy AND the email is genuinely from
      -- Equity Bank (her tracked account's bank) -- a name-only match let
      -- an unrelated Absa account through before this fix.
      (
        (normalized_text ~ '(^| )dear (bayo|mercy|bayo mercy|mercy bayo)( |$)'
          OR normalized_text ~ '(to|for) (bayo mercy|mercy bayo)( |$)')
        AND lower(COALESCE(from_email, '')) ~ '@equitybank'
      ) AS is_bayo_account,
      normalized_text ~ '(you have received|credit(ed)? (to|into)|deposit(ed)? (to|into))' AS looks_credit,
      normalized_text ~ '(debit|sent to|withdraw|transfer(red)? (to|out)|payment to)' AS looks_debit
    FROM bank_emails
  ), qualifying AS (
    SELECT *,
      CASE
        WHEN looks_credit AND NOT looks_debit THEN 'in'
        WHEN looks_debit AND NOT looks_credit THEN 'out'
        ELSE 'ambiguous'
      END AS direction,
      (extracted_at >= v_cutoff) AS counted_in_balance
    FROM classified
    WHERE is_bayo_account AND (looks_credit OR looks_debit)
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
      'match_reason', CASE
        WHEN direction = 'ambiguous' THEN 'Ambiguous -- matched both credit and debit language, excluded from totals, needs manual review'
        WHEN NOT counted_in_balance THEN
          (CASE WHEN direction = 'in' THEN 'Credit into Bayo Mercy account' ELSE 'Debit out of Bayo Mercy account' END)
          || ' -- before the 2026-09-07 reconciliation reset, not counted in the current balance'
        WHEN direction = 'in' THEN 'Credit into Bayo Mercy account'
        ELSE 'Debit out of Bayo Mercy account'
      END
      ) ORDER BY extracted_at DESC), '[]'::json)
  INTO v_received, v_sent, v_received_count, v_sent_count, v_rows
  FROM qualifying;

  RETURN json_build_object(
    'definition', 'Money at Bank = balance of funds managed in Bayo Mercy''s bank account (credits in less debits out), from bank emails extracted since the cutoff. qualifying_emails shows the full match history; only rows with counted_in_balance=true feed the total below.',
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
