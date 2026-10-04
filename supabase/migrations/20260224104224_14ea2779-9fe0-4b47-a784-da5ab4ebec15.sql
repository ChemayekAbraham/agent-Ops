
-- Drop the overly permissive "System can view all subscriptions" policy
DROP POLICY IF EXISTS "System can view all subscriptions" ON public.push_subscriptions;
