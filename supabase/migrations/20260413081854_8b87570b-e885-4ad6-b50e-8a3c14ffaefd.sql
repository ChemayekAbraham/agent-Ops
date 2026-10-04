
CREATE TABLE public.scheduled_payouts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_by UUID NOT NULL,
  target_user_id UUID NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  category_id TEXT NOT NULL,
  sub_category TEXT,
  reason TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  day_of_month INTEGER NOT NULL CHECK (day_of_month >= 1 AND day_of_month <= 28),
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.scheduled_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CFO and super_admin can view scheduled payouts"
  ON public.scheduled_payouts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "CFO and super_admin can create scheduled payouts"
  ON public.scheduled_payouts FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "CFO and super_admin can update scheduled payouts"
  ON public.scheduled_payouts FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "CFO and super_admin can delete scheduled payouts"
  ON public.scheduled_payouts FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin'));

CREATE TRIGGER update_scheduled_payouts_updated_at
  BEFORE UPDATE ON public.scheduled_payouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
