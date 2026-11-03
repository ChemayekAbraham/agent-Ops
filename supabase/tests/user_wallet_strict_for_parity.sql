-- Compare public.user_wallet_strict_for to v_user_wallet_strict.
-- Run as postgres or service_role AFTER 20261027235500 is applied.
-- Read-only apart from this session. The view scan is the slow part (about 12s
-- on 2026-10-27). The helper itself was 67ms for the heaviest wallet.
--
-- A present wallet_balances_projection row is what crm_callee_dossier returns.
-- Those columns are NOT NULL, so that path matches the old coalesce(projection, strict, 0).
-- This script checks the fallback: the helper must equal the view.

DO $parity$
DECLARE
  v_heavy uuid;
  v_started timestamptz;
  v_ms numeric;
  v_sample bigint;
  v_bad bigint;
  v_both_missing bigint;
BEGIN
  IF to_regprocedure('public.user_wallet_strict_for(uuid)') IS NULL THEN
    RAISE EXCEPTION 'user_wallet_strict_for is not installed';
  END IF;
  IF has_function_privilege('anon', 'public.user_wallet_strict_for(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.user_wallet_strict_for(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon or authenticated can execute user_wallet_strict_for';
  END IF;
  IF position('v_user_wallet_strict' in (
       SELECT prosrc FROM pg_proc WHERE oid = 'public.crm_callee_dossier(uuid)'::regprocedure
     )) > 0 THEN
    RAISE EXCEPTION 'crm_callee_dossier still references v_user_wallet_strict';
  END IF;

  SELECT gl.user_id INTO v_heavy
  FROM public.general_ledger gl
  WHERE gl.ledger_scope = 'wallet' AND gl.wallet_bucket IS NULL
  GROUP BY gl.user_id
  ORDER BY count(*) DESC
  LIMIT 1;

  v_started := clock_timestamp();
  PERFORM * FROM public.user_wallet_strict_for(v_heavy);
  v_ms := 1000 * extract(epoch FROM clock_timestamp() - v_started);
  RAISE NOTICE 'user_wallet_strict_for heavy user % in % ms', v_heavy, round(v_ms, 1);
  IF v_ms > 200 THEN
    RAISE EXCEPTION 'user_wallet_strict_for took % ms; budget is 200ms', round(v_ms, 1);
  END IF;

  WITH sample AS (
    (
      SELECT gl.user_id
      FROM public.general_ledger gl
      WHERE gl.ledger_scope = 'wallet' AND gl.wallet_bucket IS NULL
      GROUP BY gl.user_id
      ORDER BY count(*) DESC
      LIMIT 8
    )
    UNION
    (
      SELECT a.user_id
      FROM public.wallet_fresh_start_anchors a
      ORDER BY a.anchor_at DESC
      LIMIT 4
    )
    UNION
    (
      SELECT CASE
               WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
               ELSE wr.user_id
             END
      FROM public.withdrawal_requests wr
      WHERE wr.status = ANY (ARRAY['pending','requested','manager_approved','processing','approved'])
        AND (wr.reason IS NULL OR wr.reason !~~ 'Landlord float payout%')
      GROUP BY 1
      ORDER BY count(*) DESC
      LIMIT 4
    )
    UNION
    (
      SELECT gl.user_id
      FROM public.general_ledger gl
      WHERE gl.ledger_scope = 'wallet'
        AND NOT EXISTS (
          SELECT 1 FROM public.wallet_balances_projection bp WHERE bp.user_id = gl.user_id
        )
      GROUP BY gl.user_id
      ORDER BY count(*) DESC
      LIMIT 4
    )
    UNION
    (
      SELECT wp.user_id
      FROM public.wallets_physical wp
      WHERE NOT EXISTS (
        SELECT 1 FROM public.general_ledger gl
        WHERE gl.user_id = wp.user_id AND gl.ledger_scope = 'wallet'
      )
      LIMIT 2
    )
  ),
  view_once AS MATERIALIZED (
    SELECT v.*
    FROM public.v_user_wallet_strict v
    WHERE v.user_id IN (SELECT s.user_id FROM sample s)
  ),
  compared AS (
    SELECT s.user_id AS sample_id,
           h.user_id AS helper_user,
           v.user_id AS view_user,
           (
             h.user_id IS NOT DISTINCT FROM v.user_id
             AND h.withdrawable IS NOT DISTINCT FROM v.withdrawable
             AND h.float_balance IS NOT DISTINCT FROM v.float_balance
             AND h.advance_balance IS NOT DISTINCT FROM v.advance_balance
             AND h.pending_holds IS NOT DISTINCT FROM v.pending_holds
             AND h.restricted_held IS NOT DISTINCT FROM v.restricted_held
             AND h.total_visible IS NOT DISTINCT FROM v.total_visible
             AND h.float_balance_signed IS NOT DISTINCT FROM v.float_balance_signed
           ) AS same
    FROM sample s
    LEFT JOIN LATERAL public.user_wallet_strict_for(s.user_id) h ON true
    LEFT JOIN view_once v ON v.user_id = s.user_id
  )
  SELECT count(*),
         count(*) FILTER (WHERE NOT same),
         count(*) FILTER (WHERE helper_user IS NULL AND view_user IS NULL)
    INTO v_sample, v_bad, v_both_missing
  FROM compared;

  IF v_sample < 15 THEN
    RAISE EXCEPTION 'parity sample too small: % users', v_sample;
  END IF;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'user_wallet_strict_for disagrees with v_user_wallet_strict for % of % users', v_bad, v_sample;
  END IF;
  IF v_both_missing = v_sample THEN
    RAISE EXCEPTION 'parity compared only empty rows; the view filter did not return the sample';
  END IF;
  RAISE NOTICE 'user_wallet_strict_for matches v_user_wallet_strict for % users', v_sample;
END
$parity$;
