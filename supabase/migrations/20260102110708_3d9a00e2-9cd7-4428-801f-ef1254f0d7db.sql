-- Create table to track monthly referral rewards
CREATE TABLE public.referral_rewards (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  reward_month DATE NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1 AND rank <= 3),
  reward_amount NUMERIC NOT NULL,
  referral_count INTEGER NOT NULL,
  credited BOOLEAN NOT NULL DEFAULT false,
  credited_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add unique constraint for user per month
ALTER TABLE public.referral_rewards ADD CONSTRAINT unique_user_reward_month UNIQUE (user_id, reward_month);

-- Enable RLS
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;

-- Users can view their own rewards
CREATE POLICY "Users can view own rewards"
ON public.referral_rewards
FOR SELECT
USING (auth.uid() = user_id);

-- Managers can view all rewards
CREATE POLICY "Managers can view all rewards"
ON public.referral_rewards
FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- System can insert rewards
CREATE POLICY "System can insert rewards"
ON public.referral_rewards
FOR INSERT
WITH CHECK (true);

-- System can update rewards
CREATE POLICY "System can update rewards"
ON public.referral_rewards
FOR UPDATE
USING (true);

-- Create function to process monthly rewards
CREATE OR REPLACE FUNCTION public.process_monthly_referral_rewards()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reward_date DATE := date_trunc('month', now() - interval '1 month')::date;
  top_referrer RECORD;
  reward_amounts INTEGER[] := ARRAY[5000, 3000, 1000];
  current_rank INTEGER := 1;
BEGIN
  -- Get top 3 referrers from the previous month
  FOR top_referrer IN
    SELECT 
      r.referrer_id as user_id,
      COUNT(*) as referral_count
    FROM public.referrals r
    WHERE r.created_at >= date_trunc('month', now() - interval '1 month')
      AND r.created_at < date_trunc('month', now())
      AND r.credited = true
    GROUP BY r.referrer_id
    ORDER BY COUNT(*) DESC
    LIMIT 3
  LOOP
    -- Only reward if they have at least 1 referral
    IF top_referrer.referral_count > 0 THEN
      -- Insert reward record
      INSERT INTO public.referral_rewards (user_id, reward_month, rank, reward_amount, referral_count, credited, credited_at)
      VALUES (top_referrer.user_id, reward_date, current_rank, reward_amounts[current_rank], top_referrer.referral_count, true, now())
      ON CONFLICT (user_id, reward_month) DO NOTHING;
      
      -- Credit wallet
      UPDATE public.wallets
      SET balance = balance + reward_amounts[current_rank],
          updated_at = now()
      WHERE user_id = top_referrer.user_id;
      
      -- Send notification
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        top_referrer.user_id,
        '🏆 Monthly Referral Reward!',
        'Congratulations! You ranked #' || current_rank || ' in last month''s referral leaderboard and earned UGX ' || reward_amounts[current_rank] || '!',
        'success',
        jsonb_build_object('rank', current_rank, 'reward_amount', reward_amounts[current_rank], 'month', reward_date)
      );
      
      current_rank := current_rank + 1;
    END IF;
  END LOOP;
END;
$$;