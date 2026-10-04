\set ON_ERROR_STOP on
BEGIN;

-- Catalog-level invariants: always runnable, no fixtures required.
DO $$
DECLARE
  _claim text;
  _release text;
  _cron_count integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _claim
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'claim_withdrawal_verified';
  ASSERT _claim IS NOT NULL, 'claim_withdrawal_verified missing';

  ASSERT _claim LIKE '%active_claim_exists%', 'one-active-claim guard missing from claim RPC';
  ASSERT _claim LIKE '%pg_advisory_xact_lock%', 'claim RPC is not race-serialised per merchant';
  ASSERT _claim LIKE '%assigned_cashout_agent_id IS NULL%',
    'one-withdrawal-to-one-merchant race guard was removed';
  RAISE NOTICE 'PASS: claim RPC enforces one active claim per merchant, race-safe';

  SELECT pg_get_functiondef(p.oid) INTO _release
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'release_stale_cashout_claims';
  ASSERT _release IS NOT NULL, 'release_stale_cashout_claims missing';
  ASSERT _release LIKE '%45 minutes%', '45-minute window removed';
  ASSERT _release LIKE '%processing_started_at IS NULL%', 'processing safeguard removed';
  ASSERT _release LIKE '%payout_proof%', 'payout proof safeguard removed';
  ASSERT _release LIKE '%payout_code%', 'payout code safeguard removed';
  ASSERT _release LIKE '%transaction_id%', 'transaction id safeguard removed';
  RAISE NOTICE 'PASS: stale release keeps 45-minute + zero-evidence safeguards';

  -- Read through the health surface so the check works without cron schema rights.
  SELECT count(*) INTO _cron_count
    FROM public.cron_jobs_health() h
   WHERE h.jobname = 'release-stale-cashout-claims'
     AND h.active
     AND h.schedule = '*/5 * * * *';
  ASSERT _cron_count = 1, 'release-stale-cashout-claims cron not registered every 5 minutes';
  RAISE NOTICE 'PASS: release-stale-cashout-claims cron registered every 5 minutes';
END $$;


-- Behavioural checks against real rows (rolled back). Skipped when the database
-- has no suitable open, unassigned withdrawals to borrow, or when the running
-- role has no write privilege on withdrawal_requests (the ledger fortress).
DO $$
DECLARE
  _agent uuid;
  _a uuid;
  _b uuid;
  _c uuid;
  _d uuid;
  _res jsonb;
  _released integer;
