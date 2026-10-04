
-- Add agent verification and AI insurance fields to user_loans
ALTER TABLE public.user_loans 
  ADD COLUMN IF NOT EXISTS agent_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_verified_by uuid,
  ADD COLUMN IF NOT EXISTS agent_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_insurance_accepted boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_insurance_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS repayment_frequency text DEFAULT 'daily';

-- Create trigger to notify agents and managers when a credit facilitation is created
CREATE OR REPLACE FUNCTION public.notify_agents_on_credit_request()
RETURNS TRIGGER AS $$
DECLARE
  borrower_name text;
  agent_record record;
BEGIN
  -- Get borrower name
  SELECT full_name INTO borrower_name FROM public.profiles WHERE id = NEW.borrower_id;

  -- Notify all agents (role-based) and managers
  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT 
    p.id,
    'New Credit Access Request',
    COALESCE(borrower_name, 'A user') || ' has requested credit access of ' || NEW.amount || ' UGX. Verify to proceed.',
    'credit_request',
    jsonb_build_object(
      'loan_id', NEW.id,
      'borrower_id', NEW.borrower_id,
      'lender_id', NEW.lender_id,
      'amount', NEW.amount,
      'borrower_name', borrower_name
    )
  FROM public.profiles p
  WHERE p.agent_type IN ('agent', 'manager')
    AND p.id != NEW.lender_id
    AND p.id != NEW.borrower_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_notify_agents_credit_request
  AFTER INSERT ON public.user_loans
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_agents_on_credit_request();
