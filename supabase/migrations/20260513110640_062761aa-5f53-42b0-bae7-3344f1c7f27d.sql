
-- Touch rows so the trigger recomputes total_repayment + daily_repayment
UPDATE public.rent_requests
SET total_repayment = total_repayment
WHERE registration_type = 'outstanding_balance'
  AND COALESCE(initial_outstanding_balance, 0) > 0
  AND COALESCE(total_repayment, 0) < initial_outstanding_balance;
