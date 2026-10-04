
-- Create promissory_notes table
CREATE TABLE public.promissory_notes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL,
  partner_name TEXT NOT NULL,
  whatsapp_number TEXT NOT NULL,
  phone_number TEXT,
  email TEXT,
  amount NUMERIC NOT NULL,
  contribution_type TEXT NOT NULL DEFAULT 'once_off',
  deduction_day INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  partner_user_id UUID,
  activation_token TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  total_collected NUMERIC NOT NULL DEFAULT 0,
  next_deduction_date DATE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add validation trigger for contribution_type
CREATE OR REPLACE FUNCTION public.validate_promissory_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.contribution_type NOT IN ('monthly', 'once_off') THEN
    RAISE EXCEPTION 'Invalid contribution_type: %. Must be monthly or once_off', NEW.contribution_type;
  END IF;
  IF NEW.contribution_type = 'monthly' AND (NEW.deduction_day IS NULL OR NEW.deduction_day < 1 OR NEW.deduction_day > 28) THEN
    RAISE EXCEPTION 'Monthly contributions require deduction_day between 1 and 28';
  END IF;
  IF NEW.amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;
  IF NEW.status NOT IN ('pending', 'activated', 'fulfilled', 'defaulted', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid status: %', NEW.status;
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_promissory_note
  BEFORE INSERT OR UPDATE ON public.promissory_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_promissory_note();

-- Indexes
CREATE INDEX idx_promissory_notes_agent_id ON public.promissory_notes(agent_id);
CREATE INDEX idx_promissory_notes_status ON public.promissory_notes(status);
CREATE INDEX idx_promissory_notes_activation_token ON public.promissory_notes(activation_token);
CREATE INDEX idx_promissory_notes_partner_user_id ON public.promissory_notes(partner_user_id);
CREATE INDEX idx_promissory_notes_next_deduction ON public.promissory_notes(next_deduction_date) WHERE status = 'activated';

-- Enable RLS
ALTER TABLE public.promissory_notes ENABLE ROW LEVEL SECURITY;

-- Agents can view their own notes
CREATE POLICY "Agents can view own promissory notes"
  ON public.promissory_notes
  FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

-- Agents can create notes
CREATE POLICY "Agents can create promissory notes"
  ON public.promissory_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (agent_id = auth.uid());

-- Partners can view their linked notes
CREATE POLICY "Partners can view own linked notes"
  ON public.promissory_notes
  FOR SELECT
  TO authenticated
  USING (partner_user_id = auth.uid());

-- Admin roles can view all notes
CREATE POLICY "Admin roles can view all promissory notes"
  ON public.promissory_notes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
      AND role IN ('operations', 'cfo', 'coo', 'super_admin')
    )
  );

-- Admin roles can update notes
CREATE POLICY "Admin roles can update promissory notes"
  ON public.promissory_notes
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
      AND role IN ('operations', 'cfo', 'coo', 'super_admin')
    )
  );

-- Agents can update their own pending notes
CREATE POLICY "Agents can update own pending notes"
  ON public.promissory_notes
  FOR UPDATE
  TO authenticated
  USING (agent_id = auth.uid() AND status = 'pending');

-- Grant select to anon for activation token lookup
CREATE POLICY "Anon can lookup by activation token"
  ON public.promissory_notes
  FOR SELECT
  TO anon
  USING (false);
