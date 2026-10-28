-- Isolated PostgreSQL fixture only. Never load this schema into a connected project.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA net; CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets(name text,decrypted_secret text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user',true),'')::uuid $$;
CREATE FUNCTION public.staff_mfa_ok() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.can_review_bike_leases(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION public.can_view_finance_reports(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE public.profiles(id uuid PRIMARY KEY,is_test boolean,full_name text);
CREATE TABLE public.treasury_controls(control_key text PRIMARY KEY,enabled boolean,value text);
CREATE TABLE public.user_roles(user_id uuid,role text,enabled boolean);
CREATE TABLE public.test_wallet(user_id uuid PRIMARY KEY,withdrawable numeric,float_balance numeric DEFAULT 99000,protected numeric DEFAULT 0);
CREATE FUNCTION public.get_user_available_balance(uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT withdrawable FROM public.test_wallet WHERE user_id=$1 $$;
CREATE FUNCTION public.get_agent_sweepable_withdrawable(uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT greatest(withdrawable-protected,0) FROM public.test_wallet WHERE user_id=$1 $$;
CREATE FUNCTION public.refresh_wallet_projection_for(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE TABLE public.merchandise_recovery_plans(
 id uuid PRIMARY KEY,customer_id uuid,sale_id uuid,item_name text,status text DEFAULT 'active',outstanding_balance numeric,
 is_bike_lease boolean DEFAULT true,recovery_hold boolean DEFAULT false,starts_on date,pricing_basis text DEFAULT 'spiro_28pct_v2',
 created_at timestamptz DEFAULT now(),updated_at timestamptz,last_attempt_result text,
 recovery_started_on date,due_accrued_through date,due_balance numeric DEFAULT 0,term_end_on date,
 miss_alert_sent boolean DEFAULT false,catchup_sms_pending jsonb,catchup_sms_sent_on date,
 fee_total numeric DEFAULT 100000,fee_recovered numeric DEFAULT 0,principal_recovered numeric DEFAULT 0,
 amount_recovered numeric DEFAULT 0,last_success_on date,last_attempt_on date,last_bike_recovery_on date,
 last_recovery_at timestamptz,completed_at timestamptz,test_daily numeric DEFAULT 3917,test_eligible boolean DEFAULT true);
CREATE TABLE public.merchandise_recovery_deductions(id uuid DEFAULT gen_random_uuid(),plan_id uuid,customer_id uuid,item_name text,
 amount numeric,withdrawable_before numeric,outstanding_after numeric,transaction_ref uuid,created_at timestamptz DEFAULT now());
CREATE TABLE public.merchandise_sales(id uuid PRIMARY KEY,amount_paid numeric DEFAULT 0,amount_outstanding numeric,payment_status text,updated_at timestamptz);
CREATE TABLE public.agent_advances(id uuid PRIMARY KEY,agent_id uuid,status text DEFAULT 'active',outstanding_balance numeric,arrears_balance numeric DEFAULT 0,
 deduction_paused boolean DEFAULT false,recovery_source text DEFAULT 'wallet_daily',issued_at timestamptz DEFAULT now()-interval '5 days',expires_at timestamptz DEFAULT now()+interval '30 days',
 principal numeric DEFAULT 100000,access_fee numeric DEFAULT 0,access_fee_collected numeric DEFAULT 0,access_fee_status text,
 updated_at timestamptz,prepaid_installments_remaining integer DEFAULT 0,repayment_frequency text DEFAULT 'daily',cycle_days int DEFAULT 30,installment_amount numeric DEFAULT 10000);
CREATE TABLE public.agent_advance_ledger(advance_id uuid,date date,opening_balance numeric,interest_accrued numeric,amount_deducted numeric,closing_balance numeric,deduction_status text);
CREATE TABLE public.notifications(user_id uuid,title text,message text,type text,metadata jsonb,link_path text);
CREATE TABLE public.system_events(event_type text,user_id uuid,related_entity_type text,related_entity_id uuid,metadata jsonb);
CREATE TABLE public.test_postings(id uuid DEFAULT gen_random_uuid(),entries jsonb,idempotency_key text UNIQUE);
CREATE FUNCTION public._merch_bike_day(uuid,boolean,date) RETURNS TABLE(daily numeric,fee_ratio numeric,term_end date,active boolean)
 LANGUAGE sql AS $$ SELECT test_daily,0.28::numeric,coalesce(starts_on,$3)+360,$3>=coalesce(starts_on,$3)
 FROM public.merchandise_recovery_plans WHERE sale_id=$1 $$;
CREATE FUNCTION public.merchandise_plan_recovery_eligible(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT test_eligible FROM public.merchandise_recovery_plans WHERE id=$1 $$;
CREATE FUNCTION public.merchandise_plan_ineligible_reason(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'test ineligible'::text $$;
CREATE FUNCTION public.advance_period_days(text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION public.advance_installment_amount(numeric,numeric,int,text,numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT $5 $$;
CREATE FUNCTION public.advance_expected_repaid_to_date(timestamptz,numeric,numeric,int,text,numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT 50000::numeric $$;
CREATE FUNCTION public.agent_advance_is_post_effective(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.agent_advance_allocation_entries(uuid,uuid,numeric,timestamptz,boolean) RETURNS jsonb LANGUAGE sql AS $$ SELECT null::jsonb $$;
CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE FUNCTION public.create_ledger_transaction(entries jsonb,idempotency_key text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE e jsonb; n numeric; incoming numeric:=0; outgoing numeric:=0; result uuid;
BEGIN
 SELECT sum((x->>'amount')::numeric) FILTER(WHERE x->>'direction'='cash_in'),sum((x->>'amount')::numeric) FILTER(WHERE x->>'direction'='cash_out')
 INTO incoming,outgoing FROM jsonb_array_elements(entries) x;
 IF incoming IS DISTINCT FROM outgoing THEN RAISE EXCEPTION 'Unbalanced entries'; END IF;
 IF current_setting('test.fail_post',true)='yes' THEN RAISE EXCEPTION 'Injected posting failure'; END IF;
 INSERT INTO public.test_postings(entries,idempotency_key) VALUES(entries,idempotency_key) RETURNING id INTO result;
 FOR e IN SELECT * FROM jsonb_array_elements(entries) LOOP
   IF e->>'ledger_scope'='wallet' AND e->>'direction'='cash_out' THEN
     n := (e->>'amount')::numeric;
     UPDATE public.test_wallet SET withdrawable=withdrawable-n WHERE user_id=(e->>'user_id')::uuid AND withdrawable>=n;
     IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient withdrawable'; END IF;
   END IF;
 END LOOP;
 RETURN result;
END $$;