-- WELILE company Equity account (...5259) reconciliation.
--
-- Read-only, informational tally of the raw "Dear WELILE" / outgoing bank
-- alert emails already sitting in gmail_transactions — mirrors the existing
-- get_money_at_bank_reconciliation() built for Bayo Mercy's personal Equity
-- account, but for the company's own account, which is a distinct account
-- with no user/wallet behind it. This does NOT touch general_ledger and does
-- NOT move the CFO Overview "Money in Bank" figure (that comes from ledger
-- account A1) — it only answers "how much has this account received / sent,
-- per the emails we've ingested".
--
-- The tricky part: Equity's outgoing "Your transaction was successful ...
-- was sent to X" template leaves the salutation BLANK for this account
-- ("Dear , Your transaction..."), while Bayo Mercy's own account gets the
-- named salutation ("Dear BAYO, Your transaction..."). Verified against the
-- full equitybank inbox on 2026-09-09: 130 blank-salutation outgoing emails
-- (UGX 2,059,175,028) vs only 5 "Dear BAYO" ones (UGX 49,298,000). Blank
-- salutation is therefore treated as WELILE's own outgoing transfer. Without
-- this, the tracker would only ever see credits and never the much larger
-- outflow side.
CREATE OR REPLACE FUNCTION public.get_welile_account_reconciliation()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_received numeric := 0;
  v_sent numeric := 0;
  v_received_count integer := 0;
  v_sent_count integer := 0;
  v_rows json;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

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
      AND lower(COALESCE(gt.from_email, '')) ~ '@equitybank'
  ), classified AS (
    SELECT *,
      -- "Dear WELILE, You have received ..." / "Dear WELILE, ... issued a
      -- reversal ... to account ...5259" both name the account holder.
      (normalized_text ~ '(^| )dear welile( |$)') AS is_welile_credit,
      -- Blank-salutation outgoing template — see header comment.
      (normalized_text ~ '^dear your transaction was successful') AS is_welile_debit,
      normalized_text ~ '(you have received|issued a reversal of)' AS looks_credit,
      normalized_text ~ 'your transaction was successful' AS looks_debit,
      COALESCE(
        substring(snippet from 'received [0-9.,]+ UGX from ([A-Za-z'' .]+?) [0-9*]'),
        substring(snippet from 'sent to ([A-Za-z'' .]+?) [0-9*]'),
        substring(snippet from 'sent to ([A-Za-z'' .]+?) at Equity')
      ) AS extracted_counterparty
    FROM bank_emails
  ), email_movements AS (
    SELECT
      id::text AS id,
      CASE
        WHEN is_welile_credit AND looks_credit THEN 'in'
        WHEN is_welile_debit AND looks_debit THEN 'out'
        ELSE 'ambiguous'
      END AS direction,
      amount, extracted_at, transaction_id, subject, from_name, from_email, snippet,
      extracted_counterparty AS counterparty
    FROM classified
    WHERE (is_welile_credit AND looks_credit) OR (is_welile_debit AND looks_debit)
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
      'counterparty', counterparty,
      'date', to_char(extracted_at AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY'),
      'time', to_char(extracted_at AT TIME ZONE 'Africa/Kampala', 'HH24:MI') || ' EAT',
      'match_reason', CASE
        WHEN direction = 'in' THEN 'Credit into WELILE company Equity account'
        ELSE 'Debit out of WELILE company Equity account'
      END
    ) ORDER BY extracted_at DESC), '[]'::json)
  INTO v_received, v_sent, v_received_count, v_sent_count, v_rows
  FROM email_movements;

  RETURN json_build_object(
    'definition', 'WELILE company Equity account (...5259) = qualifying "Dear WELILE, you have received" / reversal credits, less blank-salutation "Your transaction was successful ... sent to" debits (the company''s own outgoing transfers). Informational tally of raw bank-alert emails only -- not a ledger posting, and separate from the ledger-backed Money in Bank figure on the CFO Overview.',
    'extracted_received', v_received,
    'extracted_sent', v_sent,
    'extracted_net', v_received - v_sent,
    'received_count', v_received_count,
    'sent_count', v_sent_count,
    'qualifying_emails', COALESCE(v_rows, '[]'::json),
    'computed_at', now()
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_welile_account_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_welile_account_reconciliation() TO authenticated;
