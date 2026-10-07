-- Elite rank incentives (20261007180000_elite_rank_incentives.sql). One DO block that ends in an exception, so NOTHING is kept;
-- the report is the exception message. Run it AFTER the migration is applied.
-- Checks: (1) a ranked sub-agent gets the full 10% from get_agent_commission_rate and an unranked one still gets 8% + 2% override;
-- (2) both payment triggers exist and are the right shape; (3) the new functions are not callable by signed-in users;
-- (4) a ranked parent is paid UGX 5,000 once, and only once, for a sub-agent's tenant first funded plan (balanced ledger group, idempotent).
DO $$
DECLARE
  out text := ''; ranked uuid; plain_sub uuid; plain_parent uuid; r jsonb;
  parent uuid; sub uuid; rr record; before_n int; after_n int; after_n2 int; bal numeric;
BEGIN
  -- (1) commission split
  SELECT e.agent_id INTO ranked FROM agent_elite_ranks e JOIN agent_subagents sa ON sa.sub_agent_id = e.agent_id AND sa.status = 'verified' LIMIT 1;
  IF ranked IS NULL THEN
    out := out || E'\n(1a) skipped: no ranked agent is currently a verified sub-agent';
  ELSE
    r := get_agent_commission_rate(ranked);
    out := out || format(E'\n(1a) ranked sub-agent rate=%s recruiter_rate=%s  [expect 0.10 / 0]', r->>'agent_rate', r->>'recruiter_rate');
  END IF;
  SELECT sa.sub_agent_id INTO plain_sub FROM agent_subagents sa
   WHERE sa.status = 'verified' AND NOT EXISTS (SELECT 1 FROM agent_elite_ranks e WHERE e.agent_id = sa.sub_agent_id)
     AND NOT EXISTS (SELECT 1 FROM agent_subagent_commission_whitelist w WHERE w.sub_agent_id = sa.sub_agent_id AND w.whitelisted) LIMIT 1;
  r := get_agent_commission_rate(plain_sub);
  out := out || format(E'\n(1b) unranked, unwhitelisted sub-agent rate=%s recruiter_rate=%s  [expect 0.08 / 0.02]', r->>'agent_rate', r->>'recruiter_rate');

  -- (2) triggers
  out := out || format(E'\n(2) bounty trigger=%s second-degree trigger=%s  [expect 1 / 1]',
    (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_elite_subagent_tenant_bounty' AND NOT tgisinternal),
    (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_elite_second_degree_bonus' AND NOT tgisinternal));

  -- (3) grants
  out := out || format(E'\n(3) authenticated can execute bounty fn=%s bonus fn=%s  [expect false / false]',
    has_function_privilege('authenticated', 'public.credit_elite_subagent_tenant_bounty()', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.credit_elite_second_degree_bonus()', 'EXECUTE'));

  -- (4) bounty: a ranked parent with a sub-agent whose tenant has a plan not yet funded
  SELECT e.agent_id, sa.sub_agent_id INTO parent, sub FROM agent_elite_ranks e
    JOIN agent_subagents sa ON sa.parent_agent_id = e.agent_id AND sa.status = 'verified' LIMIT 1;
  IF parent IS NULL THEN
    out := out || E'\n(4) skipped: no ranked agent currently has a verified sub-agent';
  ELSE
    SELECT r2.id, r2.tenant_id INTO rr FROM rent_requests r2
     WHERE r2.agent_id = sub AND r2.status NOT IN ('funded','repaying','completed','rejected','deleted_by_agent','cancelled')
       AND NOT EXISTS (SELECT 1 FROM rent_requests o WHERE o.tenant_id = r2.tenant_id AND o.id <> r2.id AND o.status IN ('funded','repaying','completed')) LIMIT 1;
    IF rr.id IS NULL THEN
      out := out || E'\n(4) skipped: no unfunded first plan registered by that sub-agent';
    ELSE
      SELECT count(*) INTO before_n FROM general_ledger WHERE idempotency_key = 'elite_subagent_tenant_bounty:' || rr.tenant_id;
      PERFORM set_config('app.test_bypass', 'on', true);
      UPDATE rent_requests SET status = 'funded' WHERE id = rr.id;
      SELECT count(*) INTO after_n FROM general_ledger WHERE idempotency_key = 'elite_subagent_tenant_bounty:' || rr.tenant_id;
      UPDATE rent_requests SET status = 'repaying' WHERE id = rr.id;
      SELECT count(*) INTO after_n2 FROM general_ledger WHERE idempotency_key = 'elite_subagent_tenant_bounty:' || rr.tenant_id;
      SELECT coalesce(sum(CASE direction WHEN 'cash_in' THEN amount ELSE -amount END), 0) INTO bal
        FROM general_ledger WHERE idempotency_key = 'elite_subagent_tenant_bounty:' || rr.tenant_id;
      out := out || format(E'\n(4) ledger legs before=%s after funded=%s after repaying=%s net=%s  [expect 0 / 2 / 2 / 0; the wallet leg is UGX 5,000]', before_n, after_n, after_n2, bal);
    END IF;
  END IF;

  RAISE EXCEPTION E'elite_rank_incentives test report (rolled back):%', out;
END $$;
