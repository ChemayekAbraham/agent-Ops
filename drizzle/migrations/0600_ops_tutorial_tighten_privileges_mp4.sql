revoke delete, truncate, references, trigger on public.ops_tutorial_members, public.ops_tutorial_rates,
  public.ops_tutorial_topics, public.ops_tutorial_videos, public.ops_tutorial_view_events,
  public.ops_tutorial_claims, public.ops_tutorial_claim_lines from service_role;

create or replace function public.ops_tutorial_mark_uploaded(p_video_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  if not exists (select 1 from storage.objects o where o.bucket_id = 'ops-tutorials' and o.name = v.storage_path
                 and coalesce(o.metadata->>'mimetype', '') = 'video/mp4') then
    raise exception 'This upload is not an MP4 file — withdraw it and upload an MP4 (H.264)';
  end if;
  update public.ops_tutorial_videos set status = 'draft', uploaded_at = now() where id = p_video_id;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_uploaded', 'ops_tutorial_videos', p_video_id::text,
    jsonb_build_object('video_code', v.video_code, 'storage_path', v.storage_path, 'size_bytes', v.size_bytes));
end $function$;

revoke all on function public.ops_tutorial_mark_uploaded(uuid) from public, anon;
grant execute on function public.ops_tutorial_mark_uploaded(uuid) to authenticated;