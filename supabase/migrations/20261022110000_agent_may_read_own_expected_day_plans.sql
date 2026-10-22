-- Let an agent read their own pinned daily bill.
--
-- `agent_expected_day_plans` is the authoritative record of what each agent was
-- billed on a given day. Until now only ops roles could read it, so anything
-- agent-facing had to go through `agent_daily_eligibility_history` instead —
-- a snapshot written at 00:30 the FOLLOWING morning, which therefore never
-- contains today, and which (before 20261020160000) carried numbers the old
-- snapshot had invented rather than the bill itself.
--
-- That indirection is what made the weekly Rent Collections Report wrong: its
-- "Total Expected" came from the snapshot, so it missed 16 Oct entirely for all
-- 109 agents, missed today for everyone every day, and ran 2-3x high on 15, 17
-- and 18 Oct.
--
-- Reading the pin directly fixes all of that, including today, because the pin
-- is written at 00:05 on the day it covers.
--
-- Scope is strictly the agent's own rows. This exposes nothing new: the same
-- figures already reach the agent through get_agent_daily_eligibility (self
-- scope added 20261019120000) and through the capacity strip. Ops keep their
-- existing broader policy; permissive policies OR together.
CREATE POLICY "Agents read own expected day plans"
  ON public.agent_expected_day_plans
  FOR SELECT
  TO authenticated
  USING (auth.uid() = agent_id);
