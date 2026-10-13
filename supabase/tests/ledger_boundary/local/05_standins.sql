-- Stand-ins for the production objects the boundary touches, created as the
-- owner so Supabase's grant-ALL default privileges apply to them exactly as
-- they do live (which is what makes the exposure reproducible here).
-- Columns are only those the boundary and COOPartnersPage use.

CREATE TABLE public.staff_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id),
  permitted_dashboard text NOT NULL, revoked_at timestamptz, UNIQUE (user_id, permitted_dashboard));
CREATE TABLE public.investor_portfolios (
  id uuid PRIMARY KEY, investor_id uuid REFERENCES public.profiles(id),
  investment_amount numeric NOT NULL, roi_percentage numeric NOT NULL DEFAULT 15,
  total_roi_earned numeric DEFAULT 0, next_roi_date date);
CREATE TABLE public.proxy_agent_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), beneficiary_id uuid, agent_id uuid,
  is_active boolean, approval_status text, is_managed_account boolean, created_at timestamptz DEFAULT now());

-- RECORDING stand-in for the ledger function: same signature, SECURITY
-- DEFINER, idempotent on the key, refuses unbalanced legs. Not the real ledger.
CREATE TABLE public.ledger_capture (
  group_id uuid PRIMARY KEY, entries jsonb, idempotency_key text, skip_balance_check boolean);
CREATE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL, skip_balance_check boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g uuid; i numeric; o numeric;
BEGIN
  IF idempotency_key IS NOT NULL THEN
    SELECT lc.group_id INTO g FROM public.ledger_capture lc WHERE lc.idempotency_key = create_ledger_transaction.idempotency_key;
    IF g IS NOT NULL THEN RETURN g; END IF;
  END IF;
  SELECT coalesce(sum((e->>'amount')::numeric) FILTER (WHERE e->>'direction'='cash_in'),0),
         coalesce(sum((e->>'amount')::numeric) FILTER (WHERE e->>'direction'='cash_out'),0)
    INTO i, o FROM jsonb_array_elements(entries) e;
  IF i <> o THEN RAISE EXCEPTION 'Transaction not balanced'; END IF;
  g := gen_random_uuid();
  INSERT INTO public.ledger_capture VALUES (g, entries, idempotency_key, skip_balance_check);
  RETURN g;
END $$;
-- a "legacy" 4-argument overload, to prove every overload is closed
CREATE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text, skip_balance_check boolean, p_legacy text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.create_ledger_transaction(entries, idempotency_key, skip_balance_check) $$;
CREATE FUNCTION public.create_ledger_transaction_accrual_only(entries jsonb)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.create_ledger_transaction(entries) $$;
GRANT EXECUTE ON FUNCTION public.create_ledger_transaction_accrual_only(jsonb) TO service_role, authenticated;
-- an existing owner-run SQL function that posts (like the ~77 in the repo)
CREATE FUNCTION public.existing_definer_poster()
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.create_ledger_transaction(
    '[{"user_id":null,"direction":"cash_in","amount":5},{"user_id":null,"direction":"cash_out","amount":5}]'::jsonb) $$;
