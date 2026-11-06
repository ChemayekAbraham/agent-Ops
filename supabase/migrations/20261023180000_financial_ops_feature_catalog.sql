-- Financial Ops access: choose, person by person, WHICH Financial Ops tools they can open (not only the two areas from 20261023170000).
-- Every tool in the Financial Ops menu is a "feature". A person can have any number of features switched off; the rest stay on.
--
-- ENFORCED IN THE DATABASE (a person gets no rows and a plain refusal, whatever role they hold):
--   float               the merchant float we hold
--   email_transactions  Email Transactions and the Gmail intake behind it
-- ALL OTHER FEATURES are hidden in the apps (enforced = false in the catalog). The apps read get_my_financial_ops_restrictions() and leave
-- the tool out of the menu. Someone who calls the database directly could still reach those; a feature moves to "enforced" when its tables
-- and functions get the same policy and check as the two above.
--
-- The panel (CTO > Platform Controls > Financial Ops access) lists the catalog from list_financial_ops_features() and saves with
-- set_financial_ops_restriction(user, features[], reason) from 20261023170000 (now accepts any catalog key).
-- Needs 20261023170000_financial_ops_access_restrictions.sql first. Roll back with 20261023180000_financial_ops_feature_catalog.rollback.sql.

CREATE TABLE IF NOT EXISTS public.financial_ops_features (
  key      text PRIMARY KEY,
  label    text NOT NULL,
  grp      text NOT NULL,
  sort     integer NOT NULL DEFAULT 0,
  enforced boolean NOT NULL DEFAULT false
);
ALTER TABLE public.financial_ops_features ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.financial_ops_features TO service_role;

INSERT INTO public.financial_ops_features (key, label, grp, sort, enforced) VALUES
  ('overview','Overview','Overview & planning',10,false),
  ('wallet_buckets','Wallet Buckets','Overview & planning',20,false),
  ('wallet_breakdown','Wallet Breakdown','Overview & planning',30,false),
  ('liquidity_forecast','Liquidity Forecast','Overview & planning',40,false),
  ('finance_charts','Finance Charts','Overview & planning',50,false),
  ('period_comparison','Period Comparison','Overview & planning',60,false),
  ('reports','Reports','Overview & planning',70,false),
  ('money_at_bank','Money at Bank','Overview & planning',80,false),
  ('agent_float_board_vs_books','Agent Float: Board vs Books','Overview & planning',90,false),
  ('capital_opportunities','Capital Opportunities','Overview & planning',100,false),
  ('move_money_between_wallets','Move Money Between Wallets','Overview & planning',110,false),
  ('deposit_bridge_health','Deposit Bridge Health','Overview & planning',120,false),
  ('email_transactions','Email Transactions','Money in',130,true),
  ('feed_diagnostics','Feed Diagnostics','Money in',140,false),
  ('field_deposits','Field Deposits','Money in',150,false),
  ('offline_collections','Offline Collections','Money in',160,false),
  ('user_deposits','User Deposits','Money in',170,false),
  ('cash_deposit_codes','Cash Deposit Codes','Money in',180,false),
  ('auto_credit_review','Auto-Credit Review','Money in',190,false),
  ('manual_float_credit','Manual Float Credit','Money in',200,false),
  ('deposit_conflicts','Deposit Conflicts','Money in',210,false),
  ('top_up_audit_log','Top-Up Audit Log','Money in',220,false),
  ('momo_thank_you_sms','MoMo Thank-You SMS','Money in',230,false),
  ('withdrawal_approvals','Withdrawal Approvals','Withdrawals & payouts',240,false),
  ('wallet_ops_queue','Wallet Ops Queue','Withdrawals & payouts',250,false),
  ('withdrawal_history','Withdrawal History','Withdrawals & payouts',260,false),
  ('stale_withdrawal_holds','Stale Withdrawal Holds','Withdrawals & payouts',270,false),
  ('unverified_withdrawals','Unverified Withdrawals','Withdrawals & payouts',280,false),
  ('funded_landlords_tenants','Funded Landlords & Tenants','Withdrawals & payouts',290,false),
  ('verify_payout_numbers','Verify Payout Numbers','Withdrawals & payouts',300,false),
  ('withdrawal_number_changes','Withdrawal Number Changes','Withdrawals & payouts',310,false),
  ('bank_account_changes','Bank Account Changes','Withdrawals & payouts',320,false),
  ('payout_auto_match_audit','Payout Auto-Match Audit','Withdrawals & payouts',330,false),
  ('payout_reconciliation','Payout Reconciliation','Withdrawals & payouts',340,false),
  ('proxy_withdrawal_diagnostics','Proxy Withdrawal Diagnostics','Withdrawals & payouts',350,false),
  ('merchant_agent_activity','Merchant Agent Activity','Merchant agents',360,false),
  ('merchant_agents','Merchant Agents','Merchant agents',370,false),
  ('merchant_float_requests','Merchant Float Requests','Merchant agents',380,false),
  ('merchant_float_requisitions','Merchant Float Requisitions','Merchant agents',390,false),
  ('manual_requisition_review','Manual Requisition Review','Merchant agents',400,false),
  ('manual_requisition_links','Manual Requisition Links','Merchant agents',410,false),
  ('merchant_claims_log','Merchant Claims Log','Merchant agents',420,false),
  ('cash_out_settlement_timeline','Cash-Out Settlement Timeline','Merchant agents',430,false),
  ('float_allocation_report','Float Allocation Report','Merchant agents',440,false),
  ('agents_saying_their_balance_is_wrong','Agents Saying Their Balance Is Wrong','Merchant agents',450,false),
  ('own_money_used_review','Own Money Used: Review','Merchant agents',460,false),
  ('user_wallet_statements','User Wallet Statements','Records & audit',470,false),
  ('how_did_they_earn','How Did They Earn?','Records & audit',480,false),
  ('receipt_archive','Receipt Archive','Records & audit',490,false),
  ('transaction_search','Transaction Search','Records & audit',500,false),
  ('audit_trail','Audit Trail','Records & audit',510,false),
  ('reconciliation','Reconciliation','Records & audit',520,false),
  ('reconciliation_review','Reconciliation Review','Records & audit',530,false),
  ('withdrawal_notification_log','Withdrawal Notification Log','Records & audit',540,false),
  ('sms_delivery_log','SMS Delivery Log','Records & audit',550,false),
  ('provider_mismatch_metrics','Provider Mismatch Metrics','Records & audit',560,false),
  ('debit_attempt_audit','Debit Attempt Audit','Records & audit',570,false),
  ('track_a_receipt','Track a Receipt','Records & audit',580,false),
  ('float','Float we hold (all merchant float figures)','Overview & planning',5,true)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, grp = EXCLUDED.grp, sort = EXCLUDED.sort, enforced = EXCLUDED.enforced;

