-- Ensure approved bike lease applications are recorded as exactly 1 bike / 1 item issued.
-- Normalizes quantity to 1 and corrects any 2-bike valuation (1,420,000) down to the single-bike valuation (710,000).

UPDATE public.merchandise_sales
SET quantity = 1,
    valuation_amount = 710000,
    total_amount = 710000,
    total_revenue = 710000,
    unit_price = 710000,
    amount_outstanding = 710000 - COALESCE(amount_paid, 0),
    payment_projection = round(710000 * COALESCE(lease_daily_rate, 0.42))
WHERE (client_name ILIKE '%Mata%' OR client_name ILIKE '%Pius%')
  AND (quantity > 1 OR total_revenue > 710000 OR valuation_amount > 710000);

-- If there are duplicate approved bike sales for this agent, cancel the older duplicates
WITH dupes AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY customer_id
           ORDER BY created_at DESC
         ) as rn
  FROM public.merchandise_sales
  WHERE (client_name ILIKE '%Mata%' OR client_name ILIKE '%Pius%')
    AND order_status IN ('approved', 'completed', 'issued')
)
UPDATE public.merchandise_sales
SET order_status = 'cancelled',
    notes = COALESCE(notes, '') || ' | Cancelled duplicate bike sale entry (1 bike only)'
WHERE id IN (SELECT id FROM dupes WHERE rn > 1);

-- Normalize recovery plan to 1 bike valuation (710,000)
UPDATE public.merchandise_recovery_plans
SET original_amount = 710000,
    outstanding_balance = 710000 - COALESCE(amount_recovered, 0)
WHERE (customer_name ILIKE '%Mata%' OR customer_name ILIKE '%Pius%')
  AND original_amount > 710000;
