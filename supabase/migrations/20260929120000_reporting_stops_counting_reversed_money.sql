-- Reporting stops counting money that was taken back.
--
-- A reversed collection KEEPS its amount in agent_collections. Only
-- `reversed_at` is stamped. So every SUM(amount) without a reversal filter
-- reports money the platform gave back as though an agent had collected it.
--
-- MEASURED 2026-09-29, whole table:
--
--   reversed with reversed_at AND a '[REVERSED:' note   1,226   UGX 98,947,719
--   reversed with reversed_at only                          48   UGX  1,417,000
--   reversed with a '[REVERSED:' note only                   0   UGX          0
--
-- That last line decides the shape of this migration. EVERY reversal sets
-- `reversed_at`, so `reversed_at IS NULL` is a complete filter and the ~90
-- reporting functions that already use it are correct. They are not touched.
--
-- Sweeping every object that reads agent_collections found only SEVEN that sum
-- `amount` with no reversal filter at all. Three of them are the collections
-- engine and are deliberately left alone:
--
--   process_verified_field_deposit    writes money, not a report
--   settle_tenant_rent_from_deposit   writes money, not a report
--   tops_allocate_collection          writes money, not a report
--
-- A fourth, `rent_apply_collections_to_days`, filters on the '[REVERSED:' NOTE
-- only, so it misses the 48 collections marked by column alone (UGX 1,417,000).
-- It is day attribution — engine, not reporting — and is left alone here and
-- written up in docs/reversed-collections-and-plan-balance.md instead.
--
-- The three reporting surfaces below are fixed, plus two checks that judge them.

-- 1. Agent collections per day and channel ---------------------------------
--
-- sum(amount) over every row, reversed or not. The plainest form of the bug.
CREATE OR REPLACE VIEW public.v_agent_collection_performance AS
 SELECT agent_id,
    date_trunc('day'::text, created_at)::date AS collection_day,
    collection_channel,
    count(*) AS collections,
    sum(amount) AS amount_collected,
    sum(amount * COALESCE(performance_weight, 1::numeric)) AS weighted_amount,
    sum(COALESCE(performance_weight, 1::numeric)) AS weighted_count
   FROM agent_collections ac
  WHERE ac.reversed_at IS NULL
  GROUP BY agent_id, (date_trunc('day'::text, created_at)::date), collection_channel;

COMMENT ON VIEW public.v_agent_collection_performance IS
  'Agent collections per day and channel. Reversed collections are excluded: a '
  'reversed collection keeps its amount in the table, so any SUM without this '
  'filter reports money that was taken back as if it were still collected.';