-- Any catalog key is allowed as an area now.
ALTER TABLE public.financial_ops_restrictions DROP CONSTRAINT IF EXISTS financial_ops_restrictions_area_check;

CREATE OR REPLACE FUNCTION public.list_financial_ops_features()
RETURNS TABLE(key text, label text, grp text, sort integer, enforced boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT f.key, f.label, f.grp, f.sort, f.enforced FROM public.financial_ops_features f ORDER BY f.grp, f.sort;
END;
$function$;
REVOKE ALL ON FUNCTION public.list_financial_ops_features() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_financial_ops_features() TO authenticated;

-- Same function as before, but it accepts every feature in the catalog.
CREATE OR REPLACE FUNCTION public.set_financial_ops_restriction(p_user_id uuid, p_areas text[], p_reason text)
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_areas text[];
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_before text[];
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN RAISE EXCEPTION 'Choose the person first.'; END IF;
  IF public.has_role(p_user_id, 'super_admin'::app_role) THEN RAISE EXCEPTION 'A super admin cannot be restricted.'; END IF;
  SELECT COALESCE(array_agg(DISTINCT a ORDER BY a), ARRAY[]::text[]) INTO v_areas FROM unnest(COALESCE(p_areas, ARRAY[]::text[])) a;
  IF EXISTS (SELECT 1 FROM unnest(v_areas) a WHERE a NOT IN (SELECT f.key FROM public.financial_ops_features f)) THEN RAISE EXCEPTION 'Unknown feature.'; END IF;
  IF cardinality(v_areas) > 0 AND (v_reason IS NULL OR char_length(v_reason) < 5) THEN RAISE EXCEPTION 'Give the reason (who asked and why).'; END IF;

  SELECT COALESCE(array_agg(area ORDER BY area), ARRAY[]::text[]) INTO v_before
    FROM public.financial_ops_restrictions WHERE user_id = p_user_id AND lifted_at IS NULL;

  UPDATE public.financial_ops_restrictions SET lifted_at = now(), lifted_by = auth.uid()
   WHERE user_id = p_user_id AND lifted_at IS NULL AND NOT (area = ANY (v_areas));
  INSERT INTO public.financial_ops_restrictions (user_id, area, reason, created_by)
  SELECT p_user_id, a, v_reason, auth.uid() FROM unnest(v_areas) a
   WHERE NOT EXISTS (SELECT 1 FROM public.financial_ops_restrictions x WHERE x.user_id = p_user_id AND x.area = a AND x.lifted_at IS NULL);

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, old_values, new_values, reason)
  VALUES (auth.uid(), 'financial_ops_restriction_changed', 'Changed which Financial Ops features are switched off for a person', 'financial_ops_restrictions',
          p_user_id::text, jsonb_build_object('areas', v_before), jsonb_build_object('areas', v_areas), v_reason);
  RETURN v_areas;
END;
$function$;
