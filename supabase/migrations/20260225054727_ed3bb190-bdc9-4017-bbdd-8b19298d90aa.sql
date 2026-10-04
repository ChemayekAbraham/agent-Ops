
-- 1. OPPORTUNITY_SUMMARIES: Restrict public SELECT
DROP POLICY IF EXISTS "Anyone can view opportunity summaries" ON public.opportunity_summaries;
CREATE POLICY "Managers and supporters can view summaries"
ON public.opportunity_summaries FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role) 
  OR has_role(auth.uid(), 'supporter'::app_role)
);

-- 2. FIX MUTABLE SEARCH_PATH ON FUNCTIONS
ALTER FUNCTION public.generate_welile_ai_id(uuid) SET search_path = public;
ALTER FUNCTION public.normalize_phone_last9(text) SET search_path = public;

-- 3. RESTRICT MATERIALIZED VIEWS FROM API
REVOKE ALL ON public.user_financial_summaries FROM anon;
REVOKE ALL ON public.user_financial_summaries FROM authenticated;
REVOKE ALL ON public.platform_stats FROM anon;
REVOKE ALL ON public.platform_stats FROM authenticated;
GRANT SELECT ON public.user_financial_summaries TO service_role;
GRANT SELECT ON public.platform_stats TO service_role;

-- 4. FIX RLS ALWAYS-TRUE POLICIES (system-only tables - deny client writes)
DROP POLICY IF EXISTS "System can insert ledger entries" ON public.general_ledger;
CREATE POLICY "Deny direct ledger inserts" ON public.general_ledger
FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "System can insert earnings" ON public.agent_earnings;
CREATE POLICY "Deny direct earnings inserts" ON public.agent_earnings
FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "System can insert repayments" ON public.repayments;
CREATE POLICY "Deny direct repayment inserts" ON public.repayments
FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "System can insert subscriptions" ON public.subscription_charges;
CREATE POLICY "Deny direct subscription inserts" ON public.subscription_charges
FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "System can update subscriptions" ON public.subscription_charges;
CREATE POLICY "Deny direct subscription updates" ON public.subscription_charges
FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS "System can insert charge logs" ON public.subscription_charge_logs;
CREATE POLICY "Deny direct charge log inserts" ON public.subscription_charge_logs
FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "System can insert rewards" ON public.referral_rewards;
CREATE POLICY "Deny direct reward inserts" ON public.referral_rewards
FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "System can update rewards" ON public.referral_rewards;
CREATE POLICY "Deny direct reward updates" ON public.referral_rewards
FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS "System can manage baselines" ON public.earning_baselines;
CREATE POLICY "Deny direct baseline management" ON public.earning_baselines
FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "System can manage predictions" ON public.earning_predictions;
CREATE POLICY "Deny direct prediction management" ON public.earning_predictions
FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "System can update credit limits" ON public.credit_access_limits;
CREATE POLICY "Deny direct credit limit updates" ON public.credit_access_limits
FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS "System can insert activity" ON public.user_activity_log;
CREATE POLICY "Deny direct activity inserts" ON public.user_activity_log
FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "System can insert ROI payments" ON public.supporter_roi_payments;
CREATE POLICY "Deny direct ROI payment inserts" ON public.supporter_roi_payments
FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "System can update ROI payments" ON public.supporter_roi_payments;
CREATE POLICY "Deny direct ROI payment updates" ON public.supporter_roi_payments
FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS "System can insert orders" ON public.product_orders;
CREATE POLICY "Deny direct order inserts" ON public.product_orders
FOR INSERT TO authenticated WITH CHECK (false);

-- 5. FIX CLIENT-FACING ALWAYS-TRUE POLICIES (scope them properly)
DROP POLICY IF EXISTS "System can insert referrals" ON public.referrals;
CREATE POLICY "Users can create own referral" ON public.referrals
FOR INSERT TO authenticated WITH CHECK (auth.uid() = referred_id);

DROP POLICY IF EXISTS "System can update referrals" ON public.referrals;
CREATE POLICY "Deny direct referral updates" ON public.referrals
FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS "System can insert notifications" ON public.notifications;
CREATE POLICY "Managers can insert notifications" ON public.notifications
FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

DROP POLICY IF EXISTS "System can insert pending operations" ON public.pending_wallet_operations;
CREATE POLICY "Managers can insert pending operations" ON public.pending_wallet_operations
FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'manager'::app_role));
