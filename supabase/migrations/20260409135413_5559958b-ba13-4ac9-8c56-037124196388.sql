
-- Treasury Controls table for auto-payout toggles and enforcement flags
CREATE TABLE IF NOT EXISTS public.treasury_controls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  control_key TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.treasury_controls ENABLE ROW LEVEL SECURITY;

-- SELECT for executive finance roles
CREATE POLICY "Treasury controls viewable by finance executives"
  ON public.treasury_controls FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'ceo'));

-- UPDATE only for CFO and Super Admin
CREATE POLICY "Treasury controls editable by cfo and super_admin"
  ON public.treasury_controls FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'cfo')
           OR public.has_role(auth.uid(), 'super_admin'));

-- Seed default control rows
INSERT INTO public.treasury_controls (control_key, enabled) VALUES
  ('auto_roi', false),
  ('auto_salaries', false),
  ('auto_commissions', false),
  ('auto_advances', false),
  ('enforce_cash_guard', true),
  ('enforce_roi_coverage', true),
  ('enforce_wallet_lock', true)
ON CONFLICT (control_key) DO NOTHING;