-- 2. The reconciliation view — the instrument, fixed first -------------------
--
-- This is the view anyone would reach for to judge whether a plan balance is
-- backed by real money, and it was itself reversal-blind: `ledger_total`
-- included reversed collections, so a contaminated balance looked reconciled.
--
-- The de-duplicator is fixed in the same breath. It suppresses a repayment that
-- mirrors a collection of the same amount within 300 seconds. Matching against
-- a REVERSED collection would drop a real repayment out of the reconciliation
-- entirely, so it now only matches live ones.
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  v_src := pg_get_viewdef('public.v_rent_repaid_reconciliation'::regclass, true);
  IF v_src ILIKE '%reversed_at%' THEN
    RAISE NOTICE 'Already applied - reconciliation already filters reversals.';
    RETURN;
  END IF;

  v_new := replace(v_src,
'                   FROM agent_collections ac
                  WHERE ac.rent_request_id IS NOT NULL',
'                   FROM agent_collections ac
                  WHERE ac.rent_request_id IS NOT NULL AND ac.reversed_at IS NULL');
  IF v_new = v_src THEN RAISE EXCEPTION 'ledger CTE anchor not found'; END IF;
  v_src := v_new;

  v_new := replace(v_src,
'                          WHERE a.rent_request_id = rp.rent_request_id AND a.amount = rp.amount',
'                          WHERE a.reversed_at IS NULL AND a.rent_request_id = rp.rent_request_id AND a.amount = rp.amount');
  IF v_new = v_src THEN RAISE EXCEPTION 'dedup anchor not found'; END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rent_repaid_reconciliation AS ' || v_new;
END
$patch$;

-- 3. Daily eligibility ------------------------------------------------------
--
-- A `completed` plan is kept in the roster when a collection landed today. The
-- test did not exclude reversed ones, so money that was taken back could hold a
-- finished plan open and put the tenant back in front of an agent.
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  v_src := pg_get_viewdef('public.v_agent_daily_eligibility'::regclass, true);
  IF v_src ILIKE '%ac0.reversed_at%' THEN
    RAISE NOTICE 'Already applied - eligibility already filters reversals.';
    RETURN;
  END IF;

  v_new := replace(v_src,
'                  WHERE ac0.amount > 0::numeric AND',
'                  WHERE ac0.reversed_at IS NULL AND ac0.amount > 0::numeric AND');
  IF v_new = v_src THEN RAISE EXCEPTION 'ac0 anchor not found'; END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS ' || v_new;
END
$patch$;

-- 4. Guarantor float preview ------------------------------------------------
--
-- pay_count, last_collection_at and the payment-gap series all read this CTE.
-- A reversed collection inflated the count, freshened the last-seen date and
-- closed a payment gap that never actually closed — which is the opposite of
-- what a float-risk preview is for.
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_guarantor_float_preview';
  IF v_src IS NULL THEN RAISE EXCEPTION 'get_agent_guarantor_float_preview not found'; END IF;
  IF v_src ILIKE '%reversed_at%' THEN
    RAISE NOTICE 'Already applied - guarantor preview already filters reversals.';
    RETURN;
  END IF;

  v_new := replace(v_src,
'    FROM agent_collections ac
    JOIN elig ON elig.rent_request_id = ac.rent_request_id',
'    FROM agent_collections ac
    JOIN elig ON elig.rent_request_id = ac.rent_request_id
    WHERE ac.reversed_at IS NULL');
  IF v_new = v_src THEN RAISE EXCEPTION 'col CTE anchor not found'; END IF;

  -- The live signature is (date, date) with defaults. Naming it any other way
  -- creates a SECOND overload instead of replacing this one.
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_agent_guarantor_float_preview(
       p_baseline_date date DEFAULT ''2026-08-24''::date,
       p_as_of date DEFAULT NULL::date)
     RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public''
     AS %L', v_new);
END
$patch$;

-- 5. The monitor stops reporting six plans that are fine --------------------
--
-- `plan_balance_holds_reversed` compared amount_repaid against agent_collections
-- alone. Six plans were flagged whose balance is fully backed once repayments
-- are counted — the reconciliation view calls them `reconciled`. They were
-- never carrying reversed money, and 146,900 of the reported exposure was not
-- real.
--
-- The comparison basis DELIBERATELY stays `pc.live_amt`, gross live collections,
-- because that is what the label claims. It is NOT switched to
-- `vr.ledger_total`: repayments.amount can be NEGATIVE — 49 rows, -1,717,000,
-- across 44 plans — so ledger_total is a NET figure. Comparing against it
-- turned this check into a different question and pushed the count UP from 32
-- to 50, mixing "carries reversed money" with "balance exceeds net receipts".
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_collections_monitor';
  IF v_src IS NULL THEN RAISE EXCEPTION 'agent_collections_monitor not found'; END IF;
  IF v_src LIKE '%reconciliation_state%' THEN
    RAISE NOTICE 'Already applied - monitor already excludes reconciled plans.';
    RETURN;
  END IF;

  v_new := replace(v_src,
$a$  FROM plan_coll pc
  JOIN public.rent_requests rr ON rr.id = pc.rr_id
  WHERE pc.rev_amt > 0 AND rr.amount_repaid > pc.live_amt$a$,
$b$  FROM plan_coll pc
  JOIN public.rent_requests rr ON rr.id = pc.rr_id
  JOIN public.v_rent_repaid_reconciliation vr ON vr.rent_request_id = pc.rr_id
  WHERE pc.rev_amt > 0 AND rr.amount_repaid > pc.live_amt
    AND vr.reconciliation_state <> 'reconciled'$b$);
  IF v_new = v_src THEN RAISE EXCEPTION 'check-2 anchor not found'; END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.agent_collections_monitor(p_days integer DEFAULT 14)
     RETURNS TABLE(check_key text, label text, severity text, hits bigint,
                   exposure_ugx numeric, oldest timestamp with time zone,
                   newest timestamp with time zone, guidance text)
     LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public''
     AS %L', v_new);
END
$patch$;

-- WHAT THIS MIGRATION DOES NOT DO
--
-- It does not change a single row of money. No amount_repaid is rewritten, no
-- collection is edited, no ledger leg is posted. The 26 plans that genuinely
-- carry reversed money in their balance (UGX 10,763,668) are NOT corrected
-- here, because their balances were set by manual edits and cannot be
-- reconstructed from collections: lowering them would raise what those tenants
-- owe by UGX 22,233,523. That is a decision for a person, and the list is in
-- docs/reversed-collections-and-plan-balance.md.
