-- submit_national_id_details -> national_id_name_twins compares person_name_key(full_name) and
-- person_name_key(national_id_name) for every profile row. With ~98k profiles and no index that is two regexp
-- evaluations per row per call, and the call hit the statement timeout (3 refusals, last 10-29 11:20 UTC).
-- person_name_key is IMMUTABLE, so an expression index serves the lookup (0.2 ms in a rolled-back plan check).
-- Applied to production by hand; this file is the record.
create index if not exists profiles_person_name_key_full_name_idx on public.profiles (public.person_name_key(full_name));
create index if not exists profiles_person_name_key_national_id_name_idx on public.profiles (public.person_name_key(national_id_name));
analyze public.profiles;
