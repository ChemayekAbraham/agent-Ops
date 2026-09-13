-- Automated (recurring) wallet transfers from the withdrawable bucket.
-- No wallet/ledger mutation lives here: the runner calls the existing
-- wallet-transfer edge function, which is the only money-moving path.

CREATE TABLE IF NOT EXISTS public.wallet_transfer_schedule_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  auto_approval_cap numeric NOT NULL DEFAULT 200000 CHECK (auto_approval_cap >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.wallet_transfer_schedule_config TO authenticated;
GRANT ALL ON public.wallet_transfer_schedule_config TO service_role;
ALTER TABLE public.wallet_transfer_schedule_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated can read auto payout cap" ON public.wallet_transfer_schedule_config;
CREATE POLICY "Authenticated can read auto payout cap"
  ON public.wallet_transfer_schedule_config FOR SELECT TO authenticated USING (true);
INSERT INTO public.wallet_transfer_schedule_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.wallet_transfer_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  description text,
  frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  day_of_week smallint CHECK (day_of_week BETWEEN 1 AND 7),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 28),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','pending_approval','cancelled')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  runs_completed integer NOT NULL DEFAULT 0,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_wts_due ON public.wallet_transfer_schedules (next_run_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_wts_user ON public.wallet_transfer_schedules (user_id);

GRANT SELECT ON public.wallet_transfer_schedules TO authenticated;
GRANT ALL ON public.wallet_transfer_schedules TO service_role;
ALTER TABLE public.wallet_transfer_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own auto payouts" ON public.wallet_transfer_schedules;
CREATE POLICY "Users view own auto payouts"
  ON public.wallet_transfer_schedules FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'cfo')
         OR public.has_role(auth.uid(), 'super_admin')
         OR public.has_role(auth.uid(), 'manager')
         OR public.has_role(auth.uid(), 'financial_ops'));

CREATE TABLE IF NOT EXISTS public.wallet_transfer_schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.wallet_transfer_schedules(id) ON DELETE CASCADE,
  run_key text NOT NULL,
  amount numeric NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error_text text,
  ran_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, run_key)
);
GRANT SELECT ON public.wallet_transfer_schedule_runs TO authenticated;
GRANT ALL ON public.wallet_transfer_schedule_runs TO service_role;
ALTER TABLE public.wallet_transfer_schedule_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users view own auto payout runs" ON public.wallet_transfer_schedule_runs;
CREATE POLICY "Users view own auto payout runs"
  ON public.wallet_transfer_schedule_runs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.wallet_transfer_schedules s
                 WHERE s.id = schedule_id
                   AND (s.user_id = auth.uid()
                        OR public.has_role(auth.uid(), 'cfo')
                        OR public.has_role(auth.uid(), 'super_admin')
                        OR public.has_role(auth.uid(), 'manager')
                        OR public.has_role(auth.uid(), 'financial_ops'))));

-- Single-flight lease for the runner.
CREATE TABLE IF NOT EXISTS public.wallet_transfer_schedule_locks (
  name text PRIMARY KEY,
  leased_until timestamptz NOT NULL
);
GRANT ALL ON public.wallet_transfer_schedule_locks TO service_role;
ALTER TABLE public.wallet_transfer_schedule_locks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.wallet_transfer_schedule_next_run(
  _frequency text, _day_of_week smallint, _day_of_month smallint, _from timestamptz
) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE base date := (_from AT TIME ZONE 'Africa/Kampala')::date; cand date;
BEGIN
  IF _frequency = 'daily' THEN
    cand := base + 1;
  ELSIF _frequency = 'weekly' THEN
    cand := base + 1;
    WHILE EXTRACT(ISODOW FROM cand)::int <> COALESCE(_day_of_week, 1) LOOP
      cand := cand + 1;
    END LOOP;
  ELSE
    cand := (date_trunc('month', base::timestamp))::date + (COALESCE(_day_of_month, 1) - 1);
    IF cand <= base THEN
      cand := (date_trunc('month', base::timestamp) + interval '1 month')::date
              + (COALESCE(_day_of_month, 1) - 1);
    END IF;
  END IF;
  RETURN ((cand::timestamp + interval '7 hours') AT TIME ZONE 'Africa/Kampala');
END $$;

