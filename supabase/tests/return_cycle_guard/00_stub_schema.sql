-- Minimal stand-in schema for the Return cycle guard integration tests
-- (src/__tests__/returnCycleGuard.integration.test.ts). LOCAL, THROWAWAY DATABASE ONLY.
--
-- Only the columns and functions migration 20261024140000_return_cycle_guard touches are modelled. The two
-- functions that migration replaces (enforce_roi_cycle_once, post_portfolio_roi_ledger) are NOT stubbed here: the
-- test loads their verbatim production bodies from the migration's rollback file, so the suite starts from the
-- same state production is in. create_ledger_transaction keeps production's idempotency semantics (advisory lock on
-- the key, return the existing group without posting) but none of its balance checks.
-- `wallets` is a test-only tally of wallet legs so a test can prove how many times money would have moved.

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
  id uuid PRIMARY KEY, investor_id uuid NOT NULL, portfolio_code text, investment_amount numeric NOT NULL,
  roi_percentage numeric NOT NULL, next_roi_date date, status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(), payout_day integer, total_roi_earned numeric DEFAULT 0);

CREATE TABLE public.proxy_agent_assignments (
  beneficiary_id uuid, agent_id uuid, is_managed_account boolean, is_active boolean, approval_status text,
  created_at timestamptz DEFAULT now());

CREATE TABLE public.general_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  transaction_date timestamptz DEFAULT now(), amount numeric NOT NULL, direction text NOT NULL, category text NOT NULL,
  description text, reference_id text, user_id uuid, linked_party text, source_table text, source_id uuid,
  transaction_group_id uuid, ledger_scope text, currency text DEFAULT 'UGX', idempotency_key text,
  recipient_type text, wallet_bucket text, account text);
CREATE INDEX ON public.general_ledger (idempotency_key);

CREATE TABLE public.pending_wallet_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, amount numeric, direction text, category text,
  description text, source_table text, source_id uuid, transaction_group_id uuid, linked_party text,
  reference_id text, account text, status text DEFAULT 'pending', reviewed_by uuid, reviewed_at timestamptz,
  rejection_reason text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb, operation_type text DEFAULT 'standard', target_wallet_user_id uuid,
  payment_method text, payment_reference text);

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_type text NOT NULL, table_name text,
  record_id text, metadata jsonb, created_at timestamptz DEFAULT now(), action text, reason text);

-- Test-only tally of wallet movements.
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

-- Like production: the ledger is written only through create_ledger_transaction.
CREATE FUNCTION public.guard_ledger_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('ledger.authorized', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Unauthorized ledger write — must use create_ledger_transaction RPC';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_ledger_write BEFORE INSERT ON public.general_ledger FOR EACH ROW EXECUTE FUNCTION public.guard_ledger_write();

CREATE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL, skip_balance_check boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_group uuid; e jsonb;
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);
  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    PERFORM pg_advisory_xact_lock(abs(hashtext(idempotency_key)));
    SELECT transaction_group_id INTO v_group FROM public.general_ledger g
     WHERE g.idempotency_key = create_ledger_transaction.idempotency_key ORDER BY created_at LIMIT 1;
    IF v_group IS NOT NULL THEN RETURN v_group; END IF;
  END IF;
  v_group := gen_random_uuid();
  FOR e IN SELECT * FROM jsonb_array_elements(entries) LOOP
    INSERT INTO public.general_ledger (transaction_group_id, user_id, amount, direction, category, ledger_scope,
      description, reference_id, source_table, source_id, linked_party, idempotency_key, recipient_type, wallet_bucket,
      transaction_date)
    VALUES (v_group, nullif(e->>'user_id', '')::uuid, (e->>'amount')::numeric, e->>'direction', e->>'category',
      coalesce(e->>'ledger_scope', 'wallet'), e->>'description', e->>'reference_id', e->>'source_table',
      nullif(e->>'source_id', '')::uuid, e->>'linked_party', create_ledger_transaction.idempotency_key,
      e->>'recipient_type', e->>'wallet_bucket', coalesce((e->>'transaction_date')::timestamptz, now()));
  END LOOP;
  RETURN v_group;
END $$;
REVOKE EXECUTE ON FUNCTION public.create_ledger_transaction(jsonb, text, boolean) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.is_cfo_approver(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'cfo' AND coalesce(enabled, true)) $$;
CREATE FUNCTION public._ledger_can_post_partner_returns(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT _user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('coo', 'super_admin', 'cto') AND coalesce(enabled, true)) $$;
CREATE FUNCTION public.staff_mfa_ok() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
