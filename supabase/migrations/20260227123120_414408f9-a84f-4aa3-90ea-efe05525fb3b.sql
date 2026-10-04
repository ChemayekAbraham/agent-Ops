
-- Table for supporter investment withdrawal requests (90-day notice period)
CREATE TABLE public.investment_withdrawal_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  amount NUMERIC NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  earliest_process_date TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days'),
  processed_at TIMESTAMPTZ,
  processed_by UUID,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.investment_withdrawal_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own withdrawal requests"
  ON public.investment_withdrawal_requests
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own withdrawal requests"
  ON public.investment_withdrawal_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);
