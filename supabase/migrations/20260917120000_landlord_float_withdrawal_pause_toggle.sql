-- CTO Platform Controls: new toggle "Pause landlord float withdrawals"
-- (control_key = 'landlord_float_withdrawals_paused'). Requested 2026-09-17.
--
-- Distinct from `landlord_payouts_blocked` (docs/HANDOVER/37-...), which only
-- hides ALREADY-CREATED landlord payout `withdrawal_requests` rows from the
-- Merchant Agent Payout Queue. This toggle instead stops an agent from
-- drawing down their CFO-funded `agent_landlord_float` balance in the first
-- place: no NEW `landlord_payouts` row (and therefore no new
-- `withdrawal_requests` row feeding the merchant queue) can be created while
-- it is ON.
--
-- ON  -> every insert into `landlord_payouts` is refused at its single
--        authoritative gate, the `enforce_landlord_payout_eligibility()`
--        BEFORE INSERT trigger -- this covers `landlord-payout-disburse`
--        (the only current writer) and any future writer for free.
--        Landlord payouts already sitting in the merchant queue are NOT
--        cancelled or hidden; they keep flowing through Financial Ops as
--        before (that is what `landlord_payouts_blocked` is for).
-- OFF (default) -> landlord float disbursement works as before.

insert into public.treasury_controls (control_key, enabled)
values ('landlord_float_withdrawals_paused', false)
on conflict (control_key) do nothing;

-- Single authoritative source for the flag, read by the eligibility trigger.
create or replace function public.landlord_float_withdrawals_paused()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select enabled from public.treasury_controls where control_key = 'landlord_float_withdrawals_paused'),
    false
  );
$$;

create or replace function public.enforce_landlord_payout_eligibility()
returns trigger
language plpgsql
set search_path = public
as $$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
BEGIN
  IF public.landlord_float_withdrawals_paused() THEN
    RAISE EXCEPTION 'Landlord float withdrawals are currently paused from Platform Controls. Try again once they are re-enabled.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Operating window: 06:00 – 22:00 Africa/Kampala (was >= 10, which blocked
  -- every payout after 10 AM and stranded agent float for the rest of the day).
  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  IF v_kampala_hour < 6 OR v_kampala_hour >= 22 THEN
    RAISE EXCEPTION 'Landlord payouts are only allowed between 06:00 and 22:00 Africa/Kampala.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT verified, phone INTO v_landlord_verified, v_landlord_phone
  FROM public.landlords WHERE id = NEW.landlord_id;

  IF v_landlord_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Landlord is not verified — Landlord Ops must verify the phone number first.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_landlord_phone IS NULL OR length(trim(v_landlord_phone)) < 8 THEN
    RAISE EXCEPTION 'Landlord has no usable phone number on file.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent has no landlord float account.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_float_balance < NEW.amount THEN
    RAISE EXCEPTION 'Insufficient landlord float (balance: %, requested: %).', v_float_balance, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
