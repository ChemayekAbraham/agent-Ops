-- BUG FIX 1: Add INSERT policy for user_login_history
-- Currently only managers can SELECT, but no one can INSERT (causing RLS errors on every login)
CREATE POLICY "Users can insert their own login history"
ON public.user_login_history
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- BUG FIX 2: Update profiles check constraint to accept lowercase mobile money providers
-- The WithdrawRequestDialog saves 'mtn'/'airtel' but DB only allows 'MTN'/'Airtel'
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_mobile_money_provider_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_mobile_money_provider_check 
CHECK (mobile_money_provider = ANY (ARRAY['MTN', 'Airtel', 'mtn', 'airtel']));

-- BUG FIX 3: Add unique constraint on push_subscriptions(user_id) for upsert to work
-- Currently unique is on (user_id, endpoint) but code uses onConflict: 'user_id'
-- Solution: Add a unique index on user_id alone (a user should only have one active subscription)
-- First drop duplicate subscriptions keeping only the latest per user
DELETE FROM public.push_subscriptions a
USING public.push_subscriptions b
WHERE a.user_id = b.user_id 
  AND a.updated_at < b.updated_at;

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_user_id_unique ON public.push_subscriptions (user_id);