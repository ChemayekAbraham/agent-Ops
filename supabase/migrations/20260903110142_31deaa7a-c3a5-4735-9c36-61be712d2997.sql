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
      gt.direction,
      gt.amount,
      COALESCE(gt.internal_date, gt.created_at) AS extracted_at,
      gt.transaction_id,
      gt.subject,
      gt.from_name,
      gt.from_email,
      gt.snippet,
      gt.raw_body,
      regexp_replace(lower(COALESCE(gt.raw_body, '') || ' ' || COALESCE(gt.snippet, '') || ' ' || COALESCE(gt.subject, '')), '[^a-z0-9]+', ' ', 'g') AS normalized_text
    FROM public.gmail_transactions gt
    WHERE gt.channel = 'bank' AND gt.amount IS NOT NULL
  ), classified AS (
    SELECT *,
      normalized_text ~ '(^| )dear *bayo( |$)' AS is_bayo_receipt,
      normalized_text ~ 'from welile technologies' AS is_welile_sender,
      normalized_text ~ 'sent to (bayo mercy|mercy bayo)' AS is_bayo_transfer
    FROM bank_emails
  ), qualifying AS (
    SELECT * FROM classified
    WHERE (direction = 'in' AND is_bayo_receipt AND is_welile_sender)
       OR (direction = 'out' AND is_bayo_transfer)
  )
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0),
    COUNT(*) FILTER (WHERE direction = 'in'),
    COUNT(*) FILTER (WHERE direction = 'out')
  INTO v_received, v_sent, v_received_count, v_sent_count
  FROM qualifying;

  WITH bank_emails AS (
    SELECT
      gt.id,
      gt.direction,
      gt.amount,
      COALESCE(gt.internal_date, gt.created_at) AS extracted_at,
      gt.transaction_id,
      gt.subject,
      gt.from_name,
      gt.from_email,
      gt.snippet,
      regexp_replace(lower(COALESCE(gt.raw_body, '') || ' ' || COALESCE(gt.snippet, '') || ' ' || COALESCE(gt.subject, '')), '[^a-z0-9]+', ' ', 'g') AS normalized_text
    FROM public.gmail_transactions gt
    WHERE gt.channel = 'bank' AND gt.amount IS NOT NULL
  ), classified AS (
    SELECT *,
      normalized_text ~ '(^| )dear *bayo( |$)' AS is_bayo_receipt,
      normalized_text ~ 'from welile technologies' AS is_welile_sender,
      normalized_text ~ 'sent to (bayo mercy|mercy bayo)' AS is_bayo_transfer
    FROM bank_emails
  )
  SELECT COALESCE(json_agg(json_build_object(
    'id', id,
    'direction', direction,
    'amount', amount,
    'extracted_at', extracted_at,
    'transaction_id', transaction_id,
    'subject', subject,
    'from_name', from_name,
    'from_email', from_email,
    'snippet', snippet,
    'match_reason', CASE WHEN direction = 'in' THEN 'Dear Bayo + Welile Technologies sender' ELSE 'Transfer to Bayo Mercy' END
    ) ORDER BY extracted_at DESC), '[]'::json)
  INTO v_rows
  FROM classified
  WHERE (direction = 'in' AND is_bayo_receipt AND is_welile_sender)
     OR (direction = 'out' AND is_bayo_transfer);

  RETURN json_build_object(
    'banked_base', v_banked,
    'banked_count', v_banked_count,
    'extracted_received', v_received,
    'extracted_sent', v_sent,
    'extracted_net', v_received - v_sent,
    'money_at_bank_total', v_banked + v_received - v_sent,
    'received_count', v_received_count,
    'sent_count', v_sent_count,
    'qualifying_emails', v_rows,
    'computed_at', now()
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_money_at_bank_reconciliation() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_money_at_bank_total()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.get_money_at_bank_reconciliation();
$function$;

GRANT EXECUTE ON FUNCTION public.get_money_at_bank_total() TO authenticated;