UPDATE public.gmail_transactions
SET direction = 'out'
WHERE is_bulk_bank_payout = true
  AND direction = 'in'
  AND (
    lower(coalesce(raw_body,'')) LIKE '%ugx was sent to%'
    OR lower(coalesce(snippet,'')) LIKE '%ugx was sent to%'
    OR lower(coalesce(subject,'')) LIKE '%was sent to%'
  );