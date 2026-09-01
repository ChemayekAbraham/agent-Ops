-- Fix two bugs in the automated deposit-matching pipeline found while
-- investigating a stuck UGX 50,000 float top-up (Akampurira Onesmus,
-- deposit_requests.id = 7cd148d5-a0b4-4306-b99c-4e9b5d3e2a04).
--
-- BUG 1 — hard 14-day retry ceiling, no fallback, no alert.
-- `relink_stuck_pending_deposits` is the only job that ever re-checks an
-- already-created pending deposit (pg_cron job id 50, runs once daily at
-- 03:30 — NOT "every minute" as AgentPendingReceiptPanel.tsx tells the
-- agent). It only considers rows with
-- `created_at >= now() - p_max_age_days` and the scheduled call passes
-- `p_max_age_days = 14`. `deposit_relink_attempts` shows this job faithfully
-- retried several real deposits every single day for their full 14-day
-- window (all logged "still_pending"), then silently stopped forever the
-- day each one turned 14 days old. Confirmed across 4 real (non-test-value)
-- stuck deposits, 15-47 days old, UGX 2,299,000 total, at the time of this
-- migration. Fix: raise the default ceiling to effectively unlimited
-- (~100 years) and repoint the scheduled job at the new default so aged
-- deposits keep being retried instead of being silently abandoned.
--
-- BUG 2 — duplicate detection is same-user only.
-- Both `relink_stuck_pending_deposits` and `try_link_gmail_for_deposit` only
-- check for an approved duplicate belonging to the SAME user. A transaction
-- ID that was already consumed by a DIFFERENT user's approved deposit (e.g.
-- Onesmus submitted David's already-approved TID six days after David's was
-- credited) is invisible to both checks and will never resolve, no matter
-- how long or how often it is retried. Fix: add a cross-user check. Unlike
-- the same-user case (which auto-rejects — it is unambiguously the user's
-- own already-credited receipt), a cross-user match is NOT auto-rejected —
-- it could be an honest mistake on either side, or worse. It is flagged
-- (`audit_flagged = true`) with the claiming deposit's id recorded in
-- `auto_match_audit`, left `pending` so it stays visible to the agent and
-- surfaces to Financial Ops review, and a human decides.
--
-- BUG 3 (minor, same root cause as #1) — the Gmail-receipt match window is
-- measured from `now()`, not from the deposit's own age. `internal_date >
-- now() - interval '7/14 days'` guarantees that once a pending deposit is
-- itself older than that window, it can *never* match its own (equally old)
-- receipt even if nothing else is wrong. Fixed to a window relative to the
-- deposit's `created_at` instead.

-- 1. Allow the new outcome value.
ALTER TABLE public.deposit_relink_attempts DROP CONSTRAINT deposit_relink_attempts_outcome_check;
ALTER TABLE public.deposit_relink_attempts ADD CONSTRAINT deposit_relink_attempts_outcome_check
  CHECK (outcome = ANY (ARRAY['linked', 'still_pending', 'no_tid', 'duplicate_cancelled', 'race_lost', 'cross_user_duplicate_flagged']));

-- 2. Scheduled sweep: unlimited age ceiling, cross-user flagging, relative match window.
CREATE OR REPLACE FUNCTION public.relink_stuck_pending_deposits(p_min_age_minutes integer DEFAULT 1440, p_max_age_days integer DEFAULT 36500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run_id uuid := gen_random_uuid();
  v_dep record;
  v_digits text;
  v_gmail_id uuid;
  v_dup_id uuid;
  v_other_dup_id uuid;
  v_other_user_id uuid;
  v_age_min integer;
  v_linked int := 0;
  v_dup int := 0;
  v_cross_dup int := 0;
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

    -- Cross-user: this TID already belongs to a DIFFERENT user's approved
    -- deposit. Never auto-reject — flag for a human to decide.
    select dr.id, dr.user_id into v_other_dup_id, v_other_user_id
      from public.deposit_requests dr
     where dr.id <> v_dep.id
       and dr.status = 'approved'
       and regexp_replace(coalesce(dr.transaction_id,''), '[^0-9]', '', 'g') = v_digits
     order by dr.created_at asc
     limit 1;

    if v_other_dup_id is not null then
      update public.deposit_requests
         set audit_flagged = true,
             notes = coalesce(notes,'') ||
               E'\n[auto] Transaction reference already used by approved deposit ' || v_other_dup_id::text ||
               ' on a different account. Flagged for Financial Ops review by relink job.',
             auto_match_audit = jsonb_build_object(
               'outcome','cross_user_duplicate_flagged',
               'normalized_tid',v_digits,'raw_tid',v_dep.transaction_id,
               'claimed_by_deposit_id',v_other_dup_id,'claimed_by_user_id',v_other_user_id,
               'checked_at',now()
             )
       where id = v_dep.id and status = 'pending';

      v_cross_dup := v_cross_dup + 1;
      insert into public.deposit_relink_attempts(
        run_id, deposit_request_id, outcome, normalized_tid, raw_tid,
        duplicate_of_deposit_id, amount, age_minutes, threshold_minutes, notes
      ) values (
        v_run_id, v_dep.id, 'cross_user_duplicate_flagged', v_digits, v_dep.transaction_id,
        v_other_dup_id, v_dep.amount, v_age_min, p_min_age_minutes,
        'Claimed by a different user''s approved deposit ' || v_other_dup_id::text || '; flagged, not rejected.'
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
       and internal_date between v_dep.created_at - interval '3 days' and v_dep.created_at + interval '14 days'
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
        'No matching incoming Gmail receipt within the deposit''s own match window.'
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
    'cross_user_duplicate_flagged', v_cross_dup,
    'still_pending', v_pending,
    'no_tid', v_notid,
    'race_lost', v_race
  );
end;
$function$;

-- 3. On-demand check (agent's "Refresh" button, and at deposit creation):
--    same cross-user flag, same relative match window.
CREATE OR REPLACE FUNCTION public.try_link_gmail_for_deposit(p_deposit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dep record;
  v_digits text;
  v_gmail_id uuid;
  v_dup record;
  v_other_dup record;
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

  -- Cross-user: flag, do not reject — the agent keeps seeing this as pending
  -- (now flagged) rather than being told it is resolved either way.
  select dr.id, dr.user_id
    into v_other_dup
    from public.deposit_requests dr
   where dr.id <> v_dep.id
     and dr.status = 'approved'
     and regexp_replace(coalesce(dr.transaction_id,''), '[^0-9]', '', 'g') = v_digits
   order by dr.created_at asc
   limit 1;

  if v_other_dup.id is not null then
    v_audit := jsonb_build_object(
      'outcome', 'cross_user_duplicate_flagged', 'normalized_tid', v_digits,
      'raw_tid', v_dep.transaction_id, 'claimed_by_deposit_id', v_other_dup.id,
      'claimed_by_user_id', v_other_dup.user_id, 'checked_at', now()
    );
    update public.deposit_requests
       set audit_flagged = true,
           notes = coalesce(notes,'') ||
             E'\n[auto] Transaction reference already used by approved deposit ' || v_other_dup.id::text ||
             ' on a different account. Flagged for Financial Ops review.',
           auto_match_audit = v_audit
     where id = v_dep.id;
    return jsonb_build_object('outcome','cross_user_duplicate_flagged','claimed_by_deposit_id', v_other_dup.id);
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
     and internal_date between (select created_at from public.deposit_requests where id = v_dep.id) - interval '3 days'
                            and (select created_at from public.deposit_requests where id = v_dep.id) + interval '14 days'
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
$function$;

-- 4. Repoint the daily scheduled sweep at the new unlimited default instead
--    of the hard-coded 14-day ceiling.
SELECT cron.alter_job(
  job_id := 50,
  command := $cron$
  select net.http_post(
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/rest/v1/rpc/relink_stuck_pending_deposits',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8'
    ),
    body := jsonb_build_object('p_min_age_minutes', 1440, 'p_max_age_days', 36500)
  );
  $cron$
);
