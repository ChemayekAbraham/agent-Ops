drop policy if exists ops_tutorials_insert_own on storage.objects;
create policy ops_tutorials_insert_own on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ops-tutorials'
    and exists (select 1 from public.ops_tutorial_videos v
                where v.storage_path = storage.objects.name
                  and v.uploaded_by = auth.uid()
                  and v.status = 'uploading'));

drop policy if exists ops_tutorials_select_viewable on storage.objects;
create policy ops_tutorials_select_viewable on storage.objects for select to authenticated
  using (
    bucket_id = 'ops-tutorials'
    and exists (select 1 from public.ops_tutorial_videos v
                where v.storage_path = storage.objects.name
                  and public.ops_tutorial_can_view_video(v.id)));