CREATE OR REPLACE FUNCTION public.create_wallet_transfer_schedule(
  p_recipient_id uuid,
  p_amount numeric,
  p_frequency text,
  p_day_of_week smallint DEFAULT NULL,
  p_day_of_month smallint DEFAULT NULL,
  p_description text DEFAULT NULL
) RETURNS public.wallet_transfer_schedules
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cap numeric;
  v_status text;
  v_row public.wallet_transfer_schedules;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_recipient_id IS NULL OR p_recipient_id = v_uid THEN
    RAISE EXCEPTION 'Pick a recipient other than yourself';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000000 THEN
    RAISE EXCEPTION 'Amount must be between 1 and 100,000,000';
  END IF;
  IF p_frequency NOT IN ('daily','weekly','monthly') THEN
    RAISE EXCEPTION 'Frequency must be daily, weekly or monthly';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_recipient_id) THEN
    RAISE EXCEPTION 'Recipient does not have a Welile account';
  END IF;
  IF (SELECT count(*) FROM public.wallet_transfer_schedules
      WHERE user_id = v_uid AND status IN ('active','paused','pending_approval')) >= 20 THEN
    RAISE EXCEPTION 'You already have 20 automatic transfers. Cancel one first.';
  END IF;

  SELECT auto_approval_cap INTO v_cap FROM public.wallet_transfer_schedule_config WHERE id;
  v_status := CASE WHEN p_amount <= COALESCE(v_cap, 0) THEN 'active' ELSE 'pending_approval' END;

  INSERT INTO public.wallet_transfer_schedules (
    user_id, recipient_id, amount, description, frequency,
    day_of_week, day_of_month, status, next_run_at
  ) VALUES (
    v_uid, p_recipient_id, p_amount, NULLIF(btrim(COALESCE(p_description, '')), ''), p_frequency,
    CASE WHEN p_frequency = 'weekly' THEN COALESCE(p_day_of_week, 1) END,
    CASE WHEN p_frequency = 'monthly' THEN COALESCE(p_day_of_month, 1) END,
    v_status,
    CASE WHEN v_status = 'active'
      THEN public.wallet_transfer_schedule_next_run(p_frequency, p_day_of_week, p_day_of_month, now())
    END
  ) RETURNING * INTO v_row;

  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.set_wallet_transfer_schedule_state(
  p_schedule_id uuid, p_state text
) RETURNS public.wallet_transfer_schedules
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row public.wallet_transfer_schedules;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_state NOT IN ('active','paused','cancelled') THEN
    RAISE EXCEPTION 'Unsupported state';
  END IF;
  SELECT * INTO v_row FROM public.wallet_transfer_schedules
    WHERE id = p_schedule_id AND user_id = v_uid FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Automatic transfer not found'; END IF;
  IF v_row.status = 'cancelled' THEN RAISE EXCEPTION 'This automatic transfer is already cancelled'; END IF;
  IF p_state = 'active' AND v_row.status = 'pending_approval' THEN
    RAISE EXCEPTION 'This automatic transfer is still waiting for approval';
  END IF;

  UPDATE public.wallet_transfer_schedules SET
    status = p_state,
    next_run_at = CASE WHEN p_state = 'active'
      THEN public.wallet_transfer_schedule_next_run(frequency, day_of_week, day_of_month, now())
      ELSE NULL END,
    updated_at = now()
  WHERE id = p_schedule_id
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.approve_wallet_transfer_schedule(
  p_schedule_id uuid, p_approve boolean, p_reason text
) RETURNS public.wallet_transfer_schedules
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row public.wallet_transfer_schedules;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
          OR public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'manager')) THEN
    RAISE EXCEPTION 'Not authorised to approve automatic transfers';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A written reason of at least 10 characters is required';
  END IF;
  SELECT * INTO v_row FROM public.wallet_transfer_schedules
    WHERE id = p_schedule_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Automatic transfer not found'; END IF;
  IF v_row.status <> 'pending_approval' THEN RAISE EXCEPTION 'This automatic transfer is not awaiting approval'; END IF;
  IF v_row.user_id = v_uid THEN RAISE EXCEPTION 'You cannot approve your own automatic transfer'; END IF;

  UPDATE public.wallet_transfer_schedules SET
    status = CASE WHEN p_approve THEN 'active' ELSE 'cancelled' END,
    approved_by = v_uid,
    approved_at = now(),
    next_run_at = CASE WHEN p_approve
      THEN public.wallet_transfer_schedule_next_run(frequency, day_of_week, day_of_month, now())
      ELSE NULL END,
    updated_at = now()
  WHERE id = p_schedule_id
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  VALUES (CASE WHEN p_approve THEN 'auto_payout_approved' ELSE 'auto_payout_rejected' END,
          'wallet_transfer_schedules', p_schedule_id, v_uid, btrim(p_reason),
          jsonb_build_object('amount', v_row.amount, 'frequency', v_row.frequency));

  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.create_wallet_transfer_schedule(uuid, numeric, text, smallint, smallint, text) FROM public;
REVOKE ALL ON FUNCTION public.set_wallet_transfer_schedule_state(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.approve_wallet_transfer_schedule(uuid, boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION public.create_wallet_transfer_schedule(uuid, numeric, text, smallint, smallint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_wallet_transfer_schedule_state(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_wallet_transfer_schedule(uuid, boolean, text) TO authenticated;