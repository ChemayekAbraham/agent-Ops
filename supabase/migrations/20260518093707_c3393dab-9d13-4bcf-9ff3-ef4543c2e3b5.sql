-- 1. Audit log table for retry passes
create table if not exists public.deposit_relink_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  deposit_request_id uuid not null references public.deposit_requests(id) on delete cascade,
  outcome text not null check (outcome in ('linked','still_pending','no_tid','duplicate_cancelled','race_lost')),
  normalized_tid text,
  raw_tid text,
  gmail_transaction_id uuid,
  duplicate_of_deposit_id uuid,
  amount numeric,
  age_minutes integer,
  threshold_minutes integer,
  attempted_at timestamptz not null default now(),
  notes text
);

create index if not exists idx_deposit_relink_attempts_deposit on public.deposit_relink_attempts(deposit_request_id);
create index if not exists idx_deposit_relink_attempts_run on public.deposit_relink_attempts(run_id);
create index if not exists idx_deposit_relink_attempts_outcome_at on public.deposit_relink_attempts(outcome, attempted_at desc);

alter table public.deposit_relink_attempts enable row level security;

create policy "Managers and CFO can view deposit relink attempts"
  on public.deposit_relink_attempts
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'manager'::app_role)
    or public.has_role(auth.uid(), 'cfo'::app_role)
  );

-- 2. The retry RPC
create or replace function public.relink_stuck_pending_deposits(
  p_min_age_minutes integer default 1440,
  p_max_age_days integer default 14
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
  v_outcome text;
  v_age_minutes integer;
  v_linked integer := 0;
  v_dupes integer := 0;
  v_no_tid integer := 0;
  v_still_pending integer := 0;
  v_examined integer := 0;
  v_started_at timestamptz := now();
begin
  -- Only managers / cfo / system role (service_role bypasses RLS) may invoke
  if auth.uid() is not null
     and not (public.has_role(auth.uid(), 'manager'::app_role)
              or public.has_role(auth.uid(), 'cfo'::app_role))
  then
    raise exception 'forbidden: relink job requires manager or cfo role';
  end if;

  for v_dep in
    select id, user_id, transaction_id, amount, created_at
      from public.deposit_requests
     where status = 'pending'
       and created_at <= now() - make_interval(mins => p_min_age_minutes)
       and created_at >= now() - make_interval(days => p_max_age_days)
     order by created_at asc
     limit 500
  loop
    v_examined := v_examined + 1;
    v_age_minutes := greatest(0, extract(epoch from (now() - v_dep.created_at))::int / 60);
    v_gmail_id := null;
    v_dup_id := null;
    v_outcome := null;

    v_digits := regexp_replace(coalesce(v_dep.transaction_id, ''), '[^0-9]', '', 'g');

    if v_digits = '' then
      v_outcome := 'no_tid';
      v_no_tid := v_no_tid + 1;
    else
      -- Duplicate of an already-approved deposit?
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
                 E'\n[auto/retry] Duplicate of approved deposit ' || v_dup_id::text ||
                 ' detected by daily relink job. Cancelled.',
               auto_match_audit = jsonb_build_object(
                 'outcome', 'duplicate_cancelled',
                 'normalized_tid', v_digits,
                 'raw_tid', v_dep.transaction_id,
                 'original_deposit_id', v_dup_id,
                 'source', 'relink_job',
                 'checked_at', now()
               )
         where id = v_dep.id and status = 'pending';
        v_outcome := 'duplicate_cancelled';
        v_dupes := v_dupes + 1;
      else
        -- Try forward link to an unlinked Gmail receipt
        select id into v_gmail_id
          from public.gmail_transactions
         where linked_deposit_request_id is null
           and parsed = true
           and direction = 'credit'
           and transaction_id is not null
           and regexp_replace(transaction_id, '[^0-9]', '', 'g') = v_digits
           and amount = v_dep.amount
           and internal_date > now() - interval '14 days'
         order by internal_date desc
         limit 1;

        if v_gmail_id is null then
          v_outcome := 'still_pending';
          v_still_pending := v_still_pending + 1;
          update public.deposit_requests
             set auto_match_audit = jsonb_build_object(
               'outcome', 'pending',
               'normalized_tid', v_digits,
               'raw_tid', v_dep.transaction_id,
               'source', 'relink_job',
               'checked_at', now(),
               'note', 'Daily relink job found no matching receipt yet.'
             )
           where id = v_dep.id and status = 'pending';
        else
          update public.gmail_transactions
             set linked_deposit_request_id = v_dep.id,
                 auto_matched_at = now(),
                 auto_match_method = 'tid'
           where id = v_gmail_id
             and linked_deposit_request_id is null;

          if not found then
            v_outcome := 'race_lost';
            v_gmail_id := null;
          else
            v_outcome := 'linked';
            v_linked := v_linked + 1;
            update public.deposit_requests
               set auto_match_audit = jsonb_build_object(
                 'outcome', 'linked',
                 'normalized_tid', v_digits,
                 'raw_tid', v_dep.transaction_id,
                 'gmail_transaction_id', v_gmail_id,
                 'auto_match_method', 'tid',
                 'source', 'relink_job',
                 'checked_at', now()
               )
             where id = v_dep.id and status = 'pending';
          end if;
        end if;
      end if;
    end if;

    insert into public.deposit_relink_attempts(
      run_id, deposit_request_id, outcome, normalized_tid, raw_tid,
      gmail_transaction_id, duplicate_of_deposit_id, amount,
      age_minutes, threshold_minutes
    ) values (
      v_run_id, v_dep.id, v_outcome, nullif(v_digits,''), v_dep.transaction_id,
      v_gmail_id, v_dup_id, v_dep.amount,
      v_age_minutes, p_min_age_minutes
    );
  end loop;

  -- Single summary system event
  insert into public.system_events(event_type, source, payload)
  values (
    'deposit.relink_job_completed',
    'relink_stuck_pending_deposits',
    jsonb_build_object(
      'run_id', v_run_id,
      'examined', v_examined,
      'linked', v_linked,
      'duplicate_cancelled', v_dupes,
      'no_tid', v_no_tid,
      'still_pending', v_still_pending,
      'threshold_minutes', p_min_age_minutes,
      'max_age_days', p_max_age_days,
      'duration_ms', extract(epoch from (now() - v_started_at)) * 1000
    )
  );

  return jsonb_build_object(
    'run_id', v_run_id,
    'examined', v_examined,
    'linked', v_linked,
    'duplicate_cancelled', v_dupes,
    'no_tid', v_no_tid,
    'still_pending', v_still_pending
  );
end;
$$;

grant execute on function public.relink_stuck_pending_deposits(integer, integer) to authenticated, service_role;