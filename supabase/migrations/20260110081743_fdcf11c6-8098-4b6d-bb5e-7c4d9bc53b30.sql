-- Function to increase tenant's rent access limit on timely payment
CREATE OR REPLACE FUNCTION public.increase_limit_on_timely_payment()
RETURNS TRIGGER AS $$
DECLARE
  rent_amount NUMERIC;
  current_limit NUMERIC;
  max_limit NUMERIC := 5000000; -- UGX 5,000,000 maximum
  increase_percentage NUMERIC := 0.02; -- 2% increase per on-time payment
  increase_amount NUMERIC;
  payment_is_today BOOLEAN;
BEGIN
  -- Check if payment is made today (on-time)
  payment_is_today := DATE(NEW.payment_date) = CURRENT_DATE;
  
  IF payment_is_today THEN
    -- Get the rent amount from the associated rent request
    SELECT rr.rent_amount INTO rent_amount
    FROM rent_requests rr
    WHERE rr.id = NEW.rent_request_id;
    
    IF rent_amount IS NOT NULL THEN
      -- Calculate increase amount (2% of rent amount per on-time payment)
      increase_amount := ROUND(rent_amount * increase_percentage);
      
      -- Get or create loan limit record
      INSERT INTO loan_limits (user_id, available_limit, used_limit, total_verified_amount)
      VALUES (NEW.tenant_id, increase_amount, 0, NEW.amount)
      ON CONFLICT (user_id) DO UPDATE SET
        available_limit = LEAST(loan_limits.available_limit + increase_amount, max_limit),
        total_verified_amount = loan_limits.total_verified_amount + NEW.amount,
        updated_at = NOW();
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger on repayments table
DROP TRIGGER IF EXISTS trigger_increase_limit_on_payment ON repayments;
CREATE TRIGGER trigger_increase_limit_on_payment
  AFTER INSERT ON repayments
  FOR EACH ROW
  EXECUTE FUNCTION public.increase_limit_on_timely_payment();

-- Add unique constraint on user_id if not exists (for ON CONFLICT to work)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'loan_limits_user_id_key'
  ) THEN
    ALTER TABLE loan_limits ADD CONSTRAINT loan_limits_user_id_key UNIQUE (user_id);
  END IF;
END $$;