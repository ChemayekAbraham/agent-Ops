-- Validates that a receiver can actually be paid a Welile item transfer.
-- Used by the transfer dialog, the automatic-payout setup RPC and the
-- scheduled runner so all three agree on one definition of "valid receiver".
CREATE OR REPLACE FUNCTION public.welile_transfer_items()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY[
    'Welile Rent', 'Welile Bread', 'Welile Chapati', 'Welile Eggs',
    'Welile Fuel', 'Welile Reward', 'Welile Boda fees', 'Welile tax'
  ]::text[];
$$;

REVOKE ALL ON FUNCTION public.welile_transfer_items() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.welile_transfer_items() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.check_transfer_recipient_eligibility(
  p_recipient_id uuid,
  p_item text DEFAULT NULL,
  p_sender_id uuid DEFAULT NULL
)
RETURNS TABLE (
  eligible boolean,
  reason text,
  display_name text,
  has_wallet boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender uuid := COALESCE(auth.uid(), p_sender_id);
  v_p record;
  v_has_wallet boolean := false;
  v_name text;
BEGIN
  -- Only the signed-in user (or a service-role caller passing p_sender_id)
  -- may probe a recipient, so this can never be used to enumerate profiles.
  IF v_sender IS NULL THEN
    RETURN QUERY SELECT false, 'Not authenticated', NULL::text, false;
    RETURN;
  END IF;
  IF auth.uid() IS NOT NULL AND p_sender_id IS NOT NULL AND p_sender_id <> auth.uid() THEN
    RETURN QUERY SELECT false, 'Not authorised', NULL::text, false;
    RETURN;
  END IF;

  IF p_recipient_id IS NULL THEN
    RETURN QUERY SELECT false, 'Pick who you are sending to', NULL::text, false;
    RETURN;
  END IF;

  IF p_recipient_id = v_sender THEN
    RETURN QUERY SELECT false, 'You cannot send to yourself', NULL::text, false;
    RETURN;
  END IF;

  SELECT id, full_name, phone, is_frozen, deleted_at
    INTO v_p
  FROM public.profiles
  WHERE id = p_recipient_id;

  IF v_p.id IS NULL THEN
    RETURN QUERY SELECT false, 'This person does not have a Welile account', NULL::text, false;
    RETURN;
  END IF;

  v_name := COALESCE(NULLIF(btrim(v_p.full_name), ''), 'Welile user');

  IF v_p.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'This Welile account is closed', v_name, false;
    RETURN;
  END IF;

  IF COALESCE(v_p.is_frozen, false) THEN
    RETURN QUERY SELECT false, 'This account is frozen and cannot receive money', v_name, false;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_recipient_id) THEN
    RETURN QUERY SELECT false, 'This person can no longer sign in to Welile', v_name, false;
    RETURN;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = p_recipient_id)
    INTO v_has_wallet;

  IF p_item IS NOT NULL
     AND btrim(p_item) <> ''
     AND NOT (btrim(p_item) = ANY (public.welile_transfer_items())) THEN
    RETURN QUERY SELECT false, 'Pick one of the Welile items to send', v_name, v_has_wallet;
    RETURN;
  END IF;

  -- A missing wallet row is fine: the transfer function creates it on the
  -- first credit. Everything else above must hold.
  RETURN QUERY SELECT true, NULL::text, v_name, v_has_wallet;
END $$;

REVOKE ALL ON FUNCTION public.check_transfer_recipient_eligibility(uuid, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.check_transfer_recipient_eligibility(uuid, text, uuid) TO authenticated, service_role;

-- Harden schedule creation with the same gate (item allowlist included).
CREATE OR REPLACE FUNCTION public.create_wallet_transfer_schedule(
  p_recipient_id uuid,
  p_amount numeric,
  p_frequency text,
  p_day_of_week smallint DEFAULT NULL::smallint,
  p_day_of_month smallint DEFAULT NULL::smallint,
  p_description text DEFAULT NULL::text
)
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
    v_uid, p_recipient_id, p_amount, v_item, p_frequency,
    CASE WHEN p_frequency = 'weekly' THEN COALESCE(p_day_of_week, 1) END,
    CASE WHEN p_frequency = 'monthly' THEN COALESCE(p_day_of_month, 1) END,
    v_status,
    CASE WHEN v_status = 'active'
      THEN public.wallet_transfer_schedule_next_run(p_frequency, p_day_of_week, p_day_of_month, now())
    END
  ) RETURNING * INTO v_row;

  RETURN v_row;
END $function$;