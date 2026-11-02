-- Agent assistant: widen "is this person an agent" so agents without collection receipts yet
-- (a house-only lister, a new agent with a first Rent Plan request, a parent with sub-agents) get
-- their data tools instead of a "nothing to show" reply.
--
-- An agent footprint is now ANY of: a collection receipt, the agent role, a Rent Plan they
-- registered or manage, a house listing they posted, or a sub-agent link in either direction.
-- Identity still comes from auth.uid() only. This function grants no access by itself: every tool
-- still reads only rows belonging to the caller. It only decides whether the data tools are
-- offered, and an agent with no rows simply gets empty results.
create or replace function public.assistant_is_agent()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and (
       exists (select 1 from public.agent_collections ac where ac.agent_id = auth.uid())
       or exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'agent')
       or exists (select 1 from public.rent_requests rr where rr.agent_id = auth.uid() or rr.assigned_agent_id = auth.uid())
       or exists (select 1 from public.house_listings h where h.agent_id = auth.uid())
       or exists (select 1 from public.agent_subagents sa where sa.parent_agent_id = auth.uid() or sa.sub_agent_id = auth.uid())
     );
$$;

-- CREATE OR REPLACE keeps the existing grants; restated so a rebuild from the folder is the same.
revoke execute on function public.assistant_is_agent() from public, anon;
grant  execute on function public.assistant_is_agent() to authenticated, service_role;