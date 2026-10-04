
-- Instant TID auto-link at submit time.
-- Returns true if a matching unlinked Gmail mobile-money credit row exists
-- for the same transaction_id and was successfully linked to this deposit.
-- The caller (client) then invokes approve-deposit with auto_approved:true.
create or replace function public.try_link_gmail_for_deposit(p_deposit_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dep record;
  v_gmail_id uuid;
begin
  select id, user_id, transaction_id, amount, status
    into v_dep
    from public.deposit_requests
   where id = p_deposit_id;

  if v_dep.id is null then
    return false;
  end if;

  -- Only operate on the depositor's own freshly-submitted pending row
  if v_dep.user_id <> auth.uid() then
    return false;
  end if;

  if v_dep.status <> 'pending' then
    return false;
  end if;

  if v_dep.transaction_id is null or length(trim(v_dep.transaction_id)) = 0 then
    return false;
  end if;

  -- Find an unlinked, parsed, inbound credit Gmail row with the SAME TID
  -- and amount, received within the last 7 days. TID match is the
  -- high-confidence signal already used by the existing matcher.
  select id
    into v_gmail_id
    from public.gmail_transactions
   where linked_deposit_request_id is null
     and parsed = true
     and direction = 'credit'
     and lower(transaction_id) = lower(v_dep.transaction_id)
     and amount = v_dep.amount
     and internal_date > now() - interval '7 days'
   order by internal_date desc
   limit 1;

  if v_gmail_id is null then
    return false;
  end if;

  update public.gmail_transactions
     set linked_deposit_request_id = p_deposit_id,
         auto_matched_at = now(),
         auto_match_method = 'tid'
   where id = v_gmail_id
     and linked_deposit_request_id is null;

  return found;
end;
$$;

grant execute on function public.try_link_gmail_for_deposit(uuid) to authenticated;
