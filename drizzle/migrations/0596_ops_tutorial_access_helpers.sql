create or replace function public.ops_tutorial_is_member(_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ops_tutorial_members m
                 where m.user_id = auth.uid() and m.member_role = _role and m.enabled);
$$;

create or replace function public.ops_tutorial_can_view_claim(_claim_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ops_tutorial_claims c
    left join public.staff_requisitions s on s.id = c.requisition_id
    where c.id = _claim_id and (
      c.creator_id = auth.uid()
      or public.ops_tutorial_is_member('reviewer')
      or public.hr_is_admin()
      or (s.id is not null and (
           auth.uid() = s.supervisor_decided_by or auth.uid() = s.coo_decided_by
        or auth.uid() = s.ceo_decided_by or auth.uid() = s.cfo_decided_by
        or exists (select 1 from public.staff_requisition_offices o
                   where o.holder_id = auth.uid() and o.office_key in ('coo','ceo','cfo'))
        or exists (select 1 from public.user_roles ur
                   where ur.user_id = auth.uid() and ur.enabled
                     and ur.role::text = s.current_approver_role)))));
$$;

create or replace function public.ops_tutorial_can_view_video(_video_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ops_tutorial_videos v
    where v.id = _video_id and (
      v.uploaded_by = auth.uid()
      or public.ops_tutorial_is_member('reviewer')
      or public.hr_is_admin()
      or (v.status = 'accepted' and v.published_at is not null
          and coalesce(public.is_welile_staff(auth.uid()), false))
      or exists (select 1 from public.ops_tutorial_claim_lines l
                 where l.video_id = v.id and public.ops_tutorial_can_view_claim(l.claim_id))));
$$;

create or replace function public.ops_tutorial_my_capabilities()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'is_staff',    coalesce(public.is_welile_staff(auth.uid()), false),
    'is_creator',  public.ops_tutorial_is_member('creator'),
    'is_reviewer', public.ops_tutorial_is_member('reviewer'),
    'is_admin',    public.hr_is_admin());
$$;

revoke all on function public.ops_tutorial_is_member(text) from public, anon;
revoke all on function public.ops_tutorial_can_view_claim(uuid) from public, anon;
revoke all on function public.ops_tutorial_can_view_video(uuid) from public, anon;
revoke all on function public.ops_tutorial_my_capabilities() from public, anon;
grant execute on function public.ops_tutorial_is_member(text) to authenticated;
grant execute on function public.ops_tutorial_can_view_claim(uuid) to authenticated;
grant execute on function public.ops_tutorial_can_view_video(uuid) to authenticated;
grant execute on function public.ops_tutorial_my_capabilities() to authenticated;

revoke insert, update, delete on public.ops_tutorial_members, public.ops_tutorial_rates,
  public.ops_tutorial_topics, public.ops_tutorial_videos, public.ops_tutorial_view_events,
  public.ops_tutorial_claims, public.ops_tutorial_claim_lines from anon, authenticated;
revoke select on public.ops_tutorial_members, public.ops_tutorial_rates,
  public.ops_tutorial_topics, public.ops_tutorial_videos, public.ops_tutorial_view_events,
  public.ops_tutorial_claims, public.ops_tutorial_claim_lines from anon;

drop policy if exists ops_tutorial_members_select on public.ops_tutorial_members;
create policy ops_tutorial_members_select on public.ops_tutorial_members for select to authenticated
  using (user_id = auth.uid() or public.ops_tutorial_is_member('reviewer') or public.hr_is_admin());

drop policy if exists ops_tutorial_rates_select on public.ops_tutorial_rates;
create policy ops_tutorial_rates_select on public.ops_tutorial_rates for select to authenticated
  using (coalesce(public.is_welile_staff(auth.uid()), false));

drop policy if exists ops_tutorial_topics_select on public.ops_tutorial_topics;
create policy ops_tutorial_topics_select on public.ops_tutorial_topics for select to authenticated
  using (coalesce(public.is_welile_staff(auth.uid()), false));

drop policy if exists ops_tutorial_videos_select on public.ops_tutorial_videos;
create policy ops_tutorial_videos_select on public.ops_tutorial_videos for select to authenticated
  using (public.ops_tutorial_can_view_video(id));

drop policy if exists ops_tutorial_view_events_select on public.ops_tutorial_view_events;
create policy ops_tutorial_view_events_select on public.ops_tutorial_view_events for select to authenticated
  using (viewer_id = auth.uid() or public.ops_tutorial_is_member('reviewer') or public.hr_is_admin());

drop policy if exists ops_tutorial_claims_select on public.ops_tutorial_claims;
create policy ops_tutorial_claims_select on public.ops_tutorial_claims for select to authenticated
  using (public.ops_tutorial_can_view_claim(id));

drop policy if exists ops_tutorial_claim_lines_select on public.ops_tutorial_claim_lines;
create policy ops_tutorial_claim_lines_select on public.ops_tutorial_claim_lines for select to authenticated
  using (public.ops_tutorial_can_view_claim(claim_id));