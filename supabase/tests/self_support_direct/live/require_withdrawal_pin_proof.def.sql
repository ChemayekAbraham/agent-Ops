CREATE OR REPLACE FUNCTION public.require_withdrawal_pin_proof()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_has boolean;
  v_purpose text;
  v_proof jsonb;
begin
  if v_uid is null or v_uid is distinct from NEW.user_id then
    return NEW;
  end if;

  if TG_TABLE_NAME = 'withdrawal_requests' then
    v_purpose := 'withdrawal';
  else
    v_purpose := 'payout_number_change';
  end if;

  select enforce_mode into v_mode from public.withdrawal_pin_config where id;
  if v_mode is null or v_mode = 'off' then
    return NEW;
  end if;

  select exists (select 1 from public.user_withdrawal_pins where user_id = v_uid) into v_has;
  if not v_has then
    if v_mode = 'all' then
      raise exception using errcode = '28000', message = 'withdrawal_pin_required',
        detail = 'Set your withdrawal PIN before withdrawing or changing your payout number.';
    end if;
    return NEW;
  end if;

  v_proof := public.consume_withdrawal_pin_proof(v_uid, v_purpose);
  if v_proof is null then
    raise exception using errcode = '28000', message = 'withdrawal_pin_proof_required',
      detail = 'Enter your withdrawal PIN to continue.';
  end if;

  if TG_TABLE_NAME = 'payout_number_change_requests' then
    NEW.pin_verified := true;
    NEW.device_fp := v_proof ->> 'device_fp';
    NEW.device_trusted := (v_proof ->> 'device_trusted')::boolean;
  end if;
  return NEW;
end;
$function$

