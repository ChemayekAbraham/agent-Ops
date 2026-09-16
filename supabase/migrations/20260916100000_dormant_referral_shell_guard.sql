-- Closes the detection gap in scan_and_quarantine_bot_referral_rings(): that
-- guard only looks at the last 48 hours and treats "low name diversity" +
-- "mostly non-synthetic email" as the bot signature. A referral-bonus ring
-- discovered 2026-09-16 evaded both: it used the platform's own
-- @welile.agent synthetic-email pattern (so email_confirmed = true,
-- unverified_email/burst_signup never fire) and generated a distinct
-- gibberish name per row (so name diversity looks "real"). Its actual tell
-- is that the referred accounts have zero footprint anywhere else in the
-- system — the same test the original 2026-09-14 ring cleanup used.
create or replace function public.scan_and_quarantine_dormant_referral_shells(
  p_min_referred integer default 50,
  p_max_active_ratio numeric default 0.05,
  p_lookback interval default interval '45 days'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_reason text;
  r record;
  v_bot_ids uuid[];
  v_bot_count int;
  v_detections int := 0;
  v_frozen int := 0;
  v_purged int := 0;
begin
  for r in
    with cohort as (
      select p.id, p.referrer_id
      from public.profiles p
      where p.referrer_id is not null
        and p.deleted_at is null
        and p.created_at > now() - p_lookback
    ),
    active_ids as (
      select distinct user_id as id from public.general_ledger where user_id is not null
      union
      select distinct tenant_id from public.rent_requests where tenant_id is not null
      union
      select distinct agent_id from public.rent_requests where agent_id is not null
      union
      select distinct agent_id from public.house_listings where agent_id is not null
      union
      select distinct registered_by from public.landlords where registered_by is not null
      union
      select distinct registered_by from public.lc1_chairpersons where registered_by is not null
      union
      select distinct investor_id from public.investor_portfolios where investor_id is not null
    ),
    scored as (
      select c.id, c.referrer_id, (a.id is not null) as has_activity
      from cohort c
      left join active_ids a on a.id = c.id
    ),
    agg as (
      select referrer_id,
        count(*) as referred_count,
        count(*) filter (where has_activity) as active_count
      from scored
      group by referrer_id
    )
    select a.*, rp.is_frozen as referrer_already_frozen
    from agg a
    join public.profiles rp on rp.id = a.referrer_id
    where a.referred_count >= p_min_referred
      and (a.active_count::numeric / a.referred_count) <= p_max_active_ratio
  loop
    v_detections := v_detections + 1;
    v_reason := format(
      'Automated dormant-referral-shell hunter: %s referred accounts in the last %s, only %s%% show any real activity (ledger, rent request, house listing, landlord/LC1 registration or portfolio). Detected %s.',
      r.referred_count, p_lookback,
      round(r.active_count::numeric / r.referred_count * 100, 1),
      now()
    );

    if not r.referrer_already_frozen then
      perform public.fraud_block_user_identifiers(r.referrer_id, v_reason, v_actor);
      v_frozen := v_frozen + 1;
    end if;

    with cohort as (
      select p.id
      from public.profiles p
      where p.referrer_id = r.referrer_id
        and p.deleted_at is null
        and p.created_at > now() - p_lookback
    ),
    active_ids as (
      select distinct user_id as id from public.general_ledger where user_id is not null
      union
      select distinct tenant_id from public.rent_requests where tenant_id is not null
      union
      select distinct agent_id from public.rent_requests where agent_id is not null
      union
      select distinct agent_id from public.house_listings where agent_id is not null
      union
      select distinct registered_by from public.landlords where registered_by is not null
      union
      select distinct registered_by from public.lc1_chairpersons where registered_by is not null
      union
      select distinct investor_id from public.investor_portfolios where investor_id is not null
    )
    select array_agg(c.id) into v_bot_ids
    from cohort c
    left join active_ids a on a.id = c.id
    where a.id is null;

    v_bot_count := coalesce(array_length(v_bot_ids, 1), 0);

    if v_bot_count > 0 then
      insert into public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
      select p.id, p.full_name, p.email, p.phone, p.national_id,
             coalesce(
               (select jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', true))
                from public.user_roles ur where ur.user_id = p.id),
               '[]'::jsonb
             ),
             'soft_deleted',
             v_reason || ' Referred by ' || r.referrer_id::text || '.',
             v_actor
      from public.profiles p
      where p.id = any(v_bot_ids);

      delete from public.user_roles where user_id = any(v_bot_ids);
      delete from public.push_subscriptions where user_id = any(v_bot_ids);

      update public.profiles p set
        full_name = case when p.full_name like '[DELETED]%' then p.full_name else '[DELETED] ' || coalesce(p.full_name, 'Account') end,
        previous_full_name = coalesce(p.previous_full_name, p.full_name),
        email = 'deleted+' || p.id::text || '@deleted.invalid',
        phone = null, national_id = null, mobile_money_number = null,
        is_frozen = true, frozen_at = coalesce(p.frozen_at, now()),
        frozen_reason = 'Account deleted: automated dormant-referral-shell hunter, ' || now()::text,
        deleted_at = now(), deleted_by = v_actor,
        deletion_reason = v_reason
      where p.id = any(v_bot_ids);

      insert into public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      select v_actor, 'soft_delete_account', 'soft_delete_account', 'profiles', bot_id::text,
        jsonb_build_object('reason', v_reason, 'performed_by', v_actor, 'automated', true, 'referrer_id', r.referrer_id)
      from unnest(v_bot_ids) as bot_id;
    end if;

    v_purged := v_purged + v_bot_count;

    insert into public.bot_referral_ring_detections (
      referrer_id, referred_count, distinct_names, synthetic_email_count,
      span_hours, action_taken, bots_soft_deleted, notes
    ) values (
      r.referrer_id, r.referred_count, null, null,
      null,
      case when r.referrer_already_frozen then 'already_frozen_purged_new' else 'frozen_and_purged' end,
      v_bot_count, v_reason || ' (dormant-shell detector)'
    );
  end loop;

  return jsonb_build_object(
    'scanned_at', now(),
    'rings_detected', v_detections,
    'referrers_newly_frozen', v_frozen,
    'bot_accounts_purged', v_purged
  );
end;
$$;

revoke all on function public.scan_and_quarantine_dormant_referral_shells(integer, numeric, interval) from public;
grant execute on function public.scan_and_quarantine_dormant_referral_shells(integer, numeric, interval) to service_role, postgres;

-- Run every 30 minutes alongside the existing name-diversity guard, same cadence.
select cron.schedule(
  'scan-and-quarantine-dormant-referral-shells',
  '*/30 * * * *',
  $$select public.scan_and_quarantine_dormant_referral_shells();$$
);
