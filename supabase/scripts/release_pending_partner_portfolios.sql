-- Release the partner portfolios that are still waiting for Partner Ops.
--
-- This is NOT a migration. Do not run it as part of applying migrations.
-- Benjamin must approve it separately, after:
--   1. 20261114120000_funder_direct_release_to_agent_float.sql has been applied, and
--   2. pipeline_switches.key = 'funder_direct_release' has been turned ON.
--
-- On 11 Nov 2026 the waiting set was 7 self-managed portfolios, UGX 2,550,000.
-- The SELECT below is the live list. Read it before releasing anything.
--
-- What the release does: each pending self-managed portfolio is passed to
-- _approve_pending_portfolio_core as that portfolio's funder. That is the same
-- debit, Welile Cover, and rent-only agent float as a normal approval.
-- A plan with no assigned agent is skipped and reported. It is not sent
-- anywhere else.
--
-- STEP 1. Dry run. Run this SELECT on its own and stop.

SELECT
  fp.portfolio_id,
  fp.funder_id,
  fp.amount,
  fp.created_at,
  fp.commitment_id,
  ip.status AS portfolio_status,
  (
    SELECT count(*)
      FROM public.partner_self_funding_lines l
     WHERE l.commitment_id = fp.commitment_id
  ) AS lines,
  (
    SELECT count(*)
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
     WHERE l.commitment_id = fp.commitment_id
       AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NULL
  ) AS lines_without_agent,
  (
    SELECT COALESCE(sum(l.principal), 0)
      FROM public.partner_self_funding_lines l
     WHERE l.commitment_id = fp.commitment_id
  ) AS line_principal
FROM public.funder_pending_portfolios fp
JOIN public.investor_portfolios ip ON ip.id = fp.portfolio_id
WHERE fp.status = 'pending'
  AND fp.source = 'self_managed'
  AND ip.status IN ('pending_ops_approval', 'awaiting_partner_details')
ORDER BY fp.created_at;

-- Totals for the same set.
SELECT
  count(*) AS portfolios,
  COALESCE(sum(fp.amount), 0) AS amount_ugx
FROM public.funder_pending_portfolios fp
JOIN public.investor_portfolios ip ON ip.id = fp.portfolio_id
WHERE fp.status = 'pending'
  AND fp.source = 'self_managed'
  AND ip.status IN ('pending_ops_approval', 'awaiting_partner_details');

-- STEP 2. Release. Do not run this until Benjamin says yes.
-- In one session:
--
--   BEGIN;
--   SET LOCAL welile.funder_direct_backlog = 'release';
--   -- then run the DO block below
--   -- read the notices
--   COMMIT;   -- or ROLLBACK;
--
-- Running this file from top to bottom without that setting raises here and
-- moves no money. The SELECT above has no side effects.

DO $release$
DECLARE
  r record;
  v_released integer := 0;
  v_skipped integer := 0;
BEGIN
  IF coalesce(current_setting('welile.funder_direct_backlog', true), '') IS DISTINCT FROM 'release' THEN
    RAISE EXCEPTION
      'Dry run only. After Benjamin approves, SET LOCAL welile.funder_direct_backlog = ''release'' and run this block again.';
  END IF;

  IF NOT public._pipeline_switch_on('funder_direct_release') THEN
    RAISE EXCEPTION 'funder_direct_release is OFF. Turn the switch on before releasing the backlog.';
  END IF;

  FOR r IN
    SELECT fp.portfolio_id, fp.funder_id, fp.commitment_id, fp.amount
      FROM public.funder_pending_portfolios fp
      JOIN public.investor_portfolios ip ON ip.id = fp.portfolio_id
     WHERE fp.status = 'pending'
       AND fp.source = 'self_managed'
       AND ip.status IN ('pending_ops_approval', 'awaiting_partner_details')
     ORDER BY fp.created_at
     FOR UPDATE OF fp
  LOOP
    IF EXISTS (
      SELECT 1
        FROM public.partner_self_funding_lines l
        JOIN public.rent_requests rr ON rr.id = l.rent_request_id
       WHERE l.commitment_id = r.commitment_id
         AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NULL
    ) THEN
      v_skipped := v_skipped + 1;
      RAISE WARNING 'skipped portfolio % (UGX %): a Rent Plan has no assigned agent', r.portfolio_id, r.amount;
      CONTINUE;
    END IF;

    BEGIN
      PERFORM set_config('app.funder_direct_release', 'on', true);
      PERFORM public._approve_pending_portfolio_core(r.portfolio_id, r.funder_id);
      v_released := v_released + 1;
      RAISE NOTICE 'released portfolio % for funder % amount %', r.portfolio_id, r.funder_id, r.amount;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
      RAISE WARNING 'portfolio % was not released: %', r.portfolio_id, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'funder direct backlog: released %, skipped %', v_released, v_skipped;
END;
$release$;
