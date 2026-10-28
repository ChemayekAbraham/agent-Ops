-- Sub-agent self-signup was refused on every attempt (41 RLS errors a day, doc 247 step 47a).
-- BEFORE INSERT trigger trg_auto_verify_subagent turns status 'pending' into 'verified', and the
-- insert policy then checked status = 'pending' on the row as changed by the trigger, so no
-- insert could ever pass. The policy now accepts the status the trigger produces.
-- Still limited to the caller being the parent or the sub-agent on the row.
-- Applied to production by hand; this file is the record.
alter policy "Allow subagent relationship creation" on public.agent_subagents
  with check (
    (((select auth.uid()) = parent_agent_id) or ((select auth.uid()) = sub_agent_id))
    and status in ('pending', 'verified')
  );
