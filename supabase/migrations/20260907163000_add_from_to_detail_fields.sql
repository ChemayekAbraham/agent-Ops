-- get_money_at_bank_reconciliation (2026-09-07, fifth follow-up): prep for
-- a tap-to-see-details view on each movement row (UI build is separate --
-- this only adds the data it needs). Adds explicit `from_party`, `to_party`,
-- `date` and `time` fields per movement so the detail view doesn't have to
-- re-derive "who sent it, who received it" from `direction` + `counterparty`
-- itself. `date`/`time` are formatted in Africa/Kampala (EAT, fixed UTC+3,
-- no DST) to match the timestamps already quoted inside the raw email
-- snippets (e.g. "...on 04 Sep 2026 at 15:02 EAT...") -- `extracted_at`
-- (raw UTC timestamptz) is kept unchanged for anything that needs it.
--
-- Also fixes the intake-summary row's counterparty: it was labeled
-- "Bayo Mercy (cash reported)" -- redundant once paired with the new
-- to_party="Bayo Mercy account" (both sides would say Bayo Mercy). Its
-- source isn't itemized, so it now reads "Field cash collection (not
-- itemized)".
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
  ), intake_summary AS (
    SELECT
      'intake-summary-' || date_trunc('day', extracted_at)::date::text AS id,
      'in'::text AS direction,
      SUM(amount) AS amount,
      MIN(extracted_at) - interval '1 second' AS extracted_at,
      NULL::text AS transaction_id,
      'Financial Ops reconciliation' AS subject,
      'Financial Ops' AS from_name,
      NULL::text AS from_email,
      'Cash reported by Financial Ops on ' || to_char(date_trunc('day', extracted_at), 'DD Mon YYYY')
        || ' -- recorded as the ' || count(*)::text || ' outflow(s) below, not a separate ledger posting.' AS snippet,
      false AS counted_in_balance,
      'ledger_summary'::text AS movement_source,
      'Field cash collection (not itemized)' AS counterparty
    FROM ledger_actions
    GROUP BY date_trunc('day', extracted_at)
  ), all_movements AS (
    SELECT * FROM email_movements
    UNION ALL
    SELECT * FROM ledger_actions
    UNION ALL
    SELECT * FROM intake_summary
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
      -- Detail-view-ready fields: which side is "Bayo Mercy account" is
      -- implied by direction, spelled out explicitly here so a UI doesn't
      -- have to re-derive it.
      'from_party', CASE WHEN direction = 'out' THEN 'Bayo Mercy account' ELSE counterparty END,
      'to_party', CASE WHEN direction = 'out' THEN counterparty ELSE 'Bayo Mercy account' END,
      'date', to_char(extracted_at AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY'),
      'time', to_char(extracted_at AT TIME ZONE 'Africa/Kampala', 'HH24:MI') || ' EAT',
      'match_reason', CASE
        WHEN movement_source = 'ledger_summary' THEN 'Reported cash intake -- summary of the Financial Ops entries below, not its own transaction'
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
    'definition', 'Money at Bank = balance of funds managed in Bayo Mercy''s bank account (credits in less debits out), from bank emails extracted since the cutoff. qualifying_emails shows the full match history plus Financial Ops reconciliation actions on this cash (movement_source: email, ledger, or ledger_summary); only rows with counted_in_balance=true feed the total below. Each row carries from_party/to_party/date/time for a detail view.',
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
