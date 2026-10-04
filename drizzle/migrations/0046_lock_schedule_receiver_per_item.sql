-- One locked receiver per Welile item, per user.
ALTER TABLE public.wallet_transfer_schedules
  ADD COLUMN IF NOT EXISTS recipient_locked_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transfer_schedules_one_per_item
  ON public.wallet_transfer_schedules (user_id, lower(btrim(description)))
  WHERE status IN ('active','paused','pending_approval');

CREATE OR REPLACE FUNCTION public.create_wallet_transfer_schedule(p_recipient_id uuid, p_amount numeric, p_frequency text, p_day_of_week smallint DEFAULT NULL::smallint, p_day_of_month smallint DEFAULT NULL::smallint, p_description text DEFAULT NULL::text)
 RETURNS wallet_transfer_schedules
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_cap numeric;
  v_status text;
  v_row public.wallet_transfer_schedules;
  v_item text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_check record;
  v_existing record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000000 THEN
    RAISE EXCEPTION 'Amount must be between 1 and 100,000,000';
  END IF;
  IF p_frequency NOT IN ('daily','weekly','monthly') THEN
    RAISE EXCEPTION 'Frequency must be daily, weekly or monthly';
  END IF;
  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Pick what you are sending (Welile Rent, Welile Bread, ...)';
  END IF;

  SELECT * INTO v_check
  FROM public.check_transfer_recipient_eligibility(p_recipient_id, v_item, v_uid);

  IF NOT COALESCE(v_check.eligible, false) THEN
    RAISE EXCEPTION '%', COALESCE(v_check.reason, 'This receiver cannot be paid');
  END IF;

  -- The receiver for an item is locked until the owner changes it.
  SELECT s.id INTO v_existing
  FROM public.wallet_transfer_schedules s
  WHERE s.user_id = v_uid
    AND lower(btrim(COALESCE(s.description,''))) = lower(v_item)
    AND s.status IN ('active','paused','pending_approval')
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION '% is already set up. Change the receiver on the existing one, or stop it first.', v_item;
  END IF;

  IF (SELECT count(*) FROM public.wallet_transfer_schedules
      WHERE user_id = v_uid AND status IN ('active','paused','pending_approval')) >= 20 THEN
    RAISE EXCEPTION 'You already have 20 automatic transfers. Cancel one first.';
  END IF;

  SELECT auto_approval_cap INTO v_cap FROM public.wallet_transfer_schedule_config WHERE id;
  v_status := CASE WHEN p_amount <= COALESCE(v_cap, 0) THEN 'active' ELSE 'pending_approval' END;

  INSERT INTO public.wallet_transfer_schedules (
    user_id, recipient_id, amount, description, frequency,
    day_of_week, day_of_month, status, next_run_at, recipient_locked_at
  ) VALUES (
    v_uid, p_recipient_id, p_amount, v_item, p_frequency,
    CASE WHEN p_frequency = 'weekly' THEN COALESCE(p_day_of_week, 1) END,
    CASE WHEN p_frequency = 'monthly' THEN COALESCE(p_day_of_month, 1) END,
    v_status,
    CASE WHEN v_status = 'active'
      THEN public.wallet_transfer_schedule_next_run(p_frequency, p_day_of_week, p_day_of_month, now())
    END,
    now()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END $function$;

-- Owner-only receiver swap: re-checks eligibility and re-locks.
CREATE OR REPLACE FUNCTION public.change_wallet_transfer_schedule_recipient(p_schedule_id uuid, p_recipient_id uuid)
 RETURNS wallet_transfer_schedules
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.wallet_transfer_schedules;
  v_check record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_row
  FROM public.wallet_transfer_schedules
  WHERE id = p_schedule_id AND user_id = v_uid
  FOR UPDATE;

  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Automatic transfer not found'; END IF;
  IF v_row.status = 'cancelled' THEN RAISE EXCEPTION 'This automatic transfer was stopped'; END IF;
  IF p_recipient_id = v_row.recipient_id THEN RETURN v_row; END IF;

  SELECT * INTO v_check
  FROM public.check_transfer_recipient_eligibility(p_recipient_id, NULLIF(btrim(COALESCE(v_row.description,'')), ''), v_uid);

  IF NOT COALESCE(v_check.eligible, false) THEN
    RAISE EXCEPTION '%', COALESCE(v_check.reason, 'This receiver cannot be paid');
  END IF;

  UPDATE public.wallet_transfer_schedules
     SET recipient_id = p_recipient_id,
         recipient_locked_at = now(),
         last_error = NULL,
         consecutive_failures = 0,
         updated_at = now()
   WHERE id = p_schedule_id
  RETURNING * INTO v_row;

  RETURN v_row;
END $function$;

REVOKE ALL ON FUNCTION public.change_wallet_transfer_schedule_recipient(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.change_wallet_transfer_schedule_recipient(uuid, uuid) TO authenticated;