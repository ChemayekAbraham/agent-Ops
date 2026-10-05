-- Move the landlord-float deduction off the browser.
--
-- AgentFloatPayoutWizard was doing this from the client:
--
--   read  agent_landlord_float.balance
--   if    balance < amount  -> throw
--   update balance -= amount, total_paid_out += amount
--   upload receipts
--   insert agent_float_withdrawals
--   on insert error -> write the old balance back
--
-- Three problems with that shape:
--
--   * Not atomic. A crash, a lost connection or a closed tab between the
--     deduction and the insert leaves the float spent with no withdrawal
--     record, and the "rollback" is itself a client write that can fail.
--   * Check-then-write with no lock. Two devices reading the same balance can
--     both pass the check and both deduct.
--   * Wrong basis. It compared against gross `balance`, which still counts
--     allocations the idle recall has pulled back (status `return_pending`),
--     so an agent could spend float that was already reversed.
--
-- This function does the check, the insert and the deduction in one
-- transaction, under a row lock, against the spendable figure
-- (`get_agent_lp_float_available`) the disbursement backend already enforces.
--
-- The agent is taken from auth.uid(), never from the client, and landlord_id /
-- tenant_id are read from the rent request rather than asserted by the caller.
-- Receipt upload stays client-side; pass the resulting URLs in, so no float
-- moves until the evidence is already stored.

create or replace function public.agent_record_landlord_float_withdrawal(
  p_rent_request_id         uuid,
  p_amount                  numeric,
  p_landlord_name           text,
  p_landlord_phone          text,
  p_mobile_money_provider   text,
  p_transaction_id          text    default null,
  p_notes                   text    default null,
  p_receipt_photo_urls      text[]  default null,
  p_agent_latitude          numeric default null,
  p_agent_longitude         numeric default null,
  p_agent_location_accuracy numeric default null,
  p_property_latitude       numeric default null,
  p_property_longitude      numeric default null,
  p_gps_distance_meters     numeric default null,
  p_gps_match               boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent     uuid := auth.uid();
  v_req       public.rent_requests%rowtype;
  v_balance   numeric;
  v_available numeric;
  v_id        uuid;
begin
  if v_agent is null then
    return jsonb_build_object('success', false, 'error', 'Not authenticated.');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount must be greater than zero.');
  end if;

  if coalesce(btrim(p_landlord_phone), '') = '' then
    return jsonb_build_object('success', false, 'error',
      'A landlord mobile money number is required.');
  end if;

  select * into v_req from public.rent_requests where id = p_rent_request_id;
  if v_req.id is null then
    return jsonb_build_object('success', false, 'error', 'Rent request not found.');
  end if;
  if v_req.landlord_id is null then
    return jsonb_build_object('success', false, 'error',
      'This rent request has no landlord on file — ask Landlord Ops to attach one.');
  end if;

  -- Lock the float row before reading it, so two devices cannot both pass the
  -- check and both deduct.
  select balance into v_balance
    from public.agent_landlord_float
   where agent_id = v_agent
     for update;

  if v_balance is null then
    return jsonb_build_object('success', false, 'error_code', 'NO_FLOAT_ACCOUNT',
      'error', 'You have no Landlord Payout Float yet. The CFO funds this when a payout is due.');
  end if;

  v_available := public.get_agent_lp_float_available(v_agent);

  if v_available < p_amount then
    return jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_FLOAT',
      'available', v_available, 'requested', p_amount, 'balance', v_balance,
      'error', format('Insufficient Landlord Payout Float. Available to spend: %s', v_available));
  end if;

  insert into public.agent_float_withdrawals (
    agent_id, rent_request_id, landlord_id, tenant_id, amount,
    landlord_name, landlord_phone, mobile_money_provider, transaction_id,
    receipt_photo_urls, agent_latitude, agent_longitude, agent_location_accuracy,
    property_latitude, property_longitude, gps_distance_meters, gps_match,
    notes, landlord_otp_verified, landlord_otp_verified_at, status
  ) values (
    v_agent, v_req.id, v_req.landlord_id, v_req.tenant_id, p_amount,
    coalesce(nullif(btrim(p_landlord_name), ''), 'Unknown'),
    btrim(p_landlord_phone), p_mobile_money_provider,
    nullif(btrim(p_transaction_id), ''), p_receipt_photo_urls,
    p_agent_latitude, p_agent_longitude, p_agent_location_accuracy,
    p_property_latitude, p_property_longitude, p_gps_distance_meters,
    coalesce(p_gps_match, false), nullif(btrim(p_notes), ''),
    true, now(), 'pending_agent_ops'
  ) returning id into v_id;

  update public.agent_landlord_float
     set balance        = balance - p_amount,
         total_paid_out = coalesce(total_paid_out, 0) + p_amount,
         updated_at     = now()
   where agent_id = v_agent;

  return jsonb_build_object(
    'success', true,
    'withdrawal_id', v_id,
    'amount', p_amount,
    'previous_balance', v_balance,
    'new_balance', v_balance - p_amount,
    'available_before', v_available,
    'available_after', public.get_agent_lp_float_available(v_agent)
  );
end;
$$;

comment on function public.agent_record_landlord_float_withdrawal is
  'Records a landlord payout from the agent''s Landlord Payout Float and deducts it, atomically and under a row lock, against get_agent_lp_float_available. Replaces the client-side read-check-update the payout wizard used to do.';

revoke all on function public.agent_record_landlord_float_withdrawal(
  uuid, numeric, text, text, text, text, text, text[],
  numeric, numeric, numeric, numeric, numeric, numeric, boolean) from public;

grant execute on function public.agent_record_landlord_float_withdrawal(
  uuid, numeric, text, text, text, text, text, text[],
  numeric, numeric, numeric, numeric, numeric, numeric, boolean) to authenticated;
