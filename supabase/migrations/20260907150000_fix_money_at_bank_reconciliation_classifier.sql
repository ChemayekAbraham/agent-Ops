-- Fix two correctness bugs in get_money_at_bank_reconciliation (2026-09-07):
--
-- 1. Classification ran off raw_body + snippet + subject. raw_body carries
--    bank-footer boilerplate ("if your account was wrongly credited, call
--    ..."), which produced false credit-keyword matches on genuine debit
--    emails. Confirmed: a "Your transaction was successful ... 5,000 UGX
--    was sent to JOSEPH LUKODDA" debit was miscounted as a credit this way.
--    Classification now runs off snippet + subject only (the clean,
--    structured summary text), not the noisy raw_body.
--
-- 2. is_bayo_account matched purely on greeting name ("Dear Bayo/Mercy"),
--    with no bank/account check, so an unrelated Absa account transfer
--    (acct ending *****41) was folded into the Equity ...7542 balance this
--    panel is meant to track. Now also requires the email to come from
--    Equity Bank (equitybank.co.ke) -- not the account's own digits,
--    because genuine debit-confirmation emails restate the RECIPIENT's
--    masked number, not her own account number, so an account-digit
--    check would wrongly exclude her real debits too.
--
-- 3. An email matching BOTH credit and debit language defaulted to a
--    credit ("ELSE 'in'"). It now resolves to 'ambiguous', is excluded
--    from the totals, and is still surfaced in qualifying_emails for
--    manual review instead of being silently counted either way.
--
-- Also advances the cutoff to 2026-09-07 (from 2026-09-03 11:40 EAT):
-- the prior window's credits (UGX 49,283,000 sent from Welile Technologies
-- to Bayo Mercy on 3-4 Sep) were withdrawn as physical cash since, with no
-- matching debit email ever generated for an over-the-counter withdrawal --
-- so the reconciliation had been carrying already-withdrawn cash as "still
-- at bank" for several days. Confirmed not real by Financial Ops
-- (2026-09-07). Resetting the cutoff starts the panel clean; it will still
-- pick up any genuine new Equity ...7542 activity from today onward.
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
    SELECT
      gt.id,
      gt.amount,
      COALESCE(gt.internal_date, gt.created_at) AS extracted_at,
      gt.transaction_id,
      gt.subject,
      gt.from_name,
      gt.from_email,
      gt.snippet,
      gt.from_email,
      regexp_replace(lower(COALESCE(gt.snippet, '') || ' ' || COALESCE(gt.subject, '')), '[^a-z0-9]+', ' ', 'g') AS normalized_text
    FROM public.gmail_transactions gt
    WHERE gt.channel = 'bank'
      AND gt.amount IS NOT NULL
      AND COALESCE(gt.internal_date, gt.created_at) >= v_cutoff
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
      END AS direction
    FROM classified
    WHERE is_bayo_account AND (looks_credit OR looks_debit)
  )
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0),
    COUNT(*) FILTER (WHERE direction = 'in'),
    COUNT(*) FILTER (WHERE direction = 'out'),
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
      'match_reason', CASE
        WHEN direction = 'in' THEN 'Credit into Bayo Mercy account'
        WHEN direction = 'out' THEN 'Debit out of Bayo Mercy account'
        ELSE 'Ambiguous -- matched both credit and debit language, excluded from totals, needs manual review'
      END
      ) ORDER BY extracted_at DESC), '[]'::json)
  INTO v_received, v_sent, v_received_count, v_sent_count, v_rows
  FROM qualifying;

  RETURN json_build_object(
    'definition', 'Money at Bank = balance of funds managed in Bayo Mercy''s bank account (credits in less debits out), from bank emails extracted since the cutoff.',
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
