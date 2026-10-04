-- Create a function to handle loan limit updates on receipt submission
CREATE OR REPLACE FUNCTION public.handle_receipt_loan_limit()
RETURNS TRIGGER AS $$
DECLARE
  contribution_amount NUMERIC;
BEGIN
  -- On INSERT: Immediately increase loan limit (20% of claimed amount)
  IF TG_OP = 'INSERT' THEN
    contribution_amount := NEW.claimed_amount * 0.2;
    NEW.loan_contribution := contribution_amount;
    
    -- Update or insert loan limit
    INSERT INTO public.loan_limits (user_id, available_limit, total_verified_amount, used_limit)
    VALUES (NEW.user_id, contribution_amount, 0, 0)
    ON CONFLICT (user_id) 
    DO UPDATE SET 
      available_limit = loan_limits.available_limit + contribution_amount,
      updated_at = now();
    
    RETURN NEW;
  END IF;
  
  -- On UPDATE: Handle rejection - reset the loan limit contribution
  IF TG_OP = 'UPDATE' THEN
    -- If receipt was just rejected (rejection_reason set and wasn't set before)
    IF NEW.rejection_reason IS NOT NULL AND OLD.rejection_reason IS NULL AND OLD.loan_contribution IS NOT NULL AND OLD.loan_contribution > 0 THEN
      -- Subtract the contribution from loan limit
      UPDATE public.loan_limits
      SET 
        available_limit = GREATEST(available_limit - OLD.loan_contribution, 0),
        updated_at = now()
      WHERE user_id = NEW.user_id;
      
      -- Reset the loan contribution to 0
      NEW.loan_contribution := 0;
    END IF;
    
    -- If receipt was just verified (verified changed from false to true)
    IF NEW.verified = true AND OLD.verified = false THEN
      -- Update total_verified_amount (the contribution was already added on insert)
      UPDATE public.loan_limits
      SET 
        total_verified_amount = total_verified_amount + COALESCE(OLD.loan_contribution, 0),
        updated_at = now()
      WHERE user_id = NEW.user_id;
    END IF;
    
    RETURN NEW;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS on_receipt_loan_limit ON public.user_receipts;

-- Create trigger for INSERT and UPDATE
CREATE TRIGGER on_receipt_loan_limit
  BEFORE INSERT OR UPDATE ON public.user_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_receipt_loan_limit();