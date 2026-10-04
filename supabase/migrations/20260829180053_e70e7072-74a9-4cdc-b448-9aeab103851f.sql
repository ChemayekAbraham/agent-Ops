-- Data correction: rows whose application stage was overwritten by the former
-- 'contacted' writer are restored to 'shortlisted'. The contact itself remains
-- recorded in contacted_at/contacted_by and is not altered. Rows with a null
-- shortlist_round are deliberately excluded, since there is no shortlist level
-- to restore them to.

-- Fingerprint guard: this statement touches personal data and must not run
-- against the wrong database.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_roles' and column_name = 'enabled'
  ) then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration is for RentFlow only.';
  end if;
end $$;

update public.job_applications
   set status = 'shortlisted'
 where status = 'contacted'
   and shortlist_round is not null;