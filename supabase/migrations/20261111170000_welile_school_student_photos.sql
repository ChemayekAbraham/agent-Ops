-- Welile Schools: a face photo for each registered student.
--
-- The agent takes the photo in-app at registration; it is saved to the private
-- `welile-school-photos` bucket at <school_id>/<profile_id>.jpg and the path is
-- kept on the profile. These are photos of children: the bucket is private and
-- only Welile Schools agents and ops (welile_schools_agent_ok) can read or write,
-- through signed URLs. JPEG only, 2 MB cap (the app sends ~40 KB).

alter table public.welile_school_profiles add column if not exists photo_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('welile-school-photos', 'welile-school-photos', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists welile_school_photos_insert on storage.objects;
create policy welile_school_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'welile-school-photos' and (select public.welile_schools_agent_ok()));

-- Needed for a retake: the upload overwrites <school_id>/<profile_id>.jpg.
drop policy if exists welile_school_photos_update on storage.objects;
create policy welile_school_photos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'welile-school-photos' and (select public.welile_schools_agent_ok()))
  with check (bucket_id = 'welile-school-photos' and (select public.welile_schools_agent_ok()));

drop policy if exists welile_school_photos_select on storage.objects;
create policy welile_school_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'welile-school-photos' and (select public.welile_schools_agent_ok()));
