create or replace function public.ops_tutorial_set_member(p_email text, p_role text, p_enabled boolean, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_n int; v_old boolean;
begin
  if not public.hr_is_admin() then raise exception 'Only HR can manage tutorial members'; end if;
  select count(*), min(id::text)::uuid into v_n, v_uid from public.profiles where lower(email) = lower(btrim(p_email));
  if v_n <> 1 then raise exception 'No single profile has that email'; end if;
  if not coalesce(public.is_welile_staff(v_uid), false) then raise exception 'That person is not Welile staff'; end if;
  if p_role is null or p_role not in ('creator','reviewer') then raise exception 'Unknown member role'; end if;
  select enabled into v_old from public.ops_tutorial_members where user_id = v_uid and member_role = p_role;
  insert into public.ops_tutorial_members (user_id, member_role, enabled, note, added_by)
  values (v_uid, p_role, coalesce(p_enabled, true), p_note, auth.uid())
  on conflict (user_id, member_role) do update set enabled = excluded.enabled, note = excluded.note, added_by = excluded.added_by;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_member_set', 'ops_tutorial_members', v_uid::text,
    jsonb_build_object('member_role', p_role, 'old_enabled', v_old, 'new_enabled', coalesce(p_enabled, true), 'note', p_note));
  return v_uid;
end $$;

create or replace function public.ops_tutorial_members_list()
returns table(user_id uuid, full_name text, email text, member_role text, enabled boolean, note text, added_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.hr_is_admin() or public.ops_tutorial_is_member('reviewer')) then raise exception 'Not allowed'; end if;
  return query
    select m.user_id, p.full_name::text, p.email::text, m.member_role, m.enabled, m.note, m.added_at
      from public.ops_tutorial_members m left join public.profiles p on p.id = m.user_id
     order by m.added_at desc;
end $$;

create or replace function public.ops_tutorial_set_rate(p_tier text, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_old numeric;
begin
  if not public.hr_is_admin() then raise exception 'Only HR can set tutorial rates'; end if;
  if p_tier is null or p_tier not in ('basic','standard','advanced','revision') then raise exception 'Unknown tier'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Rate must be zero or more'; end if;
  select amount_ugx into v_old from public.ops_tutorial_rates where tier = p_tier;
  insert into public.ops_tutorial_rates (tier, amount_ugx, updated_by, updated_at)
  values (p_tier, p_amount, auth.uid(), now())
  on conflict (tier) do update set amount_ugx = excluded.amount_ugx, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_rate_set', 'ops_tutorial_rates', p_tier,
    jsonb_build_object('old_values', case when v_old is null then null else jsonb_build_object('amount_ugx', v_old) end,
                       'new_values', jsonb_build_object('amount_ugx', p_amount)));
end $$;

create or replace function public.ops_tutorial_set_topic_status(p_topic_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare t public.ops_tutorial_topics;
begin
  if not public.ops_tutorial_is_member('reviewer') then raise exception 'Only a tutorial reviewer can do this'; end if;
  if p_status is null or p_status not in ('open','closed') then raise exception 'Unknown topic status'; end if;
  select * into t from public.ops_tutorial_topics where id = p_topic_id for update;
  if not found then raise exception 'Topic not found'; end if;
  update public.ops_tutorial_topics
     set status = p_status,
         approved_by = case when p_status = 'open' and t.status = 'proposed' then auth.uid() else approved_by end,
         approved_at = case when p_status = 'open' and t.status = 'proposed' then now() else approved_at end
   where id = p_topic_id;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_topic_status', 'ops_tutorial_topics', p_topic_id::text,
    jsonb_build_object('old_status', t.status, 'new_status', p_status));
end $$;