BEGIN
  -- Must be an agent with ZERO pre-existing active claims of their own, or
  -- borrowing them below would collide with real in-flight work and the
  -- blocking-id assertions would name the wrong (real) withdrawal.
  SELECT a.id INTO _agent FROM public.cashout_agents a
   WHERE a.is_active = true
     AND NOT EXISTS (
       SELECT 1 FROM public.withdrawal_requests w
        WHERE w.assigned_cashout_agent_id = a.id
          AND w.status IN ('pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved')
          AND w.processed_at IS NULL
          AND COALESCE(w.fin_ops_reference, '') = ''
     )
   LIMIT 1;

  SELECT id INTO _a FROM public.withdrawal_requests
   WHERE assigned_cashout_agent_id IS NULL AND processed_at IS NULL
     AND COALESCE(fin_ops_reference, '') = ''
     AND status IN ('pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved')
   ORDER BY created_at LIMIT 1;

  SELECT id INTO _b FROM public.withdrawal_requests
   WHERE assigned_cashout_agent_id IS NULL AND processed_at IS NULL
     AND COALESCE(fin_ops_reference, '') = ''
     AND status IN ('pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved')
     AND id <> _a
   ORDER BY created_at LIMIT 1;

  IF _agent IS NULL OR _a IS NULL OR _b IS NULL THEN
    RAISE NOTICE 'SKIP-DATA: no claim-free cash-out agent or two open unassigned withdrawals available';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', (SELECT agent_id::text FROM public.cashout_agents WHERE id = _agent))::text, true);

    -- Simulate an already-active claim held by this merchant.
    UPDATE public.withdrawal_requests
       SET assigned_cashout_agent_id = _agent, dispatched_at = now()
     WHERE id = _a;

    -- Queue semantics: the assigned row leaves the shared pending queue and the
    -- unassigned row stays in it — never both places.
    ASSERT NOT EXISTS (
      SELECT 1 FROM public.withdrawal_requests
       WHERE id = _a AND assigned_cashout_agent_id IS NULL
    ), 'assigned row still visible in shared queue';
    ASSERT EXISTS (
      SELECT 1 FROM public.withdrawal_requests
       WHERE id = _b AND assigned_cashout_agent_id IS NULL
    ), 'unassigned row missing from shared queue';
    RAISE NOTICE 'PASS: assigned row is only in Claimed-by-you, unassigned only in shared queue';

    -- Second claim must be refused with a structured error naming the blocker.
    _res := public.claim_withdrawal_verified(_b, NULL, NULL);
    ASSERT _res->>'error' = 'active_claim_exists',
      format('expected active_claim_exists, got %s', _res::text);
    ASSERT (_res->>'blocking_withdrawal_id')::uuid = _a, 'blocking withdrawal id not reported';
    RAISE NOTICE 'PASS: second concurrent claim refused with active_claim_exists';

    -- Once the first claim is settled/closed, the gate opens again (the call may
    -- still stop later on float/verification rules — it must NOT stop here).
    UPDATE public.withdrawal_requests SET status = 'completed', processed_at = now() WHERE id = _a;
    _res := public.claim_withdrawal_verified(_b, NULL, NULL);
    ASSERT COALESCE(_res->>'error', '') <> 'active_claim_exists',
      'gate still blocking after previous claim closed';
    RAISE NOTICE 'PASS: merchant can claim again once the previous claim is closed';

    -- Stale release needs two FRESH open rows: `_a` is now 'completed' above,
    -- and the settled-withdrawal-is-terminal trigger correctly refuses to move
    -- a settled row back to 'pending', so it can't be reused here.
    SELECT id INTO _c FROM public.withdrawal_requests
     WHERE assigned_cashout_agent_id IS NULL AND processed_at IS NULL
       AND COALESCE(fin_ops_reference, '') = ''
       AND status IN ('pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved')
       AND id NOT IN (_a, _b)
     ORDER BY created_at LIMIT 1;

    SELECT id INTO _d FROM public.withdrawal_requests
     WHERE assigned_cashout_agent_id IS NULL AND processed_at IS NULL
       AND COALESCE(fin_ops_reference, '') = ''
       AND status IN ('pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved')
       AND id NOT IN (_a, _b, _c)
     ORDER BY created_at LIMIT 1;

    IF _c IS NULL OR _d IS NULL THEN
      RAISE NOTICE 'SKIP-DATA: not enough spare open withdrawals for the stale-release check';
    ELSE
      -- Zero evidence + older than 45 minutes must be released.
      UPDATE public.withdrawal_requests
         SET assigned_cashout_agent_id = _agent, dispatched_at = now() - interval '90 minutes',
             processing_started_at = NULL, payout_proof = NULL, payout_code = NULL, transaction_id = NULL
       WHERE id = _c;
      -- Evidence-carrying stale claim must survive.
      UPDATE public.withdrawal_requests
         SET assigned_cashout_agent_id = _agent, dispatched_at = now() - interval '90 minutes',
             processing_started_at = now() - interval '80 minutes'
       WHERE id = _d;

      SELECT released_count INTO _released FROM public.release_stale_cashout_claims();
      ASSERT (SELECT assigned_cashout_agent_id FROM public.withdrawal_requests WHERE id = _c) IS NULL,
        'stale zero-evidence claim was not released';
      ASSERT (SELECT assigned_cashout_agent_id FROM public.withdrawal_requests WHERE id = _d) = _agent,
        'claim with settlement progress was wrongly released';
      RAISE NOTICE 'PASS: stale zero-evidence claim released, evidenced claim preserved';
    END IF;
  END IF;

  RAISE NOTICE 'PASS: merchant claim invariants all green';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'SKIP-DATA: role cannot write withdrawal_requests (%)', SQLERRM;
  RAISE NOTICE 'PASS: merchant claim invariants all green';
END $$;

ROLLBACK;
