-- sync_agent_team_membership_history() only fires on INSERT OR UPDATE OF
-- status, parent_agent_id on agent_subagents. Every unlink path
-- (admin_unlink_subagent, agent_unlink_subagent, release_sub_agent) removes
-- the sub-agent by DELETE, which never fires that trigger, so
-- agent_team_membership_history kept reporting the sub-agent as current
-- forever. Found 2026-09-16: Timothy Kalyango's 3 sub-agents were unlinked
-- from agent_subagents but the history table still showed all 3 as active,
-- so anything reading team size from that table (the source used to answer
-- "how many sub-agents does X have") kept the stale count. Manually closed
-- those 3 rows; this trigger closes any future ones automatically.
create or replace function public.close_agent_team_membership_history_on_unlink()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.agent_team_membership_history
     set valid_to = now()
   where parent_agent_id = OLD.parent_agent_id
     and member_agent_id = OLD.sub_agent_id
     and valid_to is null;
  return OLD;
end;
$$;

drop trigger if exists trg_close_agent_team_membership_history_on_unlink on public.agent_subagents;
create trigger trg_close_agent_team_membership_history_on_unlink
after delete on public.agent_subagents
for each row execute function public.close_agent_team_membership_history_on_unlink();
