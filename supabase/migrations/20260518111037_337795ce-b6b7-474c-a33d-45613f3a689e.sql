-- 1) On-insert trigger: require explicit incoming direction
create or replace function public.trg_gmail_tx_auto_create_deposit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.linked_deposit_request_id is null
     and new.parsed = true
     and new.amount is not null and new.amount > 0
     and new.transaction_id is not null
     and new.direction in ('in','credit') then
    begin
      perform public.auto_create_deposits_from_gmail(24);
    exception when others then
      raise warning 'auto_create_deposits_from_gmail failed: %', sqlerrm;
    end;
  end if;
  return new;
end;
$$;

-- 2) Auto-create deposits: require explicit incoming direction (drop NULL fallback)
create or replace function public.auto_create_deposits_from_gmail(p_window_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx record;
  v_phone_match text;
  v_phone_norm  text;
  v_user_id     uuid;
  v_provider    text;
  v_haystack    text;
  v_created     integer := 0;
  v_new_id      uuid;
begin
  for v_tx in
    select g.id, g.amount, g.transaction_id, g.counterparty, g.internal_date,
           g.subject, g.snippet, g.raw_body, g.from_email
      from gmail_transactions g
     where g.linked_deposit_request_id is null
       and g.parsed = true
       and g.direction in ('in','credit')          -- exclude out/charge/null
       and g.amount is not null
       and g.amount > 0
       and g.transaction_id is not null
       and length(trim(g.transaction_id)) > 0
       and (g.internal_date is null
            or g.internal_date >= (now() - (p_window_hours || ' hours')::interval))
     order by g.internal_date desc nulls last
     limit 200
  loop
    if exists (
      select 1 from deposit_requests d
       where d.transaction_id is not null
         and lower(trim(d.transaction_id)) = lower(trim(v_tx.transaction_id))
    ) then
      continue;
    end if;

    v_haystack := concat_ws(' ',
      coalesce(v_tx.snippet, ''),
      coalesce(v_tx.subject, ''),
      coalesce(v_tx.counterparty, ''),
      coalesce(v_tx.raw_body, '')
    );

    v_phone_match := substring(v_haystack from '256[0-9]{9}');
    if v_phone_match is null then
      v_phone_match := substring(v_haystack from '0[7][0-9]{8}');
    end if;

    if v_phone_match is null then
      continue;
    end if;

    if v_phone_match like '256%' then
      v_phone_norm := '0' || substring(v_phone_match from 4);
    else
      v_phone_norm := v_phone_match;
    end if;

    select p.id into v_user_id
      from profiles p
     where regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') in (
             regexp_replace(v_phone_match, '[^0-9]', '', 'g'),
             regexp_replace(v_phone_norm,  '[^0-9]', '', 'g'),
             '256' || substring(v_phone_norm from 2)
           )
     limit 1;

    if v_user_id is null then
      continue;
    end if;

    if exists (
      select 1 from deposit_requests d
       where d.user_id = v_user_id
         and d.status = 'pending'
         and abs(d.amount - v_tx.amount) < 0.5
         and d.created_at >= (now() - (p_window_hours || ' hours')::interval)
    ) then
      continue;
    end if;

    v_provider := case
      when v_haystack ilike '%momo%' or v_haystack ilike '%mtn%' then 'mtn'
      when v_haystack ilike '%airtel%' then 'airtel'
      else 'mtn'
    end;

    insert into deposit_requests (
      user_id, amount, transaction_id, status, method, provider,
      notes, created_at
    ) values (
      v_user_id, v_tx.amount, v_tx.transaction_id, 'approved', 'momo', v_provider,
      '[auto] Auto-created from Gmail receipt ' || v_tx.id::text, now()
    ) returning id into v_new_id;

    update gmail_transactions
       set linked_deposit_request_id = v_new_id,
           auto_matched_at = now(),
           auto_match_method = 'auto_created'
     where id = v_tx.id
       and linked_deposit_request_id is null;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

