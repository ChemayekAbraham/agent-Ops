-- Create table to store weekly activity reports
CREATE TABLE public.user_activity_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  report_week DATE NOT NULL,
  login_count INTEGER DEFAULT 0,
  transaction_count INTEGER DEFAULT 0,
  total_transaction_amount NUMERIC DEFAULT 0,
  rent_requests_count INTEGER DEFAULT 0,
  repayments_count INTEGER DEFAULT 0,
  repayments_amount NUMERIC DEFAULT 0,
  engagement_score INTEGER DEFAULT 0,
  trend TEXT DEFAULT 'stable',
  report_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, report_week)
);

-- Enable RLS
ALTER TABLE public.user_activity_reports ENABLE ROW LEVEL SECURITY;

-- Managers can view all reports
CREATE POLICY "Managers can view all activity reports"
ON public.user_activity_reports
FOR SELECT
USING (public.has_role(auth.uid(), 'manager'::app_role));

-- Users can view their own reports
CREATE POLICY "Users can view own activity reports"
ON public.user_activity_reports
FOR SELECT
USING (auth.uid() = user_id);

-- System can insert reports (via service role)
CREATE POLICY "System can insert activity reports"
ON public.user_activity_reports
FOR INSERT
WITH CHECK (true);

-- Index for faster lookups
CREATE INDEX idx_activity_reports_user_week ON public.user_activity_reports(user_id, report_week DESC);
CREATE INDEX idx_activity_reports_week ON public.user_activity_reports(report_week DESC);