create or replace function public.ops_tutorial_log_view(p_video_id uuid, p_context text, p_position_seconds numeric, p_requisition_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_dur numeric; v_pos numeric;
begin
  if not coalesce(public.ops_tutorial_can_view_video(p_video_id), false) then raise exception 'Not allowed'; end if;
  if p_context is null or p_context not in ('review','approval','library','own') then raise exception 'Unknown view context'; end if;
  if p_context = 'approval' and p_requisition_id is null then raise exception 'Approval views need a requisition'; end if;
  select duration_seconds into v_dur from public.ops_tutorial_videos where id = p_video_id;
  v_pos := least(greatest(coalesce(p_position_seconds, 0), 0), coalesce(v_dur, 0));
  insert into public.ops_tutorial_view_events (video_id, viewer_id, context, requisition_id, max_position_seconds, duration_seconds, last_seen_at)
  values (p_video_id, auth.uid(), p_context, p_requisition_id, v_pos, v_dur, now())
  on conflict (video_id, viewer_id, context, coalesce(requisition_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set max_position_seconds = greatest(ops_tutorial_view_events.max_position_seconds, excluded.max_position_seconds),
                last_seen_at = now(), duration_seconds = excluded.duration_seconds;
end $$;

create or replace function public.ops_tutorial_accept(p_video_id uuid, p_no_personal_data boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v public.ops_tutorial_videos; v_tier text; v_rate numeric; v_watched numeric;
begin
  if not public.ops_tutorial_is_member('reviewer') then raise exception 'Only a tutorial reviewer can do this'; end if;
  select * into v from public.ops_tutorial_videos where id = p_video_id for update;
  if not found then raise exception 'Video not found'; end if;
  if v.uploaded_by = auth.uid() then raise exception 'You cannot accept your own video'; end if;
  if v.status <> 'submitted' then raise exception 'Only a submitted video can be accepted'; end if;
  if p_no_personal_data is not true then raise exception 'Confirm that no real tenant, landlord, agent or staff personal data is visible'; end if;
  select max(max_position_seconds) into v_watched from public.ops_tutorial_view_events
   where video_id = p_video_id and viewer_id = auth.uid() and context = 'review';
  if v_watched is null or v.duration_seconds is null or v_watched < 0.5 * v.duration_seconds then
    raise exception 'Watch at least half of % before accepting (you have watched %%%)', v.video_code,
      round(100 * coalesce(v_watched, 0) / nullif(v.duration_seconds, 0));
  end if;
  if v.kind = 'revision' then v_tier := 'revision';
  else select tier into v_tier from public.ops_tutorial_topics where id = v.topic_id; end if;
  select amount_ugx into v_rate from public.ops_tutorial_rates where tier = v_tier;
  if v_rate is null or v_rate <= 0 then
    raise exception 'Rate for tier % is not set — HR must set the rate card first', v_tier;
  end if;
  update public.ops_tutorial_videos
     set status = 'accepted', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note,
         no_personal_data_confirmed = true, rate_tier = v_tier, rate_amount = v_rate
   where id = p_video_id;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_accepted', 'ops_tutorial_videos', p_video_id::text,
    jsonb_build_object('video_code', v.video_code, 'rate_tier', v_tier, 'rate_amount', v_rate));
end $$;

create or replace function public.ops_tutorial_reject(p_video_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v public.ops_tutorial_videos;
begin
  if not public.ops_tutorial_is_member('reviewer') then raise exception 'Only a tutorial reviewer can do this'; end if;
  select * into v from public.ops_tutorial_videos where id = p_video_id for update;
  if not found then raise exception 'Video not found'; end if;
  if v.uploaded_by = auth.uid() then raise exception 'You cannot reject your own video'; end if;
  if v.status <> 'submitted' then raise exception 'Only a submitted video can be rejected'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'Give the creator a reason (at least 10 characters)'; end if;
  update public.ops_tutorial_videos
     set status = 'rejected', review_note = btrim(p_reason), reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_video_id;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_rejected', 'ops_tutorial_videos', p_video_id::text,
    jsonb_build_object('video_code', v.video_code, 'reason', btrim(p_reason)));
end $$;

create or replace function public.ops_tutorial_set_published(p_video_id uuid, p_published boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v public.ops_tutorial_videos;
begin
  if not public.ops_tutorial_is_member('reviewer') then raise exception 'Only a tutorial reviewer can do this'; end if;
  select * into v from public.ops_tutorial_videos where id = p_video_id for update;
  if not found then raise exception 'Video not found'; end if;
  if v.status <> 'accepted' then raise exception 'Only an accepted video can be published'; end if;
  if p_published then
    update public.ops_tutorial_videos set published_at = now(), published_by = auth.uid() where id = p_video_id;
    if v.kind = 'revision' and v.supersedes_video_id is not null then
      update public.ops_tutorial_videos set published_at = null where id = v.supersedes_video_id;
    end if;
  else
    update public.ops_tutorial_videos set published_at = null, published_by = null where id = p_video_id;
  end if;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_published', 'ops_tutorial_videos', p_video_id::text,
    jsonb_build_object('video_code', v.video_code, 'published', p_published, 'superseded_unpublished', case when p_published and v.kind = 'revision' then v.supersedes_video_id end));
end $$;

revoke all on function public.ops_tutorial_set_member(text, text, boolean, text) from public, anon;
revoke all on function public.ops_tutorial_members_list() from public, anon;
revoke all on function public.ops_tutorial_set_rate(text, numeric) from public, anon;
revoke all on function public.ops_tutorial_set_topic_status(uuid, text) from public, anon;
revoke all on function public.ops_tutorial_log_view(uuid, text, numeric, uuid) from public, anon;
revoke all on function public.ops_tutorial_accept(uuid, boolean, text) from public, anon;
revoke all on function public.ops_tutorial_reject(uuid, text) from public, anon;
revoke all on function public.ops_tutorial_set_published(uuid, boolean) from public, anon;
grant execute on function public.ops_tutorial_set_member(text, text, boolean, text) to authenticated;
grant execute on function public.ops_tutorial_members_list() to authenticated;
grant execute on function public.ops_tutorial_set_rate(text, numeric) to authenticated;
grant execute on function public.ops_tutorial_set_topic_status(uuid, text) to authenticated;
grant execute on function public.ops_tutorial_log_view(uuid, text, numeric, uuid) to authenticated;
grant execute on function public.ops_tutorial_accept(uuid, boolean, text) to authenticated;
grant execute on function public.ops_tutorial_reject(uuid, text) to authenticated;
grant execute on function public.ops_tutorial_set_published(uuid, boolean) to authenticated;