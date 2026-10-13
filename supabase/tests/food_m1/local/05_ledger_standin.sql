-- LOCAL STAND-IN for the shared ledger objects the Food payment path uses.
-- Loaded by run.sh and race.sh AFTER the Food migrations, into disposable
-- databases only. It mirrors the repo semantics of
-- create_ledger_transaction (20260914180000): balanced legs, an advisory lock
-- plus "existing key returns the existing group", and the withdrawable balance
-- check with the same error text. It is NOT the production ledger: tests that
-- pass against it prove the Food logic, not the live ledger's internals.
CREATE SCHEMA IF NOT EXISTS ledger_test;
GRANT USAGE ON SCHEMA ledger_test TO anon, authenticated, service_role;

CREATE TABLE public.wallets_physical (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id));
CREATE TABLE public.general_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_group_id uuid, user_id uuid, amount numeric NOT NULL,
  direction text NOT NULL CHECK (direction IN ('cash_in','cash_out')),
  category text NOT NULL, ledger_scope text, wallet_bucket text, recipient_type text,
  source_table text NOT NULL, source_id uuid, reference_id text, description text,
  idempotency_key text, skip_balance_check boolean, created_at timestamptz DEFAULT now());
-- test funding: an opening withdrawable balance per user
CREATE TABLE ledger_test.opening (user_id uuid PRIMARY KEY, amount numeric NOT NULL);
-- test switch: 'normal' | 'short' (posts only the first leg) | 'skew' (wrong amount)
CREATE TABLE ledger_test.mode (m text NOT NULL);
INSERT INTO ledger_test.mode VALUES ('normal');
GRANT ALL ON ALL TABLES IN SCHEMA ledger_test TO authenticated, service_role;

CREATE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL, skip_balance_check boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g uuid; v_in numeric; v_out numeric; e jsonb; bal numeric; m text; n int := 0;
BEGIN
  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    PERFORM pg_advisory_xact_lock(abs(hashtext(idempotency_key)));
    SELECT gl.transaction_group_id INTO g FROM public.general_ledger gl
     WHERE gl.idempotency_key = create_ledger_transaction.idempotency_key LIMIT 1;
    IF g IS NOT NULL THEN RETURN g; END IF;
  END IF;
  SELECT coalesce(sum((x->>'amount')::numeric) FILTER (WHERE x->>'direction'='cash_in'),0),
         coalesce(sum((x->>'amount')::numeric) FILTER (WHERE x->>'direction'='cash_out'),0)
    INTO v_in, v_out FROM jsonb_array_elements(entries) x;
  IF v_in <> v_out THEN
    RAISE EXCEPTION 'Transaction not balanced. Total cash_in (%) <> total cash_out (%)', v_in, v_out; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(entries) LOOP
    IF NOT skip_balance_check AND e->>'direction' = 'cash_out' AND e->>'ledger_scope' = 'wallet'
       AND (e->>'user_id') IS NOT NULL AND coalesce(e->>'wallet_bucket','withdrawable') = 'withdrawable' THEN
      SELECT coalesce((SELECT amount FROM ledger_test.opening o WHERE o.user_id = (e->>'user_id')::uuid), 0)
           + coalesce(sum(CASE WHEN gl.direction='cash_in' THEN gl.amount ELSE -gl.amount END), 0)
        INTO bal FROM public.general_ledger gl
       WHERE gl.user_id = (e->>'user_id')::uuid AND gl.ledger_scope = 'wallet';
      IF bal < (e->>'amount')::numeric THEN
        RAISE EXCEPTION 'Insufficient ledger balance for user %. Available: %, Required: %',
          e->>'user_id', bal, e->>'amount';
      END IF;
    END IF;
  END LOOP;
  g := gen_random_uuid();
  SELECT lm.m INTO m FROM ledger_test.mode lm LIMIT 1;
  FOR e IN SELECT * FROM jsonb_array_elements(entries) LOOP
    n := n + 1;
    CONTINUE WHEN m = 'short' AND n > 1;
    INSERT INTO public.general_ledger (transaction_group_id, user_id, amount, direction, category, ledger_scope,
      wallet_bucket, recipient_type, source_table, source_id, reference_id, description, idempotency_key, skip_balance_check)
    VALUES (g, (e->>'user_id')::uuid,
            (e->>'amount')::numeric + CASE WHEN m = 'skew' AND n = 2 THEN 1 ELSE 0 END,
            e->>'direction', e->>'category', e->>'ledger_scope', e->>'wallet_bucket', e->>'recipient_type',
            e->>'source_table', (e->>'source_id')::uuid, e->>'reference_id', e->>'description',
            create_ledger_transaction.idempotency_key, create_ledger_transaction.skip_balance_check);
  END LOOP;
  RETURN g;
