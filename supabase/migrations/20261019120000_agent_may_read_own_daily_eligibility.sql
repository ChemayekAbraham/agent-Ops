-- An agent may read their own daily eligibility row.
--
-- get_agent_daily_eligibility is gated on can_view_staff_reports(auth.uid()),
-- which asks "is this person staff". The function's primary consumer is the
-- agent's own capacity card, and an agent is not staff, so every ordinary agent
-- calling it for their own id got:
--
--   ERROR: 42501: not authorized
--   CONTEXT: PL/pgSQL function get_agent_daily_eligibility(uuid[]) line 1
--
-- Verified against production with a valid session: auth.uid() resolved
-- correctly to the agent's own id and can_view_staff_reports still returned
-- false, because the agent holds only tenant/agent/landlord/supporter roles and
-- no staff_permissions row.
--
-- The damage was not a blank card. useAgentCapacityMap falls back to client-side
-- target math for the DENOMINATOR when this RPC fails, while every numerator and
-- percentage stays 0 — so the failure rendered as "UGX 0 of UGX 550,012 · 0% ·
-- Very Bad" and set can_post_rent_today = false. Agents who had collected well
-- past the 50% law were told they had collected nothing and were blocked from
-- posting new Rent Plans by their own app, while the database trigger (which
-- reaches the real numbers through the pg_trigger_depth escape) would have
-- allowed them.
--
-- The staff check stays: it is what lets Agent Ops pull the whole fleet. This
-- adds one narrow escape — a caller asking ONLY about themselves. Containment
-- against a single-element array means any id other than their own, or a null
-- auth.uid(), still fails.
DO $mig$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_daily_eligibility';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_agent_daily_eligibility not found';
  END IF;

  v_old := 'if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then';

  v_new := 'if not (
      pg_trigger_depth() > 0
      or public.can_view_staff_reports(auth.uid())
      or (
        auth.uid() is not null
        and p_agent_ids is not null
        and array_length(p_agent_ids, 1) is not null
        and p_agent_ids <@ array[auth.uid()]
      )
    ) then';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'get_agent_daily_eligibility: staff gate not found in the shape this migration expects';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;
