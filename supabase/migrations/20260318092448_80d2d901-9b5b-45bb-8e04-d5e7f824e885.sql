
CREATE TABLE public.portfolio_renewals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
  renewed_by UUID NOT NULL,
  reason TEXT NOT NULL,
  old_created_at TIMESTAMPTZ NOT NULL,
  new_created_at TIMESTAMPTZ NOT NULL,
  old_maturity_date TEXT,
  new_maturity_date TEXT,
  old_roi_percentage NUMERIC NOT NULL,
  new_roi_percentage NUMERIC NOT NULL,
  old_duration_months INTEGER NOT NULL,
  new_duration_months INTEGER NOT NULL,
  top_up_amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.portfolio_renewals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read renewals"
  ON public.portfolio_renewals FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert renewals"
  ON public.portfolio_renewals FOR INSERT
  TO authenticated WITH CHECK (true);
