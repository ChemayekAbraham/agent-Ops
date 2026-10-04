-- Re-classify Airtel agent-payout emails ("You have deposited UGX X ... Mobile Number: 07XX")
-- as money-out (direction='out', channel='airtel_money'), and capture the recipient
-- phone as counterparty. These were previously mis-tagged as 'in' / channel='other'.
UPDATE public.gmail_transactions
SET
  direction = 'out',
  channel = 'airtel_money',
  counterparty = COALESCE(
    counterparty,
    NULLIF((regexp_match(snippet, 'Mobile\s+Number\s*[:\-]?\s*((?:\+?256|0)?\d{6,})', 'i'))[1], '')
  )
WHERE
  (snippet ILIKE '%you have deposited%' OR subject ILIKE '%you have deposited%')
  AND (snippet ~* 'mobile\s+number\s*[:\-]?\s*\d' OR subject ~* 'mobile\s+number\s*[:\-]?\s*\d')
  AND (direction IS DISTINCT FROM 'out' OR channel IS DISTINCT FROM 'airtel_money');