-- 3) try_link_gmail_for_deposit: accept 'in' or 'credit', never 'out'/'charge'/null
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
  v_audit jsonb;
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

  v_digits := regexp_replace(coalesce(v_dep.transaction_id, ''), '[^0-9]', '', 'g');

  if v_dep.transaction_id is null
     or length(trim(v_dep.transaction_id)) = 0
     or v_digits = '' then
    v_audit := jsonb_build_object(
      'outcome', 'no_tid', 'normalized_tid', null,
      'raw_tid', v_dep.transaction_id, 'checked_at', now()
    );
    update public.deposit_requests set auto_match_audit = v_audit where id = v_dep.id;
    return jsonb_build_object('outcome', 'no_tid');
  end if;

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
    v_audit := jsonb_build_object(
      'outcome', 'duplicate_cancelled', 'normalized_tid', v_digits,
      'raw_tid', v_dep.transaction_id, 'original_deposit_id', v_dup.id,
      'checked_at', now()
    );
    update public.deposit_requests
       set status = 'rejected',
           rejection_reason = 'Already credited from your mobile-money receipt — no duplicate needed.',
           notes = coalesce(notes,'') ||
             E'\n[auto] Duplicate of approved deposit ' || v_dup.id::text ||
             ' (same transaction reference). Cancelled automatically.',
           auto_match_audit = v_audit
     where id = v_dep.id
       and status = 'pending';
    return jsonb_build_object('outcome','duplicate_already_credited','original_deposit_id', v_dup.id);
  end if;

  select id
    into v_gmail_id
    from public.gmail_transactions
   where linked_deposit_request_id is null
     and parsed = true
     and direction in ('in','credit')             -- incoming only
     and transaction_id is not null
     and regexp_replace(transaction_id, '[^0-9]', '', 'g') = v_digits
     and amount = v_dep.amount
     and internal_date > now() - interval '7 days'
   order by internal_date desc
   limit 1;

  if v_gmail_id is null then
    v_audit := jsonb_build_object(
      'outcome', 'pending', 'normalized_tid', v_digits,
      'raw_tid', v_dep.transaction_id, 'checked_at', now(),
      'note', 'No matching mobile-money receipt found yet; will keep watching.'
    );
    update public.deposit_requests set auto_match_audit = v_audit where id = v_dep.id;
    return jsonb_build_object('outcome', 'no_match');
  end if;

  update public.gmail_transactions
     set linked_deposit_request_id = p_deposit_id,
         auto_matched_at = now(),
         auto_match_method = 'tid'
   where id = v_gmail_id
     and linked_deposit_request_id is null;

  if not found then
    v_audit := jsonb_build_object(
      'outcome', 'race_lost', 'normalized_tid', v_digits,
      'raw_tid', v_dep.transaction_id, 'gmail_transaction_id', v_gmail_id,
      'checked_at', now()
    );
    update public.deposit_requests set auto_match_audit = v_audit where id = v_dep.id;
    return jsonb_build_object('outcome', 'race_lost');
  end if;

  v_audit := jsonb_build_object(
    'outcome', 'linked', 'normalized_tid', v_digits,
    'raw_tid', v_dep.transaction_id, 'gmail_transaction_id', v_gmail_id,
    'auto_match_method', 'tid', 'checked_at', now()
  );
  update public.deposit_requests set auto_match_audit = v_audit where id = v_dep.id;

  return jsonb_build_object('outcome', 'linked', 'gmail_transaction_id', v_gmail_id, 'normalized_tid', v_digits);
end;
$$;

grant execute on function public.try_link_gmail_for_deposit(uuid) to authenticated;

