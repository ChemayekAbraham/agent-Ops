-- Scaffolding from the 2026-10-19 agent-collections audit. These two tables
-- captured the pre-change state of agent_expected_day_plans and
-- v_agent_daily_eligibility so the migrations could be proved not to have moved
-- anything they should not. Verification is done and recorded; drop them so they
-- do not leak into generated schema types.
DROP TABLE IF EXISTS public._audit_pin_before_20261019;
DROP TABLE IF EXISTS public._audit_elig_before_20261019;