END $$;
-- as the production boundary (20261013126000) leaves it: not callable by users
REVOKE ALL ON FUNCTION public.create_ledger_transaction(jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_ledger_transaction(jsonb, text, boolean) TO service_role;

-- ── wallet gates and Agent Advance objects (stand-ins; see 49_advance_integration.sql) ──
-- treasury_controls: the repo columns food_pay_order reads (20260409135413 + value text)
CREATE TABLE public.treasury_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), control_key text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false, value text);
-- agent_advances: the columns get_agent_sweepable_withdrawable (20260719161607) reads
CREATE TABLE public.agent_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL,
  status text NOT NULL, outstanding_balance numeric NOT NULL, issued_at timestamptz NOT NULL DEFAULT now());
-- test inputs for the canonical spendable figure
CREATE TABLE ledger_test.hold (user_id uuid PRIMARY KEY, amount numeric NOT NULL);           -- funder_pending_hold
CREATE TABLE ledger_test.advance_locked (user_id uuid PRIMARY KEY, amount numeric NOT NULL); -- get_advance_locked_withdrawable
CREATE TABLE ledger_test.avail_bonus (user_id uuid PRIMARY KEY, amount numeric NOT NULL);    -- a stale-high projection
GRANT ALL ON ALL TABLES IN SCHEMA ledger_test TO authenticated, service_role;

-- get_user_available_balance, same shape as the repo (20260824072654):
-- GREATEST(0, withdrawable - funder_pending_hold - CASE advance_withdrawals_paused
-- THEN get_advance_locked_withdrawable END). Withdrawable here is the stand-in ledger.
CREATE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(0::numeric,
      coalesce((SELECT amount FROM ledger_test.opening WHERE user_id = p_user_id), 0)
    + coalesce((SELECT sum(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END)
                  FROM public.general_ledger WHERE user_id = p_user_id AND ledger_scope = 'wallet'), 0)
    + coalesce((SELECT amount FROM ledger_test.avail_bonus WHERE user_id = p_user_id), 0)
    - coalesce((SELECT amount FROM ledger_test.hold WHERE user_id = p_user_id), 0)
    - CASE WHEN coalesce((SELECT enabled FROM public.treasury_controls
                           WHERE control_key = 'advance_withdrawals_paused'), false)
           THEN coalesce((SELECT amount FROM ledger_test.advance_locked WHERE user_id = p_user_id), 0)
           ELSE 0 END);
$$;
REVOKE ALL ON FUNCTION public.get_user_available_balance(uuid) FROM PUBLIC, anon, authenticated;

-- ── what check_transfer_recipient_eligibility (drizzle/migrations/0045, loaded
-- verbatim by run.sh and race.sh) reads: profiles.is_frozen and public.wallets ──
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_frozen boolean DEFAULT false;
CREATE VIEW public.wallets AS SELECT user_id FROM public.wallets_physical;

-- ── what the standard reversal (drizzle/migrations/0451 reverse_wallet_transfer,
-- 0453 wallet_transfer_reversal_status; loaded verbatim by run.sh) writes or reads ──
CREATE TABLE public.system_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text, user_id uuid, related_entity_type text,
  metadata jsonb, actor_id uuid, subject_id uuid, source text, created_at timestamptz DEFAULT now());
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text, message text, type text,
  metadata jsonb, event_key text, link_path text, created_at timestamptz DEFAULT now());
CREATE TABLE public.withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, amount numeric,
  status text, created_at timestamptz NOT NULL DEFAULT now());
