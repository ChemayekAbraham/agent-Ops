-- 1) Christine's agreement amount
UPDATE public.partner_agreements pa
SET partnership_amount = 270000,
    partnership_amount_words = 'Two Hundred Seventy Thousand',
    updated_at = now()
WHERE pa.partner_id = '44890bc3-000c-44d1-8b28-eded52cc01ab'
  AND COALESCE(pa.partnership_amount, 0) = 0;

-- 2) Re-open her completion link (not expired: valid to 2026-08-07)
UPDATE public.portfolio_completion_tokens
SET consumed_at = NULL
WHERE id = '29a90fa1-3ba9-4909-9a3f-d686f5a88e23';

-- 3) Allow the partner to re-submit the completion form
UPDATE public.investor_portfolios
SET status = 'awaiting_partner_details'
WHERE id = '9561dd7f-01c8-4dbc-b4d2-71586d5f4fdc';
