-- Synthetic local schema matching the verified relevant production columns,
-- constraints, update trigger and authorization helpers. No production data.
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TYPE public.app_role AS ENUM ('cfo','super_admin','tenant','operations');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role, enabled boolean);
CREATE TABLE public.staff_mfa_config (id boolean, mode text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('aal', current_setting('request.jwt.claim.aal', true))
$$;
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role AND enabled = true)
$$;
-- Same staff gate logic as live; JWT comes from local test settings.
CREATE FUNCTION public.staff_mfa_ok() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  select case (select c.mode from public.staff_mfa_config c where c.id)
    when 'all' then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' or not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin','admin'))
    when 'admin' then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' or not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('super_admin','ceo','cto','cfo','coo','access_admin','admin'))
    else true end
$$;
CREATE TABLE public.scheduled_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid NOT NULL,
  target_user_id uuid NOT NULL, amount numeric NOT NULL CHECK (amount > 0),
  category_id text NOT NULL, sub_category text, reason text NOT NULL,
  frequency text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('daily','weekly','monthly','interval')),
  day_of_month integer CHECK (day_of_month BETWEEN 1 AND 28), enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz, next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  day_of_week integer, interval_days integer
);
GRANT SELECT, UPDATE ON public.scheduled_payouts TO authenticated;
GRANT ALL ON public.scheduled_payouts TO service_role;
ALTER TABLE public.scheduled_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY config_read ON public.scheduled_payouts FOR SELECT TO authenticated
USING (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'super_admin'));
CREATE POLICY config_update ON public.scheduled_payouts FOR UPDATE TO authenticated
USING (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'super_admin'));
CREATE POLICY config_mfa ON public.scheduled_payouts AS RESTRICTIVE TO authenticated
USING (staff_mfa_ok()) WITH CHECK (staff_mfa_ok());
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER update_scheduled_payouts_updated_at BEFORE UPDATE ON public.scheduled_payouts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TABLE public.standing_order_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scheduled_payout_id uuid,
  action text NOT NULL CONSTRAINT standing_order_audit_log_action_check CHECK (action IN ('create','pause','resume','cancel')),
  acted_by uuid, acted_by_name text, target_user_id uuid, recipient_name text,
  amount numeric, reason text, schedule_description text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.standing_order_audit_log TO authenticated;
GRANT ALL ON public.standing_order_audit_log TO service_role;
ALTER TABLE public.standing_order_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_own ON public.standing_order_audit_log FOR INSERT TO authenticated WITH CHECK (acted_by = auth.uid());
CREATE POLICY audit_read ON public.standing_order_audit_log FOR SELECT TO authenticated USING (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'super_admin'));

-- Sentinel financial state: tests compare snapshots AND reject attempted writes.
CREATE TABLE public.wallets (id uuid, withdrawable_balance numeric, float_balance numeric, advance_balance numeric);
CREATE TABLE public.general_ledger (id uuid, amount numeric);
CREATE TABLE public.scheduled_payout_runs (id uuid, scheduled_payout_id uuid, amount numeric, ran_at timestamptz, status text);
INSERT INTO public.wallets VALUES ('00000000-0000-0000-0000-000000000001',12345,67890,25);
INSERT INTO public.general_ledger VALUES ('00000000-0000-0000-0000-000000000002',12345);
INSERT INTO public.scheduled_payout_runs VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000010',100000,'2026-10-22','completed');
CREATE FUNCTION public.reject_financial_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Forbidden financial write to %', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER no_wallet_write BEFORE INSERT OR UPDATE OR DELETE ON public.wallets FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_write();
CREATE TRIGGER no_ledger_write BEFORE INSERT OR UPDATE OR DELETE ON public.general_ledger FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_write();
CREATE TRIGGER no_run_write BEFORE INSERT OR UPDATE OR DELETE ON public.scheduled_payout_runs FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_write();
CREATE FUNCTION public.run_lunch_allowance_payouts() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Forbidden payer invocation'; END; $$;
INSERT INTO public.staff_mfa_config VALUES (true, 'all');
INSERT INTO public.user_roles VALUES
 ('00000000-0000-0000-0000-000000000001','cfo',true),
 ('00000000-0000-0000-0000-000000000002','super_admin',true),
 ('00000000-0000-0000-0000-000000000003','tenant',true),
 ('00000000-0000-0000-0000-000000000004','cfo',false);
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-000000000001','Local CFO'),('00000000-0000-0000-0000-000000000005','Local Recipient');
INSERT INTO public.scheduled_payouts(id,created_by,target_user_id,amount,category_id,reason,frequency,day_of_month,enabled,last_run_at,next_run_at,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005',100000,'lunch_allowance','Local fixture only','daily',NULL,true,'2026-10-22','2026-10-23','2026-10-01','2026-10-01');