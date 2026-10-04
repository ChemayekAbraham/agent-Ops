-- Create wallet_deposits table to track deposits at agent premises
CREATE TABLE public.wallet_deposits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  deposit_type TEXT NOT NULL DEFAULT 'cash_deposit',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create wallet_withdrawals table for cash-out at agent premises  
CREATE TABLE public.wallet_withdrawals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create agent_earnings table to track commissions and bonuses
CREATE TABLE public.agent_earnings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL,
  amount NUMERIC NOT NULL,
  earning_type TEXT NOT NULL, -- 'commission', 'approval_bonus'
  source_user_id UUID, -- tenant who triggered the earning
  rent_request_id UUID,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create notifications table for agent alerts
CREATE TABLE public.notifications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info', -- 'info', 'success', 'earning', 'request'
  read BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.wallet_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- wallet_deposits policies
CREATE POLICY "Agents can view deposits they facilitated"
ON public.wallet_deposits FOR SELECT
USING (has_role(auth.uid(), 'agent') AND agent_id = auth.uid());

CREATE POLICY "Users can view own deposits"
ON public.wallet_deposits FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Agents can create deposits"
ON public.wallet_deposits FOR INSERT
WITH CHECK (has_role(auth.uid(), 'agent') AND agent_id = auth.uid());

CREATE POLICY "Managers can view all deposits"
ON public.wallet_deposits FOR SELECT
USING (has_role(auth.uid(), 'manager'));

-- wallet_withdrawals policies
CREATE POLICY "Agents can view withdrawals they facilitated"
ON public.wallet_withdrawals FOR SELECT
USING (has_role(auth.uid(), 'agent') AND agent_id = auth.uid());

CREATE POLICY "Users can view own withdrawals"
ON public.wallet_withdrawals FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Agents can create withdrawals"
ON public.wallet_withdrawals FOR INSERT
WITH CHECK (has_role(auth.uid(), 'agent') AND agent_id = auth.uid());

CREATE POLICY "Managers can view all withdrawals"
ON public.wallet_withdrawals FOR SELECT
USING (has_role(auth.uid(), 'manager'));

-- agent_earnings policies
CREATE POLICY "Agents can view own earnings"
ON public.agent_earnings FOR SELECT
USING (auth.uid() = agent_id);

CREATE POLICY "Managers can view all earnings"
ON public.agent_earnings FOR SELECT
USING (has_role(auth.uid(), 'manager'));

CREATE POLICY "System can insert earnings"
ON public.agent_earnings FOR INSERT
WITH CHECK (true);

-- notifications policies
CREATE POLICY "Users can view own notifications"
ON public.notifications FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications"
ON public.notifications FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "System can insert notifications"
ON public.notifications FOR INSERT
WITH CHECK (true);

-- Enable realtime for notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_earnings;