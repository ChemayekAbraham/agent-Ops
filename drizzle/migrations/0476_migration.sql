CREATE TABLE public.lending_payment_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES public.lending_agent_loans(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('day_before','due_today')),
  phone text,
  amount_ugx numeric,
  sent boolean NOT NULL DEFAULT false,
  provider_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, due_date, kind)
);
ALTER TABLE public.lending_payment_reminders ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.lending_payment_reminders TO service_role;
GRANT SELECT ON public.lending_payment_reminders TO authenticated;
CREATE POLICY "Staff view lending reminders" ON public.lending_payment_reminders FOR SELECT TO authenticated
USING (has_role(auth.uid(),'manager') OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'agent_ops') OR has_role(auth.uid(),'cfo'));