
UPDATE public.investor_portfolios
SET status = 'active',
    maturity_date = (created_at + (duration_months || ' months')::interval),
    next_roi_date = CASE
      WHEN next_roi_date IS NULL
      THEN (date_trunc('day', created_at) + interval '1 month')
      ELSE next_roi_date
    END
WHERE portfolio_pin = '4891'
  AND status = 'matured'
  AND (created_at + (duration_months || ' months')::interval) > now();