-- 4) Nightly relink: same incoming-only guard
create or replace function public.relink_stuck_pending_deposits(
  p_min_age_minutes integer default 1440,
  p_max_age_days    integer default 14
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_dep record;
  v_digits text;
  v_gmail_id uuid;
  v_dup_id uuid;
  v_age_min integer;
  v_linked int := 0;
  v_dup int := 0;
  v_pending int := 0;
  v_notid int := 0;
  v_race int := 0;
  v_audit jsonb;
begin
  for v_dep in
    select id, user_id, transaction_id, amount, created_at
      from public.deposit_requests
     where status = 'pending'
       and created_at <= now() - (p_min_age_minutes || ' minutes')::interval
       and created_at >= now() - (p_max_age_days   || ' days')::interval
     order by created_at asc
     limit 500
  loop
    v_age_min := extract(epoch from (now() - v_dep.created_at))::int / 60;
    v_digits := regexp_replace(coalesce(v_dep.transaction_id,''), '[^0-9]', '', 'g');

    if v_digits = '' then
      v_notid := v_notid + 1;
      insert into public.deposit_relink_attempts(
        run_id, deposit_request_id, outcome, normalized_tid, raw_tid,
        amount, age_minutes, threshold_minutes
      ) values (
        v_run_id, v_dep.id, 'no_tid', null, v_dep.transaction_id,
        v_dep.amount, v_age_min, p_min_age_minutes
      );
      continue;
    end if;

    select dr.id into v_dup_id
      from public.deposit_requests dr
     where dr.user_id = v_dep.user_id
       and dr.id <> v_dep.id
       and dr.status = 'approved'
       and regexp_replace(coalesce(dr.transaction_id,''), '[^0-9]', '', 'g') = v_digits
     order by dr.created_at desc
     limit 1;

    if v_dup_id is not null then
      update public.deposit_requests
         set status = 'rejected',
             rejection_reason = 'Already credited from your mobile-money receipt — no duplicate needed.',
             notes = coalesce(notes,'') ||
               E'\n[auto] Duplicate of approved deposit ' || v_dup_id::text ||
               ' (same transaction reference). Cancelled by relink job.',
             auto_match_audit = jsonb_build_object(
               'outcome','duplicate_cancelled',
               'normalized_tid',v_digits,'raw_tid',v_dep.transaction_id,
               'original_deposit_id',v_dup_id,'checked_at',now()
             )
       where id = v_dep.id and status = 'pending';

      v_dup := v_dup + 1;
      insert into public.deposit_relink_attempts(
        run_id, deposit_request_id, outcome, normalized_tid, raw_tid,
        duplicate_of_deposit_id, amount, age_minutes, threshold_minutes
      ) values (
        v_run_id, v_dep.id, 'duplicate_cancelled', v_digits, v_dep.transaction_id,
        v_dup_id, v_dep.amount, v_age_min, p_min_age_minutes
      );
      continue;
    end if;

    select id into v_gmail_id
      from public.gmail_transactions
     where linked_deposit_request_id is null
       and parsed = true
       and direction in ('in','credit')             -- incoming only
       and transaction_id is not null
       and regexp_replace(transaction_id, '[^0-9]', '', 'g') = v_digits
       and amount = v_dep.amount
       and internal_date > now() - interval '14 days'
     order by internal_date desc
     limit 1;

    if v_gmail_id is null then
      v_pending := v_pending + 1;
      insert into public.deposit_relink_attempts(
        run_id, deposit_request_id, outcome, normalized_tid, raw_tid,
        amount, age_minutes, threshold_minutes, notes
      ) values (
        v_run_id, v_dep.id, 'still_pending', v_digits, v_dep.transaction_id,
        v_dep.amount, v_age_min, p_min_age_minutes,
        'No matching incoming Gmail receipt within 14 days.'
      );
      continue;
    end if;

    update public.gmail_transactions
       set linked_deposit_request_id = v_dep.id,
           auto_matched_at = now(),
           auto_match_method = 'relink_job'
     where id = v_gmail_id
       and linked_deposit_request_id is null;

    if not found then
      v_race := v_race + 1;
      insert into public.deposit_relink_attempts(
        run_id, deposit_request_id, outcome, normalized_tid, raw_tid,
        gmail_transaction_id, amount, age_minutes, threshold_minutes
      ) values (
        v_run_id, v_dep.id, 'race_lost', v_digits, v_dep.transaction_id,
        v_gmail_id, v_dep.amount, v_age_min, p_min_age_minutes
      );
      continue;
    end if;

    v_audit := jsonb_build_object(
      'outcome', 'linked', 'normalized_tid', v_digits,
      'raw_tid', v_dep.transaction_id, 'gmail_transaction_id', v_gmail_id,
      'auto_match_method', 'relink_job', 'checked_at', now()
    );
    update public.deposit_requests set auto_match_audit = v_audit where id = v_dep.id;

    v_linked := v_linked + 1;
    insert into public.deposit_relink_attempts(
      run_id, deposit_request_id, outcome, normalized_tid, raw_tid,
      gmail_transaction_id, amount, age_minutes, threshold_minutes
    ) values (
      v_run_id, v_dep.id, 'linked', v_digits, v_dep.transaction_id,
      v_gmail_id, v_dep.amount, v_age_min, p_min_age_minutes
    );
  end loop;

  return jsonb_build_object(
    'run_id', v_run_id,
    'linked', v_linked,
    'duplicate_cancelled', v_dup,
    'still_pending', v_pending,
    'no_tid', v_notid,
    'race_lost', v_race
  );
end;
$$;

grant execute on function public.relink_stuck_pending_deposits(integer, integer) to authenticated, service_role;