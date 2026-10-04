
-- Earning baselines: stores computed activity averages per user
CREATE TABLE public.earning_baselines (
  user_id uuid PRIMARY KEY,
  avg_daily_earnings numeric DEFAULT 0,
  avg_weekly_earnings numeric DEFAULT 0,
  avg_receipts_per_day numeric DEFAULT 0,
  avg_referrals_per_week numeric DEFAULT 0,
  total_agent_earnings numeric DEFAULT 0,
  receipt_count_7d integer DEFAULT 0,
  referral_count_7d integer DEFAULT 0,
  last_calculated_at timestamptz DEFAULT now()
);

ALTER TABLE public.earning_baselines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own baselines"
  ON public.earning_baselines FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "System can manage baselines"
  ON public.earning_baselines FOR ALL
  USING (true) WITH CHECK (true);

-- Earning predictions: AI-generated forecasts
CREATE TABLE public.earning_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period text NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  predicted_earnings numeric NOT NULL DEFAULT 0,
  confidence numeric NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  assumptions jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.earning_predictions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own predictions"
  ON public.earning_predictions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "System can manage predictions"
  ON public.earning_predictions FOR ALL
  USING (true) WITH CHECK (true);

-- Index for fast lookups
CREATE INDEX idx_earning_predictions_user_period ON public.earning_predictions (user_id, period, created_at DESC);
CREATE INDEX idx_earning_baselines_user ON public.earning_baselines (user_id);
