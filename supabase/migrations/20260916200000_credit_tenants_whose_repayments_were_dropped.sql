-- Credit the tenants whose repayments the guard silently threw away.
--
-- WHAT HAPPENED TO THEM
-- Between 2026-09-15 15:12:23 UTC (drizzle 0114 went live in production) and
-- 2026-09-16 06:03:51 UTC (Josh Wanda's guard fix taught the guard to trust the
-- new leg shape), `guard_rent_request_agent_updates` recognised none of the
-- shapes the allocator was writing. It is a BEFORE trigger that REWRITES
-- `NEW.amount_repaid` back to the old value rather than raising, so for that
-- entire window every collection returned success, wrote its ledger legs, paid
-- its commission - and left the tenant's balance exactly where it was.
--
-- 875 collections were recorded inside that window. The agent took the money.
-- The tenant is still shown as owing it.
--
-- THIS IS THE ONLY PART OF THE INCIDENT THAT HURTS A CUSTOMER. The duplicate
-- collections cost the company; this costs a tenant, who can be chased for rent
-- they have already handed over. It is fixed first among the remaining work for
-- that reason.
--
-- WHY THIS TOUCHES NO LEDGER
-- The ledger is already correct. `create_ledger_transaction` ran BEFORE the
-- UPDATE, so the legs posted and survived; only the operational field on
-- `rent_requests` was rewritten. Posting anything here would count the same
-- money twice. This migration moves one column, and the status that follows
-- from it.
--
-- HOW MUCH, AND THE THREE THINGS THAT BOUND IT
--   * SCOPE: only plans collected against inside the window above.
--   * GENUINE ONLY: a repeat of the same agent+tenant+plan+amount within two
--     minutes is a re-tap and is excluded. Anything further apart is treated as
--     a real payment and IS credited - see 20260916180000 for why the rule is
--     deliberately narrow in the tenant's favour.
--   * CAPPED: a plan can never be credited past `total_repayment`. 21 plans
--     have a computed shortfall larger than they still owe, which means the
--     genuine set is still slightly generous for them; the cap is what makes
--     that safe.
--
--   144 plans short, raw shortfall  UGX 15,702,517
--   creditable after the cap        UGX  8,276,097
--
-- Checked before writing: NONE of these plans carries an ops balance edit, an
-- unallocation or a CFO decision since 2026-09-15, so no deliberate reduction
-- is being undone here.

DO $credit$
DECLARE
  r record;
  v_plans int := 0;
  v_credited numeric := 0;
  v_completed int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_logs
              WHERE action_type = 'repayment_restored_after_guard_drop') THEN
    RAISE NOTICE 'Already applied - tenant repayments were restored previously. Nothing done.';
    RETURN;
  END IF;

  FOR r IN
    WITH w AS (SELECT timestamptz '2026-09-15 15:12:23+00' AS t0,
                      timestamptz '2026-09-16 06:03:51+00' AS t1),
    window_plans AS (
      SELECT DISTINCT ac.rent_request_id
        FROM public.agent_collections ac CROSS JOIN w
       WHERE ac.created_at >= w.t0 AND ac.created_at < w.t1
    ),
    c AS (
      SELECT ac.rent_request_id, ac.amount, ac.created_at,
             lag(ac.created_at) OVER (PARTITION BY ac.agent_id, ac.rent_request_id, ac.amount
                                      ORDER BY ac.created_at) AS prev_at
        FROM public.agent_collections ac
       WHERE ac.rent_request_id IN (SELECT rent_request_id FROM window_plans)
         AND ac.reversed_at IS NULL
    ),
    genuine AS (
      SELECT rent_request_id, sum(amount) AS genuine_ever
        FROM c
       WHERE prev_at IS NULL OR created_at - prev_at > interval '2 minutes'
       GROUP BY rent_request_id
    )
    SELECT rr.id,
           rr.amount_repaid,
           rr.total_repayment,
           g.genuine_ever,
           least(greatest(0, g.genuine_ever - rr.amount_repaid),
                 greatest(0, rr.total_repayment - rr.amount_repaid)) AS credit
      FROM window_plans p
      JOIN genuine g ON g.rent_request_id = p.rent_request_id
      JOIN public.rent_requests rr ON rr.id = p.rent_request_id
     WHERE g.genuine_ever > rr.amount_repaid + 1
  LOOP
    CONTINUE WHEN r.credit < 1;

    UPDATE public.rent_requests
       SET amount_repaid = COALESCE(amount_repaid, 0) + r.credit,
           status = CASE
                      WHEN COALESCE(amount_repaid, 0) + r.credit >= COALESCE(total_repayment, 0)
                        THEN 'completed'
                      WHEN status IN ('disbursed', 'funded', 'approved') THEN 'repaying'
                      ELSE status END,
           updated_at = now()
     WHERE id = r.id;

    INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
    VALUES ('repayment_restored_after_guard_drop', 'rent_requests', r.id::text,
            'Repayment recorded by an agent 2026-09-15/16 but discarded by guard_rent_request_agent_updates',
            jsonb_build_object(
              'amount_repaid_before', r.amount_repaid,
              'credit_applied', r.credit,
              'genuine_collections_ever', r.genuine_ever,
              'total_repayment', r.total_repayment,
              'capped_at_outstanding', (r.genuine_ever - r.amount_repaid) > r.credit));

    v_plans := v_plans + 1;
    v_credited := v_credited + r.credit;
    IF r.amount_repaid + r.credit >= r.total_repayment THEN
      v_completed := v_completed + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'plans_credited=% total_credited=% newly_completed=%',
    v_plans, v_credited, v_completed;
END $credit$;

-- No plan may end up credited beyond what it owes.
DO $verify$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.rent_requests rr
    JOIN public.audit_logs a
      ON a.record_id = rr.id::text
     AND a.action_type = 'repayment_restored_after_guard_drop'
   WHERE rr.amount_repaid > rr.total_repayment + 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'over-credited % plan(s) - rolled back', v_bad;
  END IF;
END $verify$;
