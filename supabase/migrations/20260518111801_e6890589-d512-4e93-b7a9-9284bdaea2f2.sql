create or replace function public.trg_log_gmail_deposit_exclusion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := null;
  v_dir    text := nullif(trim(coalesce(new.direction, '')), '');
begin
  if new.parsed is not true or new.linked_deposit_request_id is not null then
    return new;
  end if;

  if v_dir is null then
    v_reason := 'unknown_direction';
  elsif lower(v_dir) in ('in','credit') then
    -- eligible for deposit detection; only log if amount/tid missing
    if new.amount is null or new.amount <= 0 then
      v_reason := 'no_amount';
    elsif new.transaction_id is null or length(trim(new.transaction_id)) = 0 then
      v_reason := 'no_transaction_id';
    end if;
  elsif lower(v_dir) = 'out' then
    v_reason := 'outgoing_money_sent';
  elsif lower(v_dir) in ('debit','sent','paid','withdrawn','transferred') then
    v_reason := 'outgoing_money_sent';
  elsif lower(v_dir) = 'charge' or lower(v_dir) in ('fee','tax') then
    v_reason := 'fee_or_charge_email';
  else
    v_reason := 'malformed_direction';
  end if;

  if v_reason is null then
    return new;
  end if;

  insert into public.gmail_deposit_exclusions(
    gmail_transaction_id, gmail_message_id, reason, direction,
    amount, transaction_id, from_email, subject, snippet, internal_date
  ) values (
    new.id, new.gmail_message_id, v_reason, new.direction,
    new.amount, new.transaction_id, new.from_email,
    new.subject, new.snippet, new.internal_date
  );

  return new;
end;
$$;