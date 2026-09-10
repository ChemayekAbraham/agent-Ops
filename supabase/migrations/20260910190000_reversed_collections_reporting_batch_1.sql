-- Reversed collections: reporting sweep, batch 1.
--
-- Continues 20260910160000 / 170000 / 180000. Those made `reversed_at` a real
-- column and fixed the collection tiles, credit limits, advances and vouch.
-- This batch works through the reporting surfaces.
--
-- STATE AFTER THIS MIGRATION: 18 of the 97 functions that read
-- `agent_collections` now exclude reversed rows. 78 do not yet - of which 6
-- WRITE to the table (nothing to filter) and 1 only mentions it in a comment,
-- so roughly 71 reporting functions remain. They are listed at the bottom.
--
-- WHY THIS IS NOT ONE BIG REGEX. The transform looks mechanical - add
-- `reversed_at IS NULL` to each read - but it is not uniform, and three
-- distinctions have to be made by hand on every function:
--
--   * AMOUNT reads must be filtered (what was collected).
--   * IDENTITY reads must NOT be, or agent counts move underneath every other
--     figure. `agent_ops_collection_agents` needed BOTH: the universe left
--     unfiltered so counts hold, the activity signal filtered so an agent
--     whose only recent collection was reversed stops reading as active.
--   * WRITE targets must never be touched.
--
-- A blind rewrite across 70+ money-path functions is the same class of change
-- that inverted the collection ledger on 2026-09-10. Each one here was read,
-- transformed and applied individually.

-- ============================================================ this batch
--
--  1. get_agent_ops_overview                  tiles, trend, top performers
--  2. get_agent_collections_command_center    collected, coverage, per-agent
--  3. get_agent_collections_coverage          on-schedule vs arrears split
--  4. recalculate_credit_limit                6% / 60% of lifetime collections
--  5. get_agent_advance_limits                limit preview
--  6. get_agent_advance_potential             advance scoring, fleet
--  7. get_agent_advance_potential_for         advance scoring, one agent
--  8. get_agent_advance_repayment_monitor     today's collections per advance
--  9. recompute_agent_earned_vouch(uuid)      vouch = 2x lifetime collections
-- 10. recompute_agent_earned_vouch(uuid,...)  same, audited overload
-- 11. agent_reverse_tenant_allocation         sets reversed_at; guard fixed
-- 12. agent_ops_collection_agents             activity signal only
-- 13. agent_ops_report_collected              per-agent collected
-- 14. get_agent_ops_agent_stats               windowed operations
-- 15. get_agent_collection_records            an agent's receipts
-- 16. get_agent_collections_detail            summary + rows
-- 17. get_coo_rent_coverage_statement         collected_total, coverage rate
-- 18. get_coo_command_center                  today / yesterday / month
--
-- The bodies are large and deployed outside this repository, so they are not
-- restated here; the predicate added to each is `reversed_at IS NULL` on the
-- collections read, and the assertion below fails if any of them loses it.

DO $verify$
DECLARE v_bad text; v_fixed int; v_open int;
BEGIN
  SELECT string_agg(DISTINCT p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'get_agent_ops_overview','get_agent_collections_command_center',
       'get_agent_collections_coverage','recalculate_credit_limit',
       'get_agent_advance_limits','get_agent_advance_potential',
       'get_agent_advance_potential_for','get_agent_advance_repayment_monitor',
       'recompute_agent_earned_vouch','agent_reverse_tenant_allocation',
       'agent_ops_collection_agents','agent_ops_report_collected',
       'get_agent_ops_agent_stats','get_agent_collection_records',
       'get_agent_collections_detail','get_coo_rent_coverage_statement',
       'get_coo_command_center')
     AND p.prosrc NOT ILIKE '%reversed_at%';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'batch 1 functions that no longer exclude reversed collections: %', v_bad;
  END IF;

  SELECT count(*) FILTER (WHERE p.prosrc ILIKE '%reversed_at%'),
         count(*) FILTER (WHERE p.prosrc NOT ILIKE '%reversed_at%' AND p.prosrc NOT ILIKE '%REVERSED:%')
    INTO v_fixed, v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosrc ILIKE '%agent_collections%';

  RAISE NOTICE 'reversed-collection sweep: % done, % still counting reversed rows', v_fixed, v_open;
END
$verify$;

-- ==================================================== still to do (batch 2+)
--
-- Highest value first - these are read by leadership and ops daily:
--   get_agent_ops_comprehensive_report   agent_ops_report_agent
--   agent_ops_report_team_collections    agent_daily_collections_overview
--   get_coo_overview_snapshot            get_ceo_growth_quality
--   get_cto_daily_report                 get_agent_collection_league_details
--   get_agent_profile_360                get_tenant_ops_agent_360
--   get_service_centre_360               get_agent_daily_activity_report
--   agent_ops_partial_collection_report (x2)
--
-- Then the tenant-ops / TPPO / products family and the remainder.
--
-- NO CHANGE NEEDED - these write to the table rather than report on it:
--   agent_allocate_tenant_payment    agent_allocate_tenant_payment_internal
--   confirm_field_collection         process_verified_field_deposit
--   settle_tenant_rent_from_deposit  validate_and_record_collection
--   post_treasury_fee_cash_transfer  (mentions only)
--
-- NEEDS A JUDGEMENT CALL, deliberately left alone:
--   guard_rent_request_agent_updates - the collection-path trust guard. Adding
--     a filter changes behaviour on the money path itself, not a report.
--   get_agent_operational_population, agent_ops_strict_agent_ids,
--   get_agent_ops_criteria_users, ops_recent_agent_inactivations,
--   link_referred_agent_to_parent, get_cto_daily_report (its one reference) -
--     all use collections to decide WHO is an agent. Filtering moves the
--     headline agent counts, which every other figure is compared against.
--
-- ============================================== commission, still not closed
--
-- The 589,736.80 clawback from the incident cleanup remains filed under
-- `system_balance_correction`. Commission aggregations now net properly, but
-- they cannot see that row, so today's commission is still overstated by it.
-- The remedy is a compensating pair that nets to zero on the wallet:
--
--   INSERT INTO public.general_ledger
--     (user_id, amount, direction, category, source_table, ledger_scope,
--      wallet_bucket, recipient_type, classification, solvency_bypass_reason,
--      transaction_group_id, description)
--   SELECT '16d52ad2-92e0-4348-af46-17612afa4d49'::uuid, 589736.80, d.dir, d.cat,
--          'ledger_transaction', 'wallet', 'withdrawable', 'operational_wallet',
--          'admin_correction', 'duplicate_reversal'::solvency_bypass_reason,
--          g.id, d.descr
--   FROM (SELECT gen_random_uuid() AS id) g,
--        (VALUES
--          ('cash_in',  'system_balance_correction',
--           'Reclassification 1 of 2 (nets to zero): backs ledger row 25a559d9 out of system_balance_correction.'),
--          ('cash_out', 'agent_commission_earned',
--           'Reclassification 2 of 2 (nets to zero): re-files the 2026-09-10 commission clawback so commission reporting nets it.')
--        ) AS d(dir, cat, descr);
--
-- Not run here: writing to general_ledger was refused in the session that
-- produced this migration. Note also that get_coo_transaction_kpis excludes
-- classification 'admin_correction' from its commission KPI, so it will not
-- see this pair either and needs its own decision.
