-- Minimal stand-in schema for the portfolio Return hold tests (run_hold_tests.mjs). LOCAL, THROWAWAY DATABASE ONLY.
-- Only the columns and functions migration 20261024160000_portfolio_return_hold touches are modelled.
-- merge_paidout_topups is NOT stubbed: the test loads its verbatim production body from the rollback file, so the
-- migration's fingerprint precondition runs against the same definition production has.
-- `wallets` is a test-only tally of wallet legs so a test can prove whether money would have moved.

DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL, enabled boolean DEFAULT true);

CREATE TABLE public.investor_portfolios (
  id uuid PRIMARY KEY, investor_id uuid NOT NULL, agent_id uuid, portfolio_code text, account_name text,
  investment_amount numeric NOT NULL, roi_percentage numeric NOT NULL DEFAULT 15, roi_mode text DEFAULT 'monthly_payout',
  next_roi_date date, total_roi_earned numeric DEFAULT 0, payout_day integer, status text DEFAULT 'active',
  duration_months integer DEFAULT 12, maturity_date date, auto_reinvest boolean DEFAULT false,
  created_at timestamptz DEFAULT now());

CREATE TABLE public.general_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  transaction_date timestamptz DEFAULT now(), amount numeric NOT NULL, direction text NOT NULL, category text NOT NULL,
  description text, reference_id text, user_id uuid, linked_party text, source_table text, source_id uuid,
  transaction_group_id uuid, ledger_scope text, currency text DEFAULT 'UGX', idempotency_key text,
  recipient_type text, wallet_bucket text);

CREATE TABLE public.pending_wallet_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, amount numeric, direction text, category text,
  description text, source_table text, source_id uuid, reference_id text, status text DEFAULT 'pending',
  reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz DEFAULT now(), metadata jsonb DEFAULT '{}'::jsonb,
  operation_type text DEFAULT 'standard');

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_type text NOT NULL, table_name text,
  record_id text, metadata jsonb, created_at timestamptz DEFAULT now(), action text, reason text);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text, message text, type text, metadata jsonb);

CREATE TABLE public.wallets (user_id uuid PRIMARY KEY, withdrawable numeric NOT NULL DEFAULT 0);
CREATE FUNCTION public.tally_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ledger_scope = 'wallet' AND NEW.user_id IS NOT NULL THEN
    INSERT INTO public.wallets (user_id, withdrawable)
    VALUES (NEW.user_id, CASE WHEN NEW.direction = 'cash_in' THEN NEW.amount ELSE -NEW.amount END)
    ON CONFLICT (user_id) DO UPDATE SET withdrawable = public.wallets.withdrawable
      + CASE WHEN NEW.direction = 'cash_in' THEN NEW.amount ELSE -NEW.amount END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_tally_wallet AFTER INSERT ON public.general_ledger FOR EACH ROW EXECUTE FUNCTION public.tally_wallet();

-- Production keeps idempotency and balance checks; the hold tests only need atomic multi-leg posting.
CREATE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL, skip_balance_check boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_group uuid := gen_random_uuid(); e jsonb;
BEGIN
  FOR e IN SELECT * FROM jsonb_array_elements(entries) LOOP
    INSERT INTO public.general_ledger (transaction_group_id, user_id, amount, direction, category, ledger_scope,
      description, source_table, source_id, idempotency_key, wallet_bucket, transaction_date)
    VALUES (v_group, nullif(e->>'user_id', '')::uuid, (e->>'amount')::numeric, e->>'direction', e->>'category',
      coalesce(e->>'ledger_scope', 'wallet'), e->>'description', e->>'source_table', nullif(e->>'source_id', '')::uuid,
      create_ledger_transaction.idempotency_key, e->>'wallet_bucket', coalesce((e->>'transaction_date')::timestamptz, now()));
  END LOOP;
  RETURN v_group;
END $$;
REVOKE EXECUTE ON FUNCTION public.create_ledger_transaction(jsonb, text, boolean) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.is_cfo_approver(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'cfo' AND coalesce(enabled, true)) $$;
CREATE FUNCTION public.staff_mfa_ok() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
-- Production: true when a parked top-up's money has actually been received.
CREATE FUNCTION public.topup_op_is_funded(p_status text, p_metadata jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS
$$ SELECT coalesce((p_metadata->>'funded')::boolean, true) $$;

GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
GRANT SELECT, UPDATE, DELETE ON public.investor_portfolios TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.pending_wallet_operations TO authenticated;
GRANT SELECT ON public.general_ledger, public.user_roles, public.audit_logs TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_cfo_approver(uuid), public.staff_mfa_ok() TO authenticated;
