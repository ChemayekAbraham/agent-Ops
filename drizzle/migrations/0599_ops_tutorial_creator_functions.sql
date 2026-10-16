create or replace function public.ops_tutorial_propose_topic(p_title text, p_description text, p_tier text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_rev boolean;
begin
  if not (public.ops_tutorial_is_member('creator') or public.ops_tutorial_is_member('reviewer')) then
    raise exception 'Not a tutorial creator or reviewer';
  end if;
  if p_tier is null or p_tier not in ('basic','standard','advanced') then
    raise exception 'Unknown tier';
  end if;
  v_rev := public.ops_tutorial_is_member('reviewer');
  insert into public.ops_tutorial_topics (title, description, tier, status, proposed_by, approved_by, approved_at)
  values (p_title, p_description, p_tier,
          case when v_rev then 'open' else 'proposed' end, auth.uid(),
          case when v_rev then auth.uid() end, case when v_rev then now() end)
  returning id into v_id;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_topic_proposed', 'ops_tutorial_topics', v_id::text,
          jsonb_build_object('title', p_title, 'tier', p_tier, 'status', case when v_rev then 'open' else 'proposed' end));
  return v_id;
end $$;

create or replace function public.ops_tutorial_register_upload(p_topic_id uuid, p_kind text, p_supersedes_video_id uuid, p_revision_reason text,
  p_title text, p_sha256 text, p_size_bytes bigint, p_duration_seconds numeric, p_video_codec text, p_recorded_on date)
returns table(video_id uuid, video_code text, storage_path text, resumed boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_sha text := lower(p_sha256); v_existing record; v_topic record; v_orig text; v_id uuid := gen_random_uuid(); v_path text; v_code text;
begin
  if not public.ops_tutorial_is_member('creator') then
    raise exception 'Only a tutorial creator can upload';
  end if;
  select v.id, v.video_code, v.storage_path, v.status, v.uploaded_by into v_existing
    from public.ops_tutorial_videos v where v.sha256 = v_sha and v.status <> 'withdrawn' limit 1;
  if found then
    if v_existing.uploaded_by = auth.uid() and v_existing.status = 'uploading' then
      return query select v_existing.id, v_existing.video_code, v_existing.storage_path, true;
      return;
    end if;
    raise exception 'Duplicate file: this exact video is already registered as % (%)', v_existing.video_code, v_existing.status;
  end if;
  select t.id, t.topic_code, t.status into v_topic from public.ops_tutorial_topics t where t.id = p_topic_id;
  if not found or v_topic.status <> 'open' then
    raise exception 'This topic is not open for uploads';
  end if;
  if p_kind = 'original' then
    select v.video_code into v_orig from public.ops_tutorial_videos v
      where v.topic_id = p_topic_id and v.kind = 'original' and v.status in ('uploading','draft','submitted','accepted') limit 1;
    if found then
      raise exception 'Topic % already has an original (%). Upload a revision instead.', v_topic.topic_code, v_orig;
    end if;
  elsif p_kind = 'revision' then
    if not exists (select 1 from public.ops_tutorial_videos v where v.id = p_supersedes_video_id and v.topic_id = p_topic_id and v.status = 'accepted') then
      raise exception 'A revision must replace an accepted video on the same topic';
    end if;
    if length(btrim(coalesce(p_revision_reason, ''))) < 10 then
      raise exception 'Say why this revision is needed (at least 10 characters)';
    end if;
  end if;
  if p_size_bytes > 524288000 then
    raise exception 'Video is larger than 500 MB';
  end if;
  v_path := auth.uid()::text || '/' || v_id::text || '.mp4';
  insert into public.ops_tutorial_videos (id, topic_id, kind, supersedes_video_id, revision_reason, title, uploaded_by, storage_path,
    sha256, size_bytes, duration_seconds, mime_type, video_codec, recorded_on, status)
  values (v_id, p_topic_id, p_kind, case when p_kind = 'revision' then p_supersedes_video_id end,
    case when p_kind = 'revision' then p_revision_reason end, p_title, auth.uid(), v_path,
    v_sha, p_size_bytes, p_duration_seconds, 'video/mp4', p_video_codec, p_recorded_on, 'uploading')
  returning ops_tutorial_videos.video_code into v_code;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_upload_registered', 'ops_tutorial_videos', v_id::text,
    jsonb_build_object('video_code', v_code, 'topic_id', p_topic_id, 'kind', p_kind, 'supersedes_video_id', p_supersedes_video_id,
      'sha256', v_sha, 'size_bytes', p_size_bytes, 'storage_path', v_path));
  return query select v_id, v_code, v_path, false;
end $$;

create or replace function public.ops_tutorial_mark_uploaded(p_video_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v record;
begin
  select * into v from public.ops_tutorial_videos where id = p_video_id and uploaded_by = auth.uid() and status = 'uploading' for update;
  if not found then
    raise exception 'Nothing to finalise for this video';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'ops-tutorials' and o.name = v.storage_path
                 and (o.metadata->>'size')::bigint = v.size_bytes) then
    raise exception 'Upload not found or size does not match — retry the upload';
  end if;
  update public.ops_tutorial_videos set status = 'draft', uploaded_at = now() where id = p_video_id;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_uploaded', 'ops_tutorial_videos', p_video_id::text,
    jsonb_build_object('video_code', v.video_code, 'storage_path', v.storage_path, 'size_bytes', v.size_bytes));
end $$;

create or replace function public.ops_tutorial_submit(p_video_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  update public.ops_tutorial_videos set status = 'submitted', submitted_at = now()
   where id = p_video_id and uploaded_by = auth.uid() and status = 'draft'
   returning video_code into v_code;
  if not found then
    raise exception 'Only a draft can be submitted';
  end if;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_submitted', 'ops_tutorial_videos', p_video_id::text,
    jsonb_build_object('video_code', v_code, 'status', 'submitted'));
end $$;

create or replace function public.ops_tutorial_withdraw(p_video_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_code text; v_prev text;
begin
  select status into v_prev from public.ops_tutorial_videos where id = p_video_id and uploaded_by = auth.uid() for update;
  update public.ops_tutorial_videos set status = 'withdrawn'
   where id = p_video_id and uploaded_by = auth.uid() and status in ('uploading','draft','submitted')
   returning video_code into v_code;
  if not found then
    raise exception 'Only an unreviewed video can be withdrawn';
  end if;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_withdrawn', 'ops_tutorial_videos', p_video_id::text,
    jsonb_build_object('video_code', v_code, 'previous_status', v_prev, 'status', 'withdrawn'));
end $$;

revoke all on function public.ops_tutorial_propose_topic(text, text, text) from public, anon;
revoke all on function public.ops_tutorial_register_upload(uuid, text, uuid, text, text, text, bigint, numeric, text, date) from public, anon;
revoke all on function public.ops_tutorial_mark_uploaded(uuid) from public, anon;
revoke all on function public.ops_tutorial_submit(uuid) from public, anon;
revoke all on function public.ops_tutorial_withdraw(uuid) from public, anon;
grant execute on function public.ops_tutorial_propose_topic(text, text, text) to authenticated;
grant execute on function public.ops_tutorial_register_upload(uuid, text, uuid, text, text, text, bigint, numeric, text, date) to authenticated;
grant execute on function public.ops_tutorial_mark_uploaded(uuid) to authenticated;
grant execute on function public.ops_tutorial_submit(uuid) to authenticated;
grant execute on function public.ops_tutorial_withdraw(uuid) to authenticated;