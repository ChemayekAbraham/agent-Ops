-- Create loan repayments table
CREATE TABLE public.user_loan_repayments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  loan_id UUID NOT NULL REFERENCES public.user_loans(id) ON DELETE CASCADE,
  borrower_id UUID NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'wallet',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_loan_repayments ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Borrowers can view own repayments"
ON public.user_loan_repayments
FOR SELECT
USING (auth.uid() = borrower_id);

CREATE POLICY "Borrowers can make repayments"
ON public.user_loan_repayments
FOR INSERT
WITH CHECK (auth.uid() = borrower_id);

CREATE POLICY "Lenders can view repayments on their loans"
ON public.user_loan_repayments
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_loans 
    WHERE user_loans.id = user_loan_repayments.loan_id 
    AND user_loans.lender_id = auth.uid()
  )
);

CREATE POLICY "Managers can view all repayments"
ON public.user_loan_repayments
FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- Add paid_amount column to user_loans for tracking
ALTER TABLE public.user_loans ADD COLUMN paid_amount NUMERIC NOT NULL DEFAULT 0;

-- Create function to update loan after repayment
CREATE OR REPLACE FUNCTION public.process_loan_repayment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  loan_record RECORD;
  new_paid_amount NUMERIC;
BEGIN
  -- Get the loan
  SELECT * INTO loan_record FROM public.user_loans WHERE id = NEW.loan_id;
  
  IF loan_record IS NULL THEN
    RAISE EXCEPTION 'Loan not found';
  END IF;
  
  IF loan_record.status = 'repaid' THEN
    RAISE EXCEPTION 'Loan already fully repaid';
  END IF;
  
  -- Calculate new paid amount
  new_paid_amount := loan_record.paid_amount + NEW.amount;
  
  -- Update loan
  UPDATE public.user_loans
  SET paid_amount = new_paid_amount,
      status = CASE WHEN new_paid_amount >= total_repayment THEN 'repaid' ELSE 'active' END,
      repaid_at = CASE WHEN new_paid_amount >= total_repayment THEN now() ELSE NULL END
  WHERE id = NEW.loan_id;
  
  -- Deduct from borrower's wallet
  UPDATE public.wallets
  SET balance = balance - NEW.amount,
      updated_at = now()
  WHERE user_id = NEW.borrower_id;
  
  -- Credit to lender's wallet
  UPDATE public.wallets
  SET balance = balance + NEW.amount,
      updated_at = now()
  WHERE user_id = loan_record.lender_id;
  
  -- Create notification for lender
  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  VALUES (
    loan_record.lender_id,
    'Loan Repayment Received',
    'You received a repayment of UGX ' || NEW.amount || ' on a loan.',
    'success',
    jsonb_build_object('loan_id', NEW.loan_id, 'amount', NEW.amount)
  );
  
  RETURN NEW;
END;
$$;

-- Create trigger for repayments
CREATE TRIGGER on_loan_repayment
BEFORE INSERT ON public.user_loan_repayments
FOR EACH ROW
EXECUTE FUNCTION public.process_loan_repayment();