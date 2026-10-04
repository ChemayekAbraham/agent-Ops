-- Soft-deletes the 61 confirmed/likely-bot accounts from the 2026-08-18 16:50-17:30 UTC
-- signup burst (70 accounts total). Same mechanism as scan_and_quarantine_bot_referral_rings:
-- soft-delete (deleted_accounts + PII scrub + is_frozen), not a hard DELETE.
--
-- Investigation: a tenant-facing "you can now request rent" SMS
-- (notify-new-signup-rent-prompt) went out to accounts with names like "Fzhdh" --
-- gibberish. Traced to a 40-minute signup burst on 2026-08-18: 70 accounts, 62 sharing
-- just 5 referrers (Frank Walu, Mucunguzi Eliias Mucu, Ampire Tobbi, Nakiyimba fairuzi,
-- and one referrer_id that no longer resolves to any profile). Three of those five
-- referrers are ALREADY frozen by scan_and_quarantine_bot_referral_rings for unrelated
-- activity -- but that hunter only scans signups from the last 48 hours, so by the time
-- it froze these referrers (days later), this specific burst had aged out of its window
-- and its bot children were never purged. See docs/HANDOVER for the full writeup.
--
-- 9 of the 70 are real people caught in the same time window by coincidence (plausible
-- full names, real personal email addresses, two with an actual paid referral bonus) --
-- excluded here by email. The remaining 61 = 46 unambiguous gibberish/fragment names
-- ("Th Ehf Eh", "Wicked The Maple", "First") + 15 single common first names that could
-- theoretically be real but share the identical zero-activity, same-burst fingerprint
-- (Josh's call to include rather than leave as ambiguous). None of the 61 have any
-- general_ledger entry; any rent_request among them is permanently stuck at
-- 'service_center_review' (never funded) -- no real money or tenancy is touched.

do $$
declare
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_reason text := 'Manual review, 2026-09-16: bot signup burst (gibberish/placeholder full_name, 40-minute window on 2026-08-18, referrer already frozen by the bot-referral-ring hunter or missing entirely, zero ledger activity, rent_request stalled at service_center_review). Flagged from the notify-new-signup-rent-prompt SMS log.';
  v_bot_ids uuid[];
  v_count int;
begin
  select array_agg(p.id) into v_bot_ids
  from public.profiles p
  where p.created_at between '2026-08-18 16:50:00+00' and '2026-08-18 17:30:00+00'
    and p.deleted_at is null
    and p.email not in (
      'wangudipollysteven@gmail.com', '256741728749@welile.user', 'ebyamukama99@gmail.com',
      '256708396063@welile.user', '0789395765@welile.agent', 'kawumaallen@protonmail.com',
      'kivumbikato@protonmail.com', 'mukagarashid9@gmail.com', 'josejerome256@gmail.com'
    );

  v_count := coalesce(array_length(v_bot_ids, 1), 0);
  if v_count <> 61 then
    raise exception 'Expected exactly 61 accounts to purge, found %. Aborting -- re-verify the burst window/exclusion list before running this migration.', v_count;
  end if;

  insert into public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
  select p.id, p.full_name, p.email, p.phone, p.national_id,
    coalesce(
      (select jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', true)) from public.user_roles ur where ur.user_id = p.id),
      '[]'::jsonb
    ),
    'soft_deleted', v_reason, v_actor
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
    frozen_reason = 'Account deleted: manual bot-burst review, ' || now()::text,
    deleted_at = now(), deleted_by = v_actor,
    deletion_reason = v_reason
  where p.id = any(v_bot_ids);

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  select v_actor, 'soft_delete_account', 'soft_delete_account', 'profiles', bot_id::text,
    jsonb_build_object('reason', v_reason, 'performed_by', v_actor, 'automated', false, 'session', 'manual-review-2026-09-16')
  from unnest(v_bot_ids) as bot_id;

  raise notice 'Purged % bot accounts from the 2026-08-18 signup burst.', v_count;
end $$;
