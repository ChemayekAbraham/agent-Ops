
drop function if exists public.try_link_gmail_for_deposit(uuid);

create or replace function public.try_link_gmail_for_deposit(p_deposit_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dep record;
  v_digits text;
  v_gmail_id uuid;
  v_dup record;
begin
  select id, user_id, transaction_id, amount, status
    into v_dep
    from public.deposit_requests
   where id = p_deposit_id;

  if v_dep.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_dep.user_id <> auth.uid() then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  if v_dep.status <> 'pending' then
    return jsonb_build_object('outcome', 'not_pending');
  end if;

  if v_dep.transaction_id is null or length(trim(v_dep.transaction_id)) = 0 then
    return jsonb_build_object('outcome', 'no_tid');
  end if;

  v_digits := regexp_replace(coalesce(v_dep.transaction_id, ''), '[^0-9]', '', 'g');
  if v_digits = '' then
    return jsonb_build_object('outcome', 'no_tid');
  end if;

  -- Duplicate: same digit tail already approved on another deposit for this user
  select dr.id
    into v_dup
    from public.deposit_requests dr
   where dr.user_id = v_dep.user_id
     and dr.id <> v_dep.id
     and dr.status = 'approved'
     and regexp_replace(coalesce(dr.transaction_id,''), '[^0-9]', '', 'g') = v_digits
   order by dr.created_at desc
   limit 1;

  if v_dup.id is not null then
    update public.deposit_requests
       set status = 'rejected',
           rejection_reason = 'Already credited from your mobile-money receipt — no duplicate needed.',
           notes = coalesce(notes,'') ||
             E'\n[auto] Duplicate of approved deposit ' || v_dup.id::text ||
             ' (same transaction reference). Cancelled automatically.'
     where id = v_dep.id
       and status = 'pending';
    return jsonb_build_object('outcome','duplicate_already_credited','original_deposit_id', v_dup.id);
  end if;

  -- Forward match by digit tail + amount within 7 days
  select id
    into v_gmail_id
    from public.gmail_transactions
   where linked_deposit_request_id is null
     and parsed = true
     and direction = 'credit'
     and transaction_id is not null
     and regexp_replace(transaction_id, '[^0-9]', '', 'g') = v_digits
     and amount = v_dep.amount
     and internal_date > now() - interval '7 days'
   order by internal_date desc
   limit 1;

  if v_gmail_id is null then
    return jsonb_build_object('outcome', 'no_match');
  end if;

  update public.gmail_transactions
     set linked_deposit_request_id = p_deposit_id,
         auto_matched_at = now(),
         auto_match_method = 'tid'
   where id = v_gmail_id
     and linked_deposit_request_id is null;

  if not found then
    return jsonb_build_object('outcome', 'race_lost');
  end if;

  return jsonb_build_object('outcome', 'linked', 'gmail_transaction_id', v_gmail_id);
end;
$$;

grant execute on function public.try_link_gmail_for_deposit(uuid) to authenticated;
