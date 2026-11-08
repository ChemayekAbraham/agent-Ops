-- Phase 2 (per-person Partner Returns, owner rules 2026-11-06) production rehearsal. NEVER COMMITS.
--
-- Run in ONE transaction. Since round 3 this file has two parts: part A (up to the line that opens part B)
-- only reads the catalogue and must run BEFORE the migrations; part B is everything after that line:
--   BEGIN;
--   SET LOCAL statement_timeout = '30s';
--   <part A of this file>
--   <supabase/migrations/20261108160000_partner_return_policy_phase1.sql>
--   <supabase/migrations/20261108161000_partner_return_policy_phase2.sql>
--   <part B of this file>
--   ROLLBACK;
-- The assembled text is ~390 KB, too large for one MCP execute_sql tool call, so it is sent as ONE query
-- through the same Management API endpoint with the CLI:
--   npx supabase db query --linked --project-ref byrzshwlentqvktcksem -f rehearsal_phase2.sql
-- The INFO T0 line prints md5 of the text the server received (whole, and per part: part A, Phase 1, Phase 2,
-- part B) to prove it is the saved file.
-- The DO block always ends in RAISE EXCEPTION 'DRYRUN_P2 pass=.. fail=..' (PASS/FAIL/INFO lines in the message),
-- which aborts the transaction; the trailing ROLLBACK is a second belt. Nothing is kept: the switch, the cut-off,
-- the test portfolios, commitments, houses, notes, notices, payslips, ledger rows, CFO requests, audit rows,
-- cron jobs, queued emails (pgmq.send is a table insert) and queued HTTP calls all roll back.
--
-- Side effects that leave the database: none. The only outbound channels reachable from these paths are
--   * pg_net (0.20.4): net.http_post() INSERTs into net.http_request_queue and calls net.wake(); the background
--     worker reads the queue in its own transaction, so a rolled-back row is never seen or sent. (Reached via
--     enqueue_funder_house_notice -> notify-funder-house-progress, and rent_requests update triggers.)
--   * pgmq (enqueue_email): a table insert, rolled back.
-- No http/dblink extension is installed; no SMS or edge call is made synchronously. Section S4 reports how many
-- queue rows this transaction wrote (all discarded by the rollback).
--
-- While it runs, Phase 1 holds ACCESS EXCLUSIVE on investor_portfolios and promissory_notes, Phase 2 holds
-- SHARE ROW EXCLUSIVE on promissory_notes/rent_requests and ACCESS EXCLUSIVE on the three notice tables, so
-- production reads of those tables wait until it ends. Target < 5 s from BEGIN; run outside the cron windows.
--
-- Fixtures are picked from live data with ORDER BY (deterministic). On 2026-11-06 they resolved to:
--   ceo        29a0cfa8-1eaf-453c-874c-0fc72fa4f74b  (first enabled CEO; switches Partner Returns on)
--   ops        0b109aad-212a-4fd0-ab03-3d7aee9cf397  (first enabled partner_ops who is not a CEO; staff caller)
--   agent      00005b8c-265f-43c4-a22c-34285fa28492  (plain agent: only tenant/agent/supporter/landlord roles,
--                                                      not HR staff, no staff permission)
--   p20        b3ecd3b3-6817-45d8-8d70-d5e24696b96b  (signed partner, live portfolios 15% + 20% (highest 20),
--                                                      not staff, no promissory note, float 3,000,000)
--   pnew       b495c0e7-6531-4ca6-8163-e40088ac8c51  (signed partner with float 3,000,000 and no portfolio at
--                                                      all, no signed-not-countersigned agreement: new = 10%)
--   signed     0155a17e-ec8b-4c9f-b017-8b7e0b52bff4  (signed, not countersigned, no live/redeemed portfolio)
--   staff A    08e3ecb5-6a23-46e6-a15c-d89946990d8f  (active HR staff, no live salary-reinvestment portfolio,
--   staff B    16d52ad2-92e0-4348-af46-17612afa4d49   not CEO/CFO/partner_ops; A runs with the switch off, B on)
--   late note  0000294a-30de-4994-9ade-7223fa0254a3  (lowest-id pending note with nobody linked; window frozen
--                                                      at the cut-off ends 2026-12-06)
--   late       0001240c-7be7-4643-97a9-c6e426118693  (brand-new profile: no portfolio, note, agreement, staff role)
--   late2      (round 3) the next brand-new profile after 'late' in id order (S3.19, inside an undone savepoint)
--   agent2     (round 6) the next plain agent after 'agent' in id order, not late or late2 (S2.3 book transfer,
--              inside an undone savepoint)
--   rule       2e8304ad-a543-49cd-ad62-fe1fe07bafcc  (the only hr_pay_rule_versions row)
--   rent req   6be06a42-edfa-43f6-b642-f4a5ad5aa578  (the only rent request with a supporter; next reward 2026-12-06)
--   houses h1..h8 (verified, available, empty, unclaimed, rent 50,000-150,000, listing agent set, lowest ids):
--     023807cb-e912-4203-afc4-7ad0d4efe54e 040d2040-b4df-423f-8337-b7d69b32bb29 04122853-7e7d-4bc2-b804-0d5507983936
--     042a3aa5-4307-4538-8b5b-ee35ecfab6a4 043d9ebd-9813-4840-8664-84b3514a01bf 045739d9-6a45-49e9-9796-38ac9ef6151d
--     046a7a9c-b368-4fd5-ae8f-5c35face777b 04afb3d0-4c7d-449f-a3e2-5b651b1cf400
--     h1 off: pnew supports | h2 on: p20 supports | h3 on: pnew supports | h4,h5 off: split notes
--     h6,h7 on: split notes | h8 share link
--   payslips: a fabricated closed period + approved run + two payslips (net 0, REINVEST 100,000) on the
--     only hr_pay_rule_versions row, so the real hr_pay_post_staff_reinvestment runs end to end.
-- The four "prod_" functions below are byte-for-byte copies of the production functions Phase 2 replaces
-- (md5(prosrc) is checked in S0.10), so OFF parity is checked against today's code in the same snapshot.
-- Round 2 (2026-11-06) adds: S2.0 switch-on refused until release_ready (set here only for the rehearsal, as
-- the release migration will); S1.13/S3.17 rates come out without trailing zeros; S1.14/S3.16
-- partner_supported_house_returns (15 and identical to today's code while off, the note's own rate after);
-- S3.18 post_rent_facilitation_reward builds its wallet text from the stored rate and says "Returns", run
-- inside a savepoint that is undone straight away (the request is made due only inside that savepoint).
-- Round 3 (2026-11-06) adds: part A, read before the migrations (S0.0a-c: production still matched
-- prod_function_manifest.json, whose expected-absent list names partner_rate_lock and _promissory_note_rate_json);
-- S0.11 the two new helpers run only as their owner; S0.12 every rate decision takes the one per-person lock
-- and both note RPCs return the rate through the helper; S0.13 the rewritten reward-rate backfill; S1.15/S3.22
-- obligationRatePct without trailing zeros; S3.18 also checks the trimmed 'rate' and a nested
-- "(managed by ... (...))" suffix; S3.19 a late link of a DRYRUN note to a real person inside an undone savepoint
-- (KEY SHARE on the candidate portfolio, at most 256 partner-rate advisory locks, also for 20,000 people at once);
-- S3.20/S3.21 an agent does not learn a known person's rate from the note RPCs (DRYRUN notes; the end-to-end
-- calls run inside an undone savepoint).
-- Round 4 (2026-11-06) adds: part A's expected-absent list has 37 names (_promissory_note_notice_contacts);
-- S0.14 the notice-contacts helper runs only as its owner and both notice queues take the contacts from it;
-- S0.15 the note RPC helper also drops partner_user_id and the booked-house list hides a rate linked to someone
-- else (code); S0.16 the gate's rate-change path locks open requests in id order and retries once on the
-- one-pending slot, the late link's second look-up uses SKIP LOCKED (code); S3.23 the note RPC result hides the
-- linked account's id; S3.24 a note linked at insert sends its pledge and booking notices to the linked person's
-- profile contacts while an unlinked note keeps the typed ones (DRYRUN notes in an undone savepoint; only
-- match true/false is printed, never a contact); S3.25 partner_supported_house_returns shows no rate figures for
-- a note picked up by the caller's email but linked to someone else (DRYRUN note in an undone savepoint).
-- Round 5 (2026-11-06) adds: part A's expected-absent list has 38 names (partner_note_window_applies); S0.16 is
-- rewritten for the gate's loop without a sub-transaction (INSERT ... ON CONFLICT DO NOTHING, EXIT WHEN FOUND, 23505
-- on the second miss) and the late link's busy count and insert that leave a covered portfolio alone (code); S0.17 the
-- note-window helper is closed, IMMUTABLE, answers its truth table, and only partner_rates_for and
-- partner_note_linked_late call it; S0.18 the note guard names service_role (code); S0.19 the notice contacts read
-- the login email (auth.users) and the queue owner can read it (code); S1.16 the OFF split note on h5 is linked to
-- p20 before the switch-on and S2.2 checks that the switch-on snapshot froze every window's person and agent as on
-- the note (counts linked / unlinked / author-linked only); S2.3 a window counts only for whom it is for (owner-side
-- moves of DRYRUN notes in undone savepoints); S2.4 as service_role (an edge function) moving, re-rating or late-
-- linking a DRYRUN note is refused with 42501 (undone savepoints); S2.5 the h5 note is unlinked again so S3 starts
-- as in round 4; S3.24 compares the notices with the LOGIN email (auth.users), no longer profiles.email.
-- Round 6 (2026-11-06) adds: S0.17 the note-window helper takes 4 arguments (p_owner, p_agent_then, p_agent_now,
-- p_person; the 3-argument one is dropped): a note nobody held at the cut-off counts for anyone except the agent frozen
-- at the cut-off and the note's agent now; its truth table has 11 rows and both callers pass n.agent_id; S0.20 the
-- unique index portfolio_rate_approvals_one_open (at most one pending-or-scheduled request per portfolio) exists with
-- its predicate, the gate's and the late link's ON CONFLICT clause infers it (EXPLAIN, not executed), and beside a
-- scheduled request that INSERT writes nothing (undone savepoint); fixture agent2; S2.3 (c) a book transfer (the
-- statement partner_ops_transfer_proxy_book runs: UPDATE promissory_notes SET agent_id) of the DRYRUN h4 note to agent2,
-- then linked to agent2 by the owner: agent2 stays 10/new and gets no catch-up request (undone savepoint).

-- =============================================================================================
-- Part A (round 3): runs BEFORE the two migrations, in the same transaction, and only reads the catalogue.
-- Production must still be what prod_function_manifest.json describes: the 50 functions it lists have that
-- md5(pg_get_functiondef), none of the 38 expected-absent functions exists (partner_rate_lock,
-- _promissory_note_rate_json, since round 4 _promissory_note_notice_contacts and since round 5
-- partner_note_window_applies included), and no Phase 1/2 table, column, trigger or cron job exists. The answer
-- is kept in a temp table (gone with the rollback) and printed by S0.0a-S0.0c. Both lists are copies of the
-- manifest; the assembler refuses to build the rehearsal when they differ from it.
-- =============================================================================================
CREATE TEMP TABLE _dr_pre AS
WITH want(sig, md5) AS (VALUES
    ('_has_enabled_role(p_user uuid, p_roles text[])', '5a0bc1a1bdc645ae0fa38594392c2a79'),
    ('_pf_log(p_identity text, p_command text, p_outcome text, p_old_md5 text, p_new_md5 text, p_detail text)', '5baff65b24da92c1e5f2a626d939b0df'),
    ('accrue_partner_self_returns(p_as_of date)', '3e23103beaabe03003644388e2a2d3c8'),
    ('agent_create_promissory_note(p_payload jsonb, p_rent_request_ids uuid[])', '3fc2b24b3cfc9b37dabaa326d3771a97'),
    ('agent_create_promissory_note_for_houses(p_payload jsonb, p_house_ids uuid[])', 'c37cf13889aed93c5171c22361cd927c'),
    ('agent_list_empty_house_opportunities(p_search text, p_limit integer, p_offset integer, p_district text, p_verified_only boolean, p_gps_only boolean, p_min_rent numeric, p_max_rent numeric, p_near_lat double precision, p_near_lng double precision, p_radius_km double precision, p_sort text)', 'af1b80d1581545b653bc5aae692b49b8'),
    ('apply_portfolio_renewal(p_portfolio_id uuid, p_renewed_by uuid, p_reason text, p_source text, p_is_auto boolean)', 'ba3a13f55504742e3b9a6dea15656cfa'),
    ('approve_promissory_note(p_note_id uuid, p_reason text)', 'acf6e896ef59fec4c4271008d727a653'),
    ('auto_renew_due_portfolios(p_limit integer)', 'fa875cca27376d5d5ef808492c4fce31'),
    ('countersign_prepare_support(p_partner_id uuid, p_amount numeric, p_support_mode text, p_return_option text, p_actor uuid, p_countersign_only boolean)', 'd700308d932151eb828ff4ebbab5815e'),
    ('create_pending_portfolio(p_partner_id uuid, p_amount numeric, p_duration_months integer, p_roi_percentage numeric, p_roi_mode text, p_nickname text, p_raw_token text)', '10094e3dafd79c145070c81c1f3ea5ec'),
    ('empty_house_opportunity_summary()', '9bb8a0c9765d0ca5e020c733c1cb328b'),
    ('enforce_investor_portfolio_field_immutability()', 'ebb0ff6d1730cd8ecca8a7cb47fb0667'),
    ('enforce_portfolio_funding_at_creation()', 'aefe4883b2404f1266da30890df351d0'),
    ('enqueue_email(queue_name text, payload jsonb)', 'faf4aa75b683bc06f812536e879ced61'),
    ('enqueue_funder_house_notice(p_dedupe_key text, p_kind text, p_partner_id uuid, p_supported_house_id uuid, p_house_id uuid, p_commitment_id uuid, p_house_title text, p_district text, p_house_count integer, p_monthly_rent numeric, p_principal numeric, p_agent_name text, p_placed_at timestamp with time zone, p_earning_started_at timestamp with time zone)', 'ddd9bc1a647be7ab23febd79eedb176b'),
    ('funder_create_pending_portfolio(p_amount numeric, p_summary_id uuid, p_term_months integer)', '6b938de2bbfe96a4f97d82672dbfac7d'),
    ('funder_fund_booked_houses(p_house_ids uuid[], p_term_months integer, p_idempotency_key text)', 'bc55d6c2823c04ba45f2b9ff868a2587'),
    ('funder_has_signed_agreement(p_user_id uuid)', 'fe9f4b03141a9988ef763d6a76353421'),
    ('funder_support_tenant_direct(p_rent_request_ids uuid[], p_promised_deposit_date date, p_term_months integer)', 'b4dc0b71b8c73a9742075cbe48ac8b72'),
    ('get_countersign_summary(p_partner_id uuid, p_amount numeric)', 'd72f5a66332b4ab9ffb35c3ee037a423'),
    ('get_or_create_house_share_link(p_house_id uuid)', '5fe498c42fc38723ac2719dcc524fb2b'),
    ('get_or_create_plan_share_link(p_plan_id uuid)', '23280e3466b2bcb20163a81a88a6adc9'),
    ('get_supporter_pool_stats()', 'a822072a8c929b24eedc9062fad47d67'),
    ('has_role(_user_id uuid, _role app_role)', '4b5737a9f508ee6b53fe97630243cfec'),
    ('hr_pay_post_staff_reinvestment(_payslip_id uuid)', 'ed4cc123465f945d282e109f8770a22b'),
    ('link_promissory_note_partner()', '383f6ff78fb9d48941fb7297ecbef8f1'),
    ('link_promissory_notes_for_user(p_user uuid)', '9676d0b3179d3cf2caca650a3fac2883'),
    ('lock_portfolio_principal(p_portfolio_id uuid, p_locked_amount numeric, p_reason text)', '3c04a9da0d7daaa1a5f3fbee513ff987'),
    ('merge_paidout_topups()', '9b0a01400ae5063c6fc6df6be227f30c'),
    ('neexabot_ensure_partner_note(p_partner uuid, p_trigger text)', 'e463e101c1ffc2f06daec4609098c154'),
    ('partner_house_placement_status(p_partner_id uuid)', 'b68d0e2e7be358940e1e819bf90b7bc2'),
    ('partner_self_confirm_commitment(p_rent_request_ids uuid[], p_term_months integer, p_idempotency_key text)', '1e2a49849771124b93459e81927ebad2'),
    ('partner_support_houses(p_house_ids uuid[], p_term_months integer, p_idempotency_key text)', 'c7ffc8dcb0072f424382fd66b232b6bf'),
    ('partner_support_houses(p_house_ids uuid[], p_term_months integer, p_idempotency_key text, p_commitment_id uuid)', '8a91e283d2429e70c5da6e988cb90844'),
    ('partner_supported_house_returns()', 'ce1176237dea4005406c7e0434dce8f6'),
    ('pay_partner_self_cycles(p_limit integer)', '348768d17169facb6c8b7eff1fb9f16f'),
    ('post_rent_facilitation_reward(p_rent_request_id uuid, p_payment_number integer, p_reinvest_portfolio_id uuid, p_wallet_description text)', '3d4487b17add84f9cb1ab32d2ee34927'),
    ('promissory_confirm_arrival_match(p_note_id uuid, p_user_id uuid, p_reason text)', 'e65417c279359d74c4d8d11489d32c5a'),
    ('psm_confirm_commitment_for(p_partner uuid, p_rent_request_ids uuid[], p_term_months integer, p_idempotency_key text, p_actor uuid, p_promissory_note_id uuid, p_funding_mode text)', '44692e0de3e7b3ef9be44edb8e158b06'),
    ('psm_queue_house_booking_notice(p_note_id uuid, p_kind text)', '61efc5de32bd3597014c854224d60ed9'),
    ('psm_queue_promissory_pledge_notice(p_note_id uuid)', '18995fb13e5861b6393e9b5befacb4e7'),
    ('public_house_support_offer(p_code text)', '7760dfa1774fcdacee310934fd1d291b'),
    ('public_support_plan(p_plan_id uuid)', '84e8e991bd02ba2d13c0315b85a2fb54'),
    ('record_money_path_drift()', 'f4cf75ff818a2801e0f16812fb37ab79'),
    ('require_staff_aal2()', '1a82ccb2e7a0c011871210dd93e39a23'),
    ('search_supporters(search_term text, result_limit integer)', '2a8c476e46e7a8fc9363150a9c01e8b0'),
    ('split_portfolio_principal(p_portfolio_id uuid, p_split_amount numeric, p_reason text)', 'c78890feb0288e03a49148dbe2c7da67'),
    ('staff_mfa_ok()', '226b8de56f2635c75f21fae6c76f0864'),
    ('validate_promissory_note()', '404b3413a03a55822b82c3d32830efc5')
), absent(name) AS (VALUES
    ('_partner_return_policy_caller_ok'),
    ('apply_due_portfolio_rate_changes'),
    ('assert_partner_return_policy_intact'),
    ('cfo_decide_portfolio_rate_requests'),
    ('enforce_partner_return_rate_policy'),
    ('get_partner_return_policy'),
    ('list_portfolio_rate_requests'),
    ('partner_new_contract_rate'),
    ('partner_renewal_rate'),
    ('set_partner_return_policy'),
    ('set_portfolio_renewal_rate'),
    ('partner_agreement_terms'),
    ('partner_agreement_terms_now'),
    ('partner_agreement_version_now'),
    ('stamp_partner_agreement_terms'),
    ('partner_rate_now'),
    ('_partner_commitment_follow_rate'),
    ('partner_quote_rate'),
    ('agent_create_promissory_notes_split'),
    ('partner_note_linked_late'),
    ('stamp_rent_facilitation_reward_rate'),
    ('partner_live_portfolio_statuses'),
    ('partner_rates_for'),
    ('partner_rate_for'),
    ('partner_note_rate_for'),
    ('partner_return_cutoff_at'),
    ('partner_return_policy_guard'),
    ('partner_return_cohort_guard'),
    ('stamp_promissory_note_return_rate'),
    ('guard_promissory_note_return_rate'),
    ('guard_partner_return_carry'),
    ('_partner_return_alert'),
    ('partner_rate_conformance'),
    ('record_partner_return_policy_drift'),
    ('partner_rate_lock'),
    ('_promissory_note_rate_json'),
    ('_promissory_note_notice_contacts'),
    ('partner_note_window_applies')
), have AS (
  SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig, md5(pg_get_functiondef(p.oid)) AS md5
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
     AND p.proname IN (SELECT split_part(w.sig, '(', 1) FROM want w)
)
SELECT clock_timestamp() AS checked_at,
       current_user::text AS run_as,
       (SELECT count(*) FROM want) AS want_n,
       (SELECT count(*) FROM want w JOIN have h ON h.sig = w.sig AND h.md5 = w.md5) AS match_n,
       (SELECT string_agg(w.sig || ' has ' || COALESCE(h.md5, 'no such function'), '; ' ORDER BY w.sig)
          FROM want w LEFT JOIN have h ON h.sig = w.sig WHERE h.md5 IS DISTINCT FROM w.md5) AS mismatched,
       (SELECT count(*) FROM absent) AS absent_n,
       ARRAY(SELECT a.name FROM absent a ORDER BY a.name) AS absent_names,
       (SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname) FROM pg_proc p JOIN absent a ON a.name = p.proname
         WHERE p.pronamespace = 'public'::regnamespace) AS present,
       (SELECT string_agg(c.relname, ', ' ORDER BY c.relname) FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace
           AND c.relname IN ('partner_return_policy', 'partner_return_cohort', 'partner_return_note_windows',
                             'partner_return_legacy_portfolios', 'portfolio_rate_approvals', 'rent_facilitation_reward_rates')) AS tables_present,
       (SELECT string_agg(v.t || '.' || v.col, ', ' ORDER BY v.t, v.col)
          FROM (VALUES ('investor_portfolios', 'entitled_rate'), ('investor_portfolios', 'rate_basis'),
                       ('investor_portfolios', 'rate_decided_at'), ('promissory_notes', 'return_rate'),
                       ('promissory_notes', 'return_rate_basis'), ('promissory_note_pledge_notices', 'return_rate'),
                       ('promissory_house_booking_notices', 'return_rate'), ('funder_house_progress_notices', 'return_rate')) v(t, col)
          JOIN pg_attribute a ON a.attrelid = to_regclass('public.' || v.t) AND a.attname = v.col::name
         WHERE a.attnum > 0 AND NOT a.attisdropped) AS columns_present,
       (SELECT string_agg(t.tgname, ', ' ORDER BY t.tgname) FROM pg_trigger t
         WHERE NOT t.tgisinternal
           AND t.tgname IN ('trg_partner_return_carry_guard', 'trg_partner_return_rate_policy', 'trg_partner_return_cohort_guard',
                            'trg_partner_return_cohort_no_truncate', 'trg_partner_return_legacy_guard',
                            'trg_partner_return_legacy_no_truncate', 'trg_partner_return_note_windows_guard',
                            'trg_partner_return_note_windows_no_truncate', 'trg_partner_return_policy_guard',
                            'trg_zz_guard_note_return_rate', 'trg_zz_stamp_note_return_rate', 'trg_zz_partner_note_linked_late',
                            'trg_zz_stamp_rent_reward_rate_ins', 'trg_zz_stamp_rent_reward_rate_upd')) AS triggers_present,
       (SELECT string_agg(j.jobname, ', ' ORDER BY j.jobname) FROM cron.job j
         WHERE j.jobname IN ('apply-portfolio-rate-changes-705pm', 'partner-rate-drift-check')) AS cron_present;

-- Phase 2 rehearsal part B (runs after both migrations)
SET LOCAL lock_timeout = '3s';

-- production public.get_supporter_pool_stats (md5(pg_get_functiondef) a822072a8c929b24eedc9062fad47d67 on 2026-11-06), SECURITY DEFINER dropped
CREATE FUNCTION pg_temp.prod_get_supporter_pool_stats()
 RETURNS json
 LANGUAGE plpgsql

 SET search_path TO 'public'
AS $function$
DECLARE
  total_in numeric;
  total_out numeric;
  total_withdrawn numeric;
begin /* advisor_guard */ if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then raise exception 'not authorized' using errcode = '42501'; end if; 
  SELECT COALESCE(SUM(amount), 0) INTO total_in
  FROM general_ledger WHERE category = 'supporter_rent_fund';

  SELECT COALESCE(SUM(amount), 0) INTO total_out
  FROM general_ledger WHERE category = 'pool_rent_deployment';

  SELECT COALESCE(SUM(amount), 0) INTO total_withdrawn
  FROM general_ledger WHERE category = 'supporter_capital_return';

  RETURN json_build_object(
    'poolBalance', total_in - total_out,
    'totalDeployed', total_out,
    'monthlyObligation', ROUND((total_in - total_withdrawn) * 0.15),
    'deployableAmount', GREATEST(0, (total_in - total_out) - ROUND((total_in - total_withdrawn) * 0.15))
  );
END;
$function$;

-- production public.empty_house_opportunity_summary (md5(pg_get_functiondef) 9bb8a0c9765d0ca5e020c733c1cb328b on 2026-11-06), SECURITY DEFINER dropped
CREATE FUNCTION pg_temp.prod_empty_house_opportunity_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH base AS (
  SELECT h.id, COALESCE(h.monthly_rent, 0) AS rent,
         NULLIF(TRIM(COALESCE(h.district, '')), '') AS district,
         h.landlord_id,
         (
           EXISTS (SELECT 1 FROM public.promissory_note_house_intents i
                    WHERE i.house_id = h.id AND i.status IN ('reserved','funded'))
           OR EXISTS (SELECT 1 FROM public.partner_supported_houses psh
                       WHERE psh.house_id = h.id AND psh.status IN ('pending','active'))
           OR EXISTS (SELECT 1 FROM public.portfolio_allocations a
                       WHERE a.house_id = h.id AND a.status IN ('reserved','fulfilled'))
         ) AS is_funded
  FROM public.house_listings h
  WHERE h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden, false) = false
    AND COALESCE(h.monthly_rent, 0) > 0
),
avail AS (SELECT * FROM base WHERE NOT is_funded),
districts AS (
  SELECT jsonb_agg(d ORDER BY (d->>'total_rent_needed')::numeric DESC) AS rows
  FROM (SELECT jsonb_build_object('district', COALESCE(district,'Unspecified'),
          'house_count', COUNT(*), 'total_rent_needed', COALESCE(SUM(rent),0),
          'monthly_return', COALESCE(SUM(ROUND(rent*0.15)),0)) AS d
        FROM avail GROUP BY COALESCE(district,'Unspecified')
        ORDER BY SUM(rent) DESC LIMIT 12) t
),
landlords AS (
  SELECT jsonb_agg(l ORDER BY (l->>'total_rent_needed')::numeric DESC) AS rows
  FROM (SELECT jsonb_build_object('landlord_name', TRIM(p.name),
          'house_count', COUNT(*), 'total_rent_needed', COALESCE(SUM(a.rent),0),
          'monthly_return', COALESCE(SUM(ROUND(a.rent*0.15)),0)) AS l
        FROM avail a JOIN public.landlords p ON p.id = a.landlord_id
        WHERE NULLIF(TRIM(COALESCE(p.name,'')),'') IS NOT NULL
        GROUP BY TRIM(p.name) ORDER BY SUM(a.rent) DESC LIMIT 8) t
)
SELECT jsonb_build_object(
  'house_count', (SELECT COUNT(*) FROM avail),
  'total_rent_needed', (SELECT COALESCE(SUM(rent),0) FROM avail),
  'monthly_return_if_all_funded', (SELECT COALESCE(SUM(ROUND(rent*0.15)),0) FROM avail),
  'avg_monthly_rent', (SELECT COALESCE(ROUND(AVG(rent)),0) FROM avail),
  'funded_count', (SELECT COUNT(*) FROM base WHERE is_funded),
  'funded_rent', (SELECT COALESCE(SUM(rent),0) FROM base WHERE is_funded),
  'total_listed', (SELECT COUNT(*) FROM base),
  'districts', COALESCE((SELECT rows FROM districts),'[]'::jsonb),
  'landlords', COALESCE((SELECT rows FROM landlords),'[]'::jsonb));
$function$;

-- production public.agent_list_empty_house_opportunities (md5(pg_get_functiondef) af1b80d1581545b653bc5aae692b49b8 on 2026-11-06), SECURITY DEFINER dropped
CREATE FUNCTION pg_temp.prod_agent_list_empty_house_opportunities(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0, p_district text DEFAULT NULL::text, p_verified_only boolean DEFAULT false, p_gps_only boolean DEFAULT false, p_min_rent numeric DEFAULT NULL::numeric, p_max_rent numeric DEFAULT NULL::numeric, p_near_lat double precision DEFAULT NULL::double precision, p_near_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_district text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_radius double precision := NULLIF(COALESCE(p_radius_km, 0), 0);
  v_sort text := lower(NULLIF(btrim(COALESCE(p_sort, '')), ''));
  v_dlat double precision;
  v_dlng double precision;
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_districts jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.has_role(v_uid, 'supporter')
    OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  IF v_sort IS NULL OR v_sort NOT IN ('recommended', 'nearest', 'newest', 'rent_high', 'rent_low') THEN
    v_sort := 'recommended';
  END IF;

  IF v_sort = 'nearest' AND (p_near_lat IS NULL OR p_near_lng IS NULL) THEN
    v_sort := 'recommended';
  END IF;

  IF v_radius IS NOT NULL AND p_near_lat IS NOT NULL AND p_near_lng IS NOT NULL THEN
    v_dlat := v_radius / 111.0;
    v_dlng := v_radius / GREATEST(cos(radians(p_near_lat)) * 111.0, 0.000001);
  END IF;

  WITH base AS (
    SELECT
      h.id,
      h.verified,
      h.created_at,
      COALESCE(h.monthly_rent, 0) AS monthly_rent,
      CASE
        WHEN p_near_lat IS NULL OR p_near_lng IS NULL
          OR h.latitude IS NULL OR h.longitude IS NULL THEN NULL
        ELSE sqrt(
          pow((h.latitude - p_near_lat) * 111.0, 2)
          + pow((h.longitude - p_near_lng) * cos(radians(p_near_lat)) * 111.0, 2)
        )
      END AS distance_km
    FROM public.house_listings h
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
    LEFT JOIN public.profiles ap ON ap.id = h.agent_id
    WHERE h.status = 'available'
      AND h.tenant_id IS NULL
      AND COALESCE(h.is_hidden, false) = false
      AND COALESCE(h.monthly_rent, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM public.promissory_note_house_intents pni
                       WHERE pni.house_id = h.id AND pni.status IN ('reserved','funded'))
      AND NOT EXISTS (SELECT 1 FROM public.partner_supported_houses pshc
                       WHERE pshc.house_id = h.id AND pshc.status IN ('pending','active'))
      AND NOT EXISTS (SELECT 1 FROM public.portfolio_allocations pa
                       WHERE pa.house_id = h.id AND pa.status IN ('reserved','fulfilled'))
      AND (
        v_search IS NULL
        OR h.title ILIKE '%' || v_search || '%'
        OR h.district ILIKE '%' || v_search || '%'
        OR h.sub_county ILIKE '%' || v_search || '%'
        OR h.village ILIKE '%' || v_search || '%'
        OR h.region ILIKE '%' || v_search || '%'
        OR lp.name ILIKE '%' || v_search || '%'
        OR lp.phone ILIKE '%' || v_search || '%'
        OR ap.full_name ILIKE '%' || v_search || '%'
      )
      AND (v_district IS NULL OR h.district ILIKE v_district)
      AND (COALESCE(p_verified_only, false) = false OR COALESCE(h.verified, false) = true)
      AND (
        COALESCE(p_gps_only, false) = false
        OR (h.latitude IS NOT NULL AND h.longitude IS NOT NULL AND (h.latitude <> 0 OR h.longitude <> 0))
      )
      AND (p_min_rent IS NULL OR COALESCE(h.monthly_rent, 0) >= p_min_rent)
      AND (p_max_rent IS NULL OR COALESCE(h.monthly_rent, 0) <= p_max_rent)
      AND (
        v_dlat IS NULL
        OR (
          h.latitude IS NOT NULL AND h.longitude IS NOT NULL
          AND h.latitude BETWEEN p_near_lat - v_dlat AND p_near_lat + v_dlat
          AND h.longitude BETWEEN p_near_lng - v_dlng AND p_near_lng + v_dlng
        )
      )
  ),
  counted AS (SELECT COUNT(*) AS c FROM base),
  page AS (
    SELECT
      b.id,
      b.distance_km,
      row_number() OVER (
        ORDER BY
          CASE WHEN v_sort = 'nearest' THEN b.distance_km END ASC NULLS LAST,
          CASE WHEN v_sort = 'newest' THEN b.created_at END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_high' THEN b.monthly_rent END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_low' THEN b.monthly_rent END ASC NULLS LAST,
          CASE WHEN v_sort = 'recommended' THEN (CASE WHEN b.verified THEN 0 ELSE 1 END) END ASC NULLS LAST,
          b.created_at DESC
      ) AS rn
    FROM base b
    ORDER BY rn
    LIMIT v_limit OFFSET v_offset
  ),
  rows_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'house_id', h.id,
      'title', h.title,
      'house_category', h.house_category,
      'monthly_rent', COALESCE(h.monthly_rent, 0),
      'district', h.district,
      'sub_county', h.sub_county,
      'village', h.village,
      'region', h.region,
      'number_of_rooms', h.number_of_rooms,
      'verified', COALESCE(h.verified, false),
      'listing_agent_id', h.agent_id,
      'listing_agent_name', p.full_name,
      'image_url', CASE WHEN h.image_urls IS NOT NULL AND array_length(h.image_urls, 1) > 0 THEN h.image_urls[1] ELSE NULL END,
      'image_urls', COALESCE(to_jsonb(h.image_urls), '[]'::jsonb),
      'latitude', h.latitude,
      'longitude', h.longitude,
      'landlord_id', h.landlord_id,
      'landlord_name', lp.name,
      'landlord_phone', lp.phone,
      'distance_km', pg.distance_km,
      'partner_monthly_return', round(COALESCE(h.monthly_rent, 0) * 0.15),
      'partner_annual_return', round(COALESCE(h.monthly_rent, 0) * 0.15 * 12),
      'created_at', h.created_at
    ) ORDER BY pg.rn), '[]'::jsonb) AS j
    FROM page pg
    JOIN public.house_listings h ON h.id = pg.id
    LEFT JOIN public.profiles p ON p.id = h.agent_id
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
  )
  SELECT counted.c, rows_json.j INTO v_total, v_rows FROM counted, rows_json;

  SELECT COALESCE(jsonb_agg(q.d ORDER BY q.d), '[]'::jsonb) INTO v_districts
  FROM (
    SELECT DISTINCT btrim(hl.district) AS d
    FROM public.house_listings hl
    WHERE hl.status = 'available'
      AND hl.tenant_id IS NULL
      AND COALESCE(hl.is_hidden, false) = false
      AND COALESCE(hl.monthly_rent, 0) > 0
      AND NULLIF(btrim(COALESCE(hl.district, '')), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.partner_supported_houses psh
        WHERE psh.house_id = hl.id
          AND psh.status IN ('pending', 'active')
      )
  ) q;

  RETURN jsonb_build_object('total', v_total, 'houses', v_rows, 'districts', v_districts);
END;
$function$;

-- production public.partner_supported_house_returns (md5(pg_get_functiondef) ce1176237dea4005406c7e0434dce8f6 on 2026-11-06), SECURITY DEFINER dropped
CREATE FUNCTION pg_temp.prod_partner_supported_house_returns()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_phone text;
  v_rows jsonb := '[]'::jsonb;
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT lower(btrim(COALESCE(p.email, ''))), regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')
    INTO v_email, v_phone
  FROM public.profiles p WHERE p.id = v_uid;

  WITH my_notes AS (
    SELECT n.*
    FROM public.promissory_notes n
    WHERE n.partner_user_id = v_uid
       OR (NULLIF(v_email, '') IS NOT NULL AND lower(btrim(COALESCE(n.email, ''))) = v_email)
       OR (
         NULLIF(v_phone, '') IS NOT NULL AND length(v_phone) >= 9 AND (
           right(regexp_replace(COALESCE(n.phone_number, ''), '\D', '', 'g'), 9) = right(v_phone, 9)
           OR right(regexp_replace(COALESCE(n.whatsapp_number, ''), '\D', '', 'g'), 9) = right(v_phone, 9)
         )
       )
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'intent_id', i.id,
    'note_id', n.id,
    'house_id', h.id,
    'title', h.title,
    'district', h.district,
    'sub_county', h.sub_county,
    'village', h.village,
    'monthly_rent', COALESCE(i.monthly_rent, h.monthly_rent, 0),
    'monthly_return', round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * 0.15),
    'annual_return', round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * 0.15 * 12),
    'intent_status', i.status,
    'note_status', n.status,
    'promised_amount', COALESCE(n.amount, 0),
    'collected_amount', COALESCE(n.total_collected, 0),
    'is_funded', (n.status = 'activated' OR COALESCE(n.total_collected, 0) > 0),
    'tenant_activated', (h.tenant_id IS NOT NULL),
    'tenant_name', tp.full_name,
    'listing_agent_name', ap.full_name,
    'monthly_paid_this_month', EXISTS (
      SELECT 1 FROM public.agent_landlord_payouts pay
      WHERE pay.tenant_id = h.tenant_id
        AND pay.cfo_approved_at IS NOT NULL
        AND (pay.cfo_approved_at AT TIME ZONE 'Africa/Kampala')::date >= v_month_start
    ),
    'last_paid_at', (
      SELECT max(pay.cfo_approved_at) FROM public.agent_landlord_payouts pay
      WHERE pay.tenant_id = h.tenant_id AND pay.cfo_approved_at IS NOT NULL
    ),
    'created_at', i.created_at
  ) ORDER BY i.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM public.promissory_note_house_intents i
  JOIN my_notes n ON n.id = i.note_id
  JOIN public.house_listings h ON h.id = i.house_id
  LEFT JOIN public.profiles tp ON tp.id = h.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = i.listing_agent_id;

  RETURN jsonb_build_object(
    'houses', v_rows,
    'total_monthly_return', COALESCE((SELECT SUM((x->>'monthly_return')::numeric) FROM jsonb_array_elements(v_rows) x), 0),
    'total_annual_return', COALESCE((SELECT SUM((x->>'annual_return')::numeric) FROM jsonb_array_elements(v_rows) x), 0),
    'house_count', jsonb_array_length(v_rows)
  );
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Helpers (pg_temp, rolled back with everything else)
-- ---------------------------------------------------------------------------------------------
-- Act as a user: request.jwt.claims (+ legacy claim settings), or clear them (backend / owner).
CREATE FUNCTION pg_temp.dr_as(p_uid uuid, p_aal text DEFAULT 'aal1') RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  IF p_uid IS NULL THEN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  ELSE
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true);
    PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END IF;
END $f$;

-- Run one SQL expression returning jsonb as a user. p_role: 'authenticated' (browser), 'anon' (signed out),
-- 'owner' (claims set, database-owner role: used for the prod_ copies, which are not SECURITY DEFINER).
-- Returns {"ok": result} or {"error": message}.
CREATE FUNCTION pg_temp.dr_call(p_as uuid, p_sql text, p_role text DEFAULT 'authenticated', p_aal text DEFAULT 'aal1')
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.dr_as(p_as, p_aal);
  IF p_role = 'anon' THEN
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    SET LOCAL ROLE anon;
  ELSIF p_role = 'authenticated' AND p_as IS NOT NULL THEN
    SET LOCAL ROLE authenticated;
  END IF;
  BEGIN
    EXECUTE p_sql INTO v;
    v := jsonb_build_object('ok', v);
  EXCEPTION WHEN OTHERS THEN
    v := jsonb_build_object('error', SQLERRM);
  END;
  RESET ROLE;
  PERFORM pg_temp.dr_as(NULL);
  RETURN v;
END $f$;

CREATE FUNCTION pg_temp.dr_err(p jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN p ? 'error' THEN ' ERROR: ' || left(p ->> 'error', 300) ELSE '' END;
$f$;

-- rate/entitled/basis/requests of one portfolio.
CREATE FUNCTION pg_temp.dr_pf(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE((SELECT format('%s/%s/%s/req=%s', trim_scale(ip.roi_percentage), trim_scale(ip.entitled_rate), ip.rate_basis,
                                 (SELECT count(*) FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = ip.id))
                     FROM public.investor_portfolios ip WHERE ip.id = p_id), 'no portfolio');
$f$;

-- CFO requests of one portfolio: source:status:requested/in_force/standard[:requested_by].
CREATE FUNCTION pg_temp.dr_req(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE(string_agg(format('%s:%s:%s/%s/%s', a.source, a.status, trim_scale(a.requested_rate),
                                    trim_scale(a.rate_in_force), trim_scale(a.standard_rate)), ',' ORDER BY a.requested_at), 'none')
    FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = p_id;
$f$;

-- Self-managed rows of one commitment: commitment rate, house rates, notice rates, notice amounts right.
CREATE FUNCTION pg_temp.dr_commit(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT format('commitment=%s houses=%s notices=%s notice_returns_ok=%s',
    (SELECT trim_scale(c.monthly_rate) FROM public.partner_self_commitments c WHERE c.id = p_id),
    (SELECT string_agg(DISTINCT trim_scale(h.monthly_rate)::text, ',') FROM public.partner_supported_houses h WHERE h.commitment_id = p_id),
    (SELECT string_agg(DISTINCT trim_scale(n.return_rate)::text, ',') FROM public.funder_house_progress_notices n WHERE n.commitment_id = p_id),
    (SELECT bool_and(n.monthly_return = round(n.principal * n.return_rate / 100))::text
       FROM public.funder_house_progress_notices n WHERE n.commitment_id = p_id));
$f$;

-- Promissory notes: count, status, rate/basis, linked, pledge and booking notices, ledger rows.
CREATE FUNCTION pg_temp.dr_notes(p_ids uuid[]) RETURNS text LANGUAGE sql AS $f$
  SELECT format('n=%s status=%s rate=%s linked=%s pledge=%s:%s booking=%s:%s pledge_amounts_ok=%s ledger_rows=%s',
    (SELECT count(*) FROM public.promissory_notes n WHERE n.id = ANY (p_ids)),
    (SELECT string_agg(DISTINCT n.status, ',') FROM public.promissory_notes n WHERE n.id = ANY (p_ids)),
    (SELECT string_agg(DISTINCT trim_scale(n.return_rate)::text || '/' || n.return_rate_basis, ',') FROM public.promissory_notes n WHERE n.id = ANY (p_ids)),
    (SELECT count(*) FROM public.promissory_notes n WHERE n.id = ANY (p_ids) AND n.partner_user_id IS NOT NULL),
    (SELECT count(*) FROM public.promissory_note_pledge_notices x WHERE x.note_id = ANY (p_ids)),
    (SELECT string_agg(DISTINCT trim_scale(x.return_rate)::text, ',') FROM public.promissory_note_pledge_notices x WHERE x.note_id = ANY (p_ids)),
    (SELECT count(*) FROM public.promissory_house_booking_notices x WHERE x.note_id = ANY (p_ids)),
    (SELECT string_agg(DISTINCT trim_scale(x.return_rate)::text, ',') FROM public.promissory_house_booking_notices x WHERE x.note_id = ANY (p_ids)),
    (SELECT bool_and(x.monthly_return = round(x.amount * x.return_rate / 100)
                     AND x.annual_return = round(x.amount * x.return_rate / 100 * 12))::text
       FROM public.promissory_note_pledge_notices x WHERE x.note_id = ANY (p_ids)),
    (SELECT count(*) FROM public.general_ledger g WHERE g.source_table = 'promissory_notes' AND g.source_id = ANY (p_ids)));
$f$;

-- A house list sorted by house_id (row order can differ between two runs of the same query on ties).
CREATE FUNCTION pg_temp.dr_sorted(p jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT COALESCE(jsonb_agg(e ORDER BY e ->> 'house_id'), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(p, '[]'::jsonb)) e;
$f$;

-- Every listed house quotes round(rent * rate / 100) a month and 12x that a year.
CREATE FUNCTION pg_temp.dr_houses_at(p jsonb, p_rate numeric) RETURNS boolean LANGUAGE sql AS $f$
  SELECT COALESCE(bool_and((e ->> 'partner_monthly_return')::numeric = round((e ->> 'monthly_rent')::numeric * p_rate / 100)
                           AND (e ->> 'partner_annual_return')::numeric = round((e ->> 'monthly_rent')::numeric * p_rate / 100 * 12)),
                  false)
    FROM jsonb_array_elements(COALESCE(p, '[]'::jsonb)) e;
$f$;

-- The 12-argument call shape the screens use today (named arguments, as PostgREST sends them).
CREATE FUNCTION pg_temp.dr_list_sql(p_extra text DEFAULT '') RETURNS text LANGUAGE sql AS $f$
  SELECT 'SELECT public.agent_list_empty_house_opportunities(p_search => NULL, p_limit => 30, p_offset => 0, '
      || 'p_district => NULL, p_verified_only => false, p_gps_only => false, p_min_rent => NULL, p_max_rent => NULL, '
      || 'p_near_lat => NULL, p_near_lng => NULL, p_radius_km => NULL, p_sort => NULL' || p_extra || ')';
$f$;

-- (round 3) The partner-rate advisory locks this session holds: public.partner_rate_lock takes the two-key lock
-- (hashtext('partner-rate'), bucket 0-255), which pg_locks lists as classid = key 1, objid = key 2, objsubid = 2.
-- held = how many; who_held = whether p_who's bucket is one of them.
CREATE FUNCTION pg_temp.dr_rate_locks(p_who uuid DEFAULT NULL) RETURNS TABLE (held bigint, who_held boolean)
LANGUAGE sql AS $f$
  SELECT count(*), COALESCE(bool_or(l.objid::bigint = (hashtext(p_who::text) & 255)), false)
    FROM pg_locks l
   WHERE l.pid = pg_backend_pid() AND l.locktype = 'advisory' AND l.granted AND l.objsubid = 2
     AND l.classid::bigint = (hashtext('partner-rate')::bigint & 4294967295);
$f$;

DO $t$
DECLARE
  o text := '';
  v_ceo uuid; v_ops uuid; v_agent uuid; v_p20 uuid; v_pnew uuid; v_signed uuid;
  v_staff_a uuid; v_staff_a_id uuid; v_staff_b uuid; v_staff_b_id uuid;
  v_late uuid; v_late_note uuid; v_rule uuid; v_rr uuid;
  v_h uuid[];
  v_period uuid; v_run uuid; v_slip_a uuid; v_slip_b uuid;
  v_pid uuid; v_cid uuid; v_late_pf uuid;
  v_ids uuid[]; v_ids_on uuid[];
  v_j jsonb; v_j2 jsonb; v_j3 jsonb;
  v_rate numeric; v_rate2 numeric; v_basis text; v_amt numeric;
  v_n bigint; v_m bigint; v_k bigint; v_b boolean; v_t text; v_t2 text; v_t3 text;
  v_err text; v_ctx text; v_ms numeric;
  v_hash_before text; v_hash_after text; v_live_before bigint; v_live_after bigint;
  v_cutoff timestamptz; v_ends date;
  v_lap timestamptz;
  v_payload jsonb;
  v_q text; v_p1 int; v_p2 int; v_p3 int;
  v_t4 text; v_b2 boolean; v_rent_txt text; v_pay int; v_k2 bigint;
  v_p0 int; v_late2 uuid; v_b3 boolean; v_t5 text; v_phone text; v_who uuid; v_people bigint;
  v_l0 bigint; v_l1 bigint; v_l2 bigint; v_l3 bigint; v_l4 bigint; v_xmin text; v_xmax0 text; v_xmax1 text; v_age int;
  v_code text; v_code2 text; v_who2 uuid; v_mail text; v_typed text; v_note uuid; v_note2 uuid; v_note3 uuid;
  v_b4 boolean; v_b5 boolean; v_t6 text;
  v_b6 boolean; v_who_was text;
  v_agent2 uuid; v_pid2 uuid; v_t7 text; v_t8 text; v_t9 text; v_k3 bigint;   -- (round 6)
  c_oc constant text := 'ON CONFLICT (portfolio_id) WHERE status = ''pending'' DO NOTHING';   -- (round 6) gate + late link
  c_pin constant text := '$2a$10$' || repeat('D', 53);
  c_phone constant text := '+256799000111';
  r record;
BEGIN
<<main>>
BEGIN
  -- =====================================================================================
  -- F. Fixtures (deterministic)
  -- =====================================================================================
  v_lap := clock_timestamp();
  o := o || format(E'\nINFO T0 migrations (Phase 1 + Phase 2) done %s ms after BEGIN',
                   round(extract(epoch FROM clock_timestamp() - now()) * 1000));
  -- What the server actually received, to compare with the saved rehearsal file (md5 of the whole text and of
  -- the Phase 1 / Phase 2 / rehearsal parts, split at each file's first line).
  v_q := current_query();
  v_p0 := position('-- Phase 2 (per-person Partner Returns, owner rules 2026-11-06) production rehearsal. NEVER COMMITS.' IN v_q);
  v_p1 := position('-- Partner Returns per person (Phase 1: the database core)' IN v_q);
  v_p2 := position('-- Partner Returns per person (Phase 2: every creation path uses the rule)' IN v_q);
  v_p3 := position('-- Phase 2 rehearsal part B (runs after both migrations)' IN v_q);
  o := o || format(E'\nINFO T0 text received: %s chars md5=%s; part A md5=%s phase1 md5=%s phase2 md5=%s part B md5=%s',
                   length(v_q), md5(v_q),
                   CASE WHEN v_p0 > 0 AND v_p1 > v_p0 THEN md5(substr(v_q, v_p0, v_p1 - v_p0)) ELSE 'not found' END,
                   CASE WHEN v_p1 > 0 AND v_p2 > v_p1 THEN md5(substr(v_q, v_p1, v_p2 - v_p1)) ELSE 'not found' END,
                   CASE WHEN v_p2 > 0 AND v_p3 > v_p2 THEN md5(substr(v_q, v_p2, v_p3 - v_p2)) ELSE 'not found' END,
                   CASE WHEN v_p3 > 0 AND v_p3 > v_p2 THEN md5(substr(v_q, v_p3)) ELSE 'not found' END);
  o := o || format(E'\nINFO T0 text received starts [%s] ends [%s]',
                   translate(left(v_q, 60), E'\n', '~'), translate(right(v_q, 200), E'\n', '~'));

  -- (round 3) Checks that need no fixtures run first, so they report even when a fixture is missing.
  -- S0.0 Production as it stood just BEFORE the migrations ran (part A of this file, same transaction).
  IF to_regclass('pg_temp._dr_pre') IS NULL THEN
    o := o || E'\nFAIL S0.0 part A did not run before the migrations (pg_temp._dr_pre is missing): the rehearsal must be assembled as part A, Phase 1, Phase 2, part B';
  ELSE
    FOR r IN SELECT * FROM pg_temp._dr_pre LOOP
      o := o || format(E'\n%s S0.0a before the migrations (part A done %s ms after BEGIN, as %s), the manifest''s functions were production''s: %s/%s md5(pg_get_functiondef) equal (want 50/50)%s',
                       CASE WHEN r.want_n = 50 AND r.match_n = 50 THEN 'PASS' ELSE 'FAIL' END,
                       round(extract(epoch FROM r.checked_at - now()) * 1000), r.run_as, r.match_n, r.want_n,
                       COALESCE(' | different: ' || left(r.mismatched, 600), ''));
      -- (round 4) 37 names: _promissory_note_notice_contacts added. (round 5) 38: partner_note_window_applies added.
      o := o || format(E'\n%s S0.0b before the migrations, none of the manifest''s %s expected-absent functions existed (the list names partner_rate_lock=%s, _promissory_note_rate_json=%s, _promissory_note_notice_contacts=%s, partner_note_window_applies=%s): present=[%s] (want 38, true, true, true, true, none)',
                       CASE WHEN r.absent_n = 38 AND 'partner_rate_lock' = ANY (r.absent_names)
                                 AND '_promissory_note_rate_json' = ANY (r.absent_names)
                                 AND '_promissory_note_notice_contacts' = ANY (r.absent_names)
                                 AND 'partner_note_window_applies' = ANY (r.absent_names) AND r.present IS NULL THEN 'PASS' ELSE 'FAIL' END,
                       r.absent_n, 'partner_rate_lock' = ANY (r.absent_names), '_promissory_note_rate_json' = ANY (r.absent_names),
                       '_promissory_note_notice_contacts' = ANY (r.absent_names), 'partner_note_window_applies' = ANY (r.absent_names),
                       COALESCE(r.present, ''));
      o := o || format(E'\n%s S0.0c before the migrations, no Phase 1/2 table, column, trigger or cron job existed: tables=[%s] columns=[%s] triggers=[%s] cron=[%s]',
                       CASE WHEN r.tables_present IS NULL AND r.columns_present IS NULL AND r.triggers_present IS NULL
                                 AND r.cron_present IS NULL THEN 'PASS' ELSE 'FAIL' END,
                       COALESCE(r.tables_present, ''), COALESCE(r.columns_present, ''), COALESCE(r.triggers_present, ''),
                       COALESCE(r.cron_present, ''));
    END LOOP;
  END IF;

  -- (round 3) S0.11 The two new helpers run only as their owner: partner_rate_lock(uuid[]) (plpgsql) and
  --       _promissory_note_rate_json(promissory_notes, uuid) (sql): SECURITY INVOKER, proacl {owner=X/owner}, no
  --       EXECUTE for anon, authenticated or service_role.
  SELECT string_agg(format('%s: %s secdef=%s volatility=%s owner=%s proacl=%s anon=%s authenticated=%s service_role=%s',
                           p.proname, l.lanname, p.prosecdef, p.provolatile, pg_get_userbyid(p.proowner), COALESCE(p.proacl::text, 'default'),
                           has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                           has_function_privilege('service_role', p.oid, 'EXECUTE')), ' | ' ORDER BY p.proname),
         count(*),
         bool_and(NOT p.prosecdef
                  AND p.proacl::text = format('{%s=X/%s}', pg_get_userbyid(p.proowner), pg_get_userbyid(p.proowner))
                  AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                  AND l.lanname = CASE p.proname WHEN 'partner_rate_lock' THEN 'plpgsql' ELSE 'sql' END)
    INTO v_t, v_n, v_b
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid IN (to_regprocedure('public.partner_rate_lock(uuid[])'),
                   to_regprocedure('public._promissory_note_rate_json(public.promissory_notes,uuid)'));
  o := o || format(E'\n%s S0.11 new helpers run only as their owner: %s (want 2 functions, secdef=f, proacl {owner=X/owner}, anon/authenticated/service_role f)',
                   CASE WHEN v_n = 2 AND v_b THEN 'PASS' ELSE 'FAIL' END, COALESCE(v_t, 'both missing'));

  -- (round 3) S0.12 Code (comments stripped): every rate decision takes the one per-person lock. The gate calls
  --       partner_rate_lock twice (invite re-decision, insert); the late-link trigger once, after the KEY SHARE on
  --       the candidate portfolios; the reward stamp calls it first. The lock takes one key per bucket (& 255);
  --       no function still takes the old 'partner-rate:<id>' lock; the gate's dangling comment is gone; both
  --       note RPCs return the rate through _promissory_note_rate_json and no longer return v_note.return_rate.
  WITH f AS (
    SELECT p.proname, p.prosrc AS raw, regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS c
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('enforce_partner_return_rate_policy', 'partner_note_linked_late', 'stamp_rent_facilitation_reward_rate',
                         'partner_rate_lock', 'agent_create_promissory_note', 'agent_create_promissory_note_for_houses')
  )
  SELECT (SELECT (length(f.c) - length(replace(f.c, 'public.partner_rate_lock(', ''))) / length('public.partner_rate_lock(')
            FROM f WHERE f.proname = 'enforce_partner_return_rate_policy'),
         (SELECT (length(f.c) - length(replace(f.c, 'public.partner_rate_lock(', ''))) / length('public.partner_rate_lock(')
            FROM f WHERE f.proname = 'partner_note_linked_late'),
         (SELECT position('FOR KEY SHARE' IN f.c) > 0 AND position('FOR KEY SHARE' IN f.c) < position('public.partner_rate_lock(' IN f.c)
            FROM f WHERE f.proname = 'partner_note_linked_late'),
         (SELECT ltrim(substr(f.c, position('BEGIN' IN f.c) + 5, 80), E' \n\t') LIKE 'PERFORM public.partner_rate_lock(ARRAY[NEW.supporter_id]);%'
            FROM f WHERE f.proname = 'stamp_rent_facilitation_reward_rate'),
         (SELECT position('pg_advisory_xact_lock(hashtext(''partner-rate''), v_bucket)' IN f.c) > 0 AND position('& 255' IN f.c) > 0
            FROM f WHERE f.proname = 'partner_rate_lock'),
         (SELECT position('see partner_note_linked_late' IN f.raw) FROM f WHERE f.proname = 'enforce_partner_return_rate_policy'),
         (SELECT string_agg(f.proname || '='
                            || (length(f.c) - length(replace(f.c, '_promissory_note_rate_json(v_note, v_uid)', '')))
                               / length('_promissory_note_rate_json(v_note, v_uid)')
                            || '/' || (position('''return_rate'', v_note.return_rate' IN f.c) > 0), ' ' ORDER BY f.proname)
            FROM f WHERE f.proname LIKE 'agent\_create\_promissory\_note%')
    INTO v_n, v_m, v_b, v_b2, v_b3, v_k, v_t;
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname) INTO v_t2 FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%partner-rate:%';
  o := o || format(E'\n%s S0.12 code: gate calls partner_rate_lock %s time(s) (want 2); late link %s (want 1), after its KEY SHARE=%s; reward stamp takes it first=%s; one key per bucket (& 255)=%s; old ''partner-rate:'' lock in [%s] (want none); gate comment "see partner_note_linked_late" at %s (want 0); note RPCs [%s] (want each =1/false)',
                   CASE WHEN v_n = 2 AND v_m = 1 AND v_b AND v_b2 AND v_b3 AND v_t2 IS NULL AND v_k = 0
                             AND v_t = 'agent_create_promissory_note=1/false agent_create_promissory_note_for_houses=1/false'
                        THEN 'PASS' ELSE 'FAIL' END,
                   v_n, v_m, v_b, v_b2, v_b3, COALESCE(v_t2, ''), v_k, COALESCE(v_t, 'missing'));

  -- (round 3) S0.13 Reward-rate backfill (rewritten in round 3): one stored rate per rent request with a supporter; the
  --       switch has never been on, so every row is the legacy rate, basis legacy, same supporter, decided at funded_at.
  SELECT count(*),
         count(*) FILTER (WHERE x.supporter_id = rr.supporter_id AND x.basis = 'legacy' AND x.rate = p.legacy_rate
                            AND x.decided_at = COALESCE(rr.funded_at, now())),
         count(*) FILTER (WHERE rr.id IS NULL OR rr.supporter_id IS NULL)
    INTO v_n, v_m, v_k
    FROM public.rent_facilitation_reward_rates x
    JOIN public.partner_return_policy p ON p.id
    LEFT JOIN public.rent_requests rr ON rr.id = x.rent_request_id;
  SELECT count(*) INTO v_k2 FROM public.rent_requests rr WHERE rr.supporter_id IS NOT NULL;
  o := o || format(E'\n%s S0.13 reward-rate backfill: %s stored rate(s), %s rent request(s) with a supporter; legacy rate/basis, same supporter, decided at funded_at: %s; rows for a request without a supporter: %s (want equal counts, all, 0)',
                   CASE WHEN v_n = v_k2 AND v_m = v_n AND v_k = 0 THEN 'PASS' ELSE 'FAIL' END, v_n, v_k2, v_m, v_k);

  -- (round 4) S0.14 Where a note's pledge and booking notices go: _promissory_note_notice_contacts(promissory_notes,
  --       OUT phone, OUT email) is sql, STABLE, SECURITY INVOKER and runs only as its owner (proacl {owner=X/owner},
  --       no EXECUTE for anon, authenticated or service_role); both notice queues (comments stripped) call it once
  --       on v_note, insert v_to.phone, v_to.email, and no longer build the contacts from the typed note fields.
  v_t := NULL; v_b := NULL; v_t2 := NULL; v_n := NULL;
  SELECT format('%s secdef=%s volatility=%s owner=%s proacl=%s anon=%s authenticated=%s service_role=%s result=%s args=%s/%s',
                l.lanname, p.prosecdef, p.provolatile, pg_get_userbyid(p.proowner), COALESCE(p.proacl::text, 'default'),
                has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                has_function_privilege('service_role', p.oid, 'EXECUTE'), pg_get_function_result(p.oid),
                p.proargnames::text, p.proargmodes::text),
         l.lanname = 'sql' AND NOT p.prosecdef AND p.provolatile = 's'
           AND p.proacl::text = format('{%s=X/%s}', pg_get_userbyid(p.proowner), pg_get_userbyid(p.proowner))
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
           AND pg_get_function_result(p.oid) = 'record'
           AND p.proargnames::text = '{p_note,phone,email}' AND p.proargmodes::text = '{i,o,o}'
    INTO v_t, v_b
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = to_regprocedure('public._promissory_note_notice_contacts(public.promissory_notes)');
  WITH f AS (
    SELECT p.proname, regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS c
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('psm_queue_promissory_pledge_notice', 'psm_queue_house_booking_notice')
  )
  SELECT string_agg(format('%s calls=%s to=%s typed=%s', f.proname,
                           (length(f.c) - length(replace(f.c, 'public._promissory_note_notice_contacts(v_note)', '')))
                             / length('public._promissory_note_notice_contacts(v_note)'),
                           position('v_to.phone, v_to.email' IN f.c) > 0,
                           position('btrim(v_note.whatsapp_number)' IN f.c) > 0 OR position('btrim(v_note.email)' IN f.c) > 0),
                    ' | ' ORDER BY f.proname), count(*)
    INTO v_t2, v_n FROM f;
  o := o || format(E'\n%s S0.14 notice contacts helper: %s; queues [%s] (want sql secdef=f volatility=s proacl {owner=X/owner}, anon/authenticated/service_role f, result=record args={p_note,phone,email}/{i,o,o}; each queue calls=1 to=t typed=f)',
                   CASE WHEN COALESCE(v_b, false) AND v_n = 2
                             AND v_t2 = 'psm_queue_house_booking_notice calls=1 to=t typed=f | psm_queue_promissory_pledge_notice calls=1 to=t typed=f'
                        THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_t, 'missing'), COALESCE(v_t2, ''));

  -- (round 4) S0.15 Code: the note RPC helper leaves the linked account's id out of a note linked to someone else (its
  --       ELSE branch drops partner_user_id with the rate and basis), and the booked-house list (comments stripped)
  --       shows return_rate, monthly_return and annual_return only for a note unlinked or linked to the caller.
  SELECT (SELECT position('''return_rate_basis'' - ''return_rate'' - ''partner_user_id''' IN p.prosrc) > 0
            FROM pg_proc p WHERE p.oid = to_regprocedure('public._promissory_note_rate_json(public.promissory_notes,uuid)')),
         (SELECT (length(x.c) - length(replace(x.c, 'n.partner_user_id IS NULL OR n.partner_user_id = v_uid', '')))
                 / length('n.partner_user_id IS NULL OR n.partner_user_id = v_uid')
            FROM (SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS c FROM pg_proc p
                   WHERE p.oid = to_regprocedure('public.partner_supported_house_returns()')) x)
    INTO v_b, v_n;
  o := o || format(E'\n%s S0.15 code: _promissory_note_rate_json drops partner_user_id for a note linked to someone else=%s; partner_supported_house_returns shows the rate figures only for the caller''s own or an unlinked note: %s guard(s) (want true, 3)',
                   CASE WHEN COALESCE(v_b, false) AND v_n = 3 THEN 'PASS' ELSE 'FAIL' END, COALESCE(v_b::text, 'missing'), v_n);

  -- (round 4; round 5) S0.16 Code (comments stripped). The gate's staff rate-change path (the loop FOR v_try IN 1..2)
  --       locks the portfolio's open requests in id order, supersedes them, inserts with ON CONFLICT on the
  --       one-pending slot DO NOTHING, leaves the loop when a row went in (EXIT WHEN FOUND) and on the second miss
  --       raises 23505 naming portfolio_rate_approvals_one_pending. Round 5: no sub-transaction (no EXCEPTION WHEN
  --       anywhere in the gate, no BEGIN inside the loop, v_constraint gone). The late link takes KEY SHARE twice, the
  --       second look-up with SKIP LOCKED; it counts as busy only a skipped portfolio not already covered by an open
  --       request at or above the note's rate (round 5) and adds that to the alert; it locks the lower open requests
  --       in id order (FOR UPDATE OF a) before superseding, replaces only requests below the note's rate, its insert
  --       skips a portfolio with an open request at or above the note's rate (round 5), and uses the round-4 wording.
  v_code := NULL; v_code2 := NULL; v_t := NULL; v_t2 := NULL; v_t3 := NULL; v_b := NULL; v_b2 := NULL; v_b3 := NULL;
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO v_code FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.enforce_partner_return_rate_policy()');
  v_p0 := position('FOR v_try IN 1..2 LOOP' IN COALESCE(v_code, ''));
  IF v_p0 > 0 THEN
    v_code2 := substr(v_code, v_p0, position('END LOOP;' IN substr(v_code, v_p0)) + 8);
    v_t := concat_ws(',', position('ORDER BY a.id FOR UPDATE;' IN v_code2), position('SET status = ''superseded''' IN v_code2),
                     position('INSERT INTO public.portfolio_rate_approvals' IN v_code2),
                     position('ON CONFLICT (portfolio_id) WHERE status = ''pending'' DO NOTHING;' IN v_code2),
                     position('EXIT WHEN FOUND;' IN v_code2), position('IF v_try = 2 THEN' IN v_code2),
                     position('RAISE EXCEPTION ''Another Returns rate request for this portfolio was opened at the same moment; try again''' IN v_code2),
                     position('USING ERRCODE = ''23505'', CONSTRAINT = ''portfolio_rate_approvals_one_pending'';' IN v_code2));
    -- every step found, in this order
    v_b := (SELECT bool_and(x.p > 0) AND array_agg(x.p ORDER BY x.o) = array_agg(x.p ORDER BY x.p)
              FROM unnest(string_to_array(v_t, ',')::int[]) WITH ORDINALITY AS x(p, o));
    v_b2 := (length(v_code) - length(replace(v_code, 'FOR v_try IN 1..2 LOOP', ''))) / length('FOR v_try IN 1..2 LOOP') = 1;
    v_t3 := format('exception_blocks=%s begin_in_loop=%s v_constraint=%s',
                   (length(v_code) - length(replace(v_code, 'EXCEPTION WHEN', ''))) / length('EXCEPTION WHEN'),
                   v_code2 ~ '\mBEGIN\M', position('v_constraint' IN v_code) > 0);
  END IF;
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO v_code2 FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.partner_note_linked_late()');
  v_code2 := COALESCE(v_code2, '');
  v_p0 := position('WITH ins AS (' IN v_code2);
  v_t2 := format('key_share=%s skip_locked=%s busy_counted=%s busy_skips_covered=%s busy_alerted=%s lower_locked_in_id_order=%s below_note_rate=%s insert_skips_covered=%s wording=%s',
                 (length(v_code2) - length(replace(v_code2, 'FOR KEY SHARE', ''))) / length('FOR KEY SHARE'),
                 position('FOR KEY SHARE SKIP LOCKED' IN v_code2) > 0,
                 position('SELECT count(*) INTO v_busy' IN v_code2) > 0 AND position('v_busy := cardinality(v_ids)' IN v_code2) = 0,
                 position('AND a.requested_rate >= x.r);' IN v_code2) > 0,
                 position('v_missed := v_missed + v_busy;' IN v_code2) > 0,
                 position('ORDER BY a.id FOR UPDATE OF a;' IN v_code2) > 0
                   AND position('ORDER BY a.id FOR UPDATE OF a;' IN v_code2) < position('Superseded: promissory note linked late' IN v_code2),
                 (length(v_code2) - length(replace(v_code2, 'a.requested_rate < t.note_rate', ''))) / length('a.requested_rate < t.note_rate'),
                 v_p0 > 0 AND position('AND a.requested_rate >= x.note_rate)' IN substr(v_code2, v_p0)) > 0
                   AND position('AND a.requested_rate >= x.note_rate)' IN substr(v_code2, v_p0))
                       < position('ON CONFLICT (portfolio_id) WHERE status = ''pending'' DO NOTHING' IN substr(v_code2, v_p0)),
                 position('another change to the same portfolio' IN v_code2) > 0
                   AND position('Returns catch-up needs a check' IN v_code2) > 0);
  o := o || format(E'\n%s S0.16 code: gate rate-change path: one retry loop=%s; lock in id order, supersede, insert ON CONFLICT on the one-pending slot DO NOTHING, EXIT WHEN FOUND, on the second miss raise 23505 naming portfolio_rate_approvals_one_pending: positions [%s] all found and in order=%s; no sub-transaction: %s; late link: %s (want true; true; exception_blocks=0 begin_in_loop=f v_constraint=f; key_share=2 skip_locked=t busy_counted=t busy_skips_covered=t busy_alerted=t lower_locked_in_id_order=t below_note_rate=2 insert_skips_covered=t wording=t)',
                   CASE WHEN COALESCE(v_b, false) AND COALESCE(v_b2, false)
                             AND v_t3 = 'exception_blocks=0 begin_in_loop=f v_constraint=f'
                             AND v_t2 = 'key_share=2 skip_locked=t busy_counted=t busy_skips_covered=t busy_alerted=t lower_locked_in_id_order=t below_note_rate=2 insert_skips_covered=t wording=t'
                        THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_b2::text, 'loop missing'), COALESCE(v_t, ''), COALESCE(v_b::text, 'loop missing'),
                   COALESCE(v_t3, 'loop missing'), v_t2);

  -- (round 5; round 6) S0.17 Who a pre-cut-off note's window counts for: partner_note_window_applies(p_owner,
  --       p_agent_then, p_agent_now, p_person) (round 6: 4 arguments; the 3-argument version is dropped) is sql,
  --       IMMUTABLE, SECURITY INVOKER and runs only as its owner (proacl {owner=X/owner}, no EXECUTE for anon,
  --       authenticated or service_role). Its truth table on fixed literal ids: owner set, only the owner; owner null,
  --       anyone but the agent frozen at the cut-off and the note's agent now (round 6: a book transfer gives the
  --       receiving agent nothing). Exactly partner_rates_for and partner_note_linked_late call it, once each, on the
  --       window's frozen owner and agent and the note's current agent n.agent_id (comments stripped).
  v_t := NULL; v_b := NULL; v_t2 := NULL; v_t3 := NULL; v_t4 := NULL; v_n := NULL; v_m := NULL;
  SELECT format('%s secdef=%s volatility=%s owner=%s proacl=%s anon=%s authenticated=%s service_role=%s args=(%s) result=%s',
                l.lanname, p.prosecdef, p.provolatile, pg_get_userbyid(p.proowner), COALESCE(p.proacl::text, 'default'),
                has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                has_function_privilege('service_role', p.oid, 'EXECUTE'), pg_get_function_identity_arguments(p.oid),
                pg_get_function_result(p.oid)),
         l.lanname = 'sql' AND NOT p.prosecdef AND p.provolatile = 'i'
           AND p.proacl::text = format('{%s=X/%s}', pg_get_userbyid(p.proowner), pg_get_userbyid(p.proowner))
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
           AND pg_get_function_identity_arguments(p.oid) = 'p_owner uuid, p_agent_then uuid, p_agent_now uuid, p_person uuid'
           AND pg_get_function_result(p.oid) = 'boolean'
    INTO v_t, v_b
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = to_regprocedure('public.partner_note_window_applies(uuid,uuid,uuid,uuid)');
  -- (round 6) every function of that name, as name/number of arguments: only the 4-argument one is left
  SELECT string_agg(p.proname || '/' || p.pronargs, ',' ORDER BY p.pronargs) INTO v_t4 FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'partner_note_window_applies';
  IF v_b IS NOT NULL THEN
    -- owner A, another person B, the agent at the cut-off C, the note's agent now D (D = C: no transfer since)
    SELECT string_agg(public.partner_note_window_applies(x.o, x.a, x.d, x.p)::text, ',' ORDER BY x.k) INTO v_t2
      FROM (VALUES (1, '00000000-0000-4000-8000-00000000000a'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000a'::uuid),
                   (2, '00000000-0000-4000-8000-00000000000a'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000b'::uuid),
                   (3, '00000000-0000-4000-8000-00000000000a'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid),
                   (4, NULL::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid),
                   (5, NULL::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000b'::uuid),
                   (6, NULL::uuid, NULL::uuid, NULL::uuid, '00000000-0000-4000-8000-00000000000b'::uuid),
                   (7, NULL::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000d'::uuid, '00000000-0000-4000-8000-00000000000d'::uuid),
                   (8, NULL::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000d'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid),
                   (9, NULL::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000d'::uuid, '00000000-0000-4000-8000-00000000000b'::uuid),
                   (10, NULL::uuid, NULL::uuid, '00000000-0000-4000-8000-00000000000d'::uuid, '00000000-0000-4000-8000-00000000000d'::uuid),
                   (11, '00000000-0000-4000-8000-00000000000a'::uuid, '00000000-0000-4000-8000-00000000000c'::uuid, '00000000-0000-4000-8000-00000000000d'::uuid, '00000000-0000-4000-8000-00000000000a'::uuid)) AS x(k, o, a, d, p);
  END IF;
  SELECT string_agg(x.proname, ',' ORDER BY x.proname) INTO v_t3
    FROM (SELECT p.proname, p.prosrc FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'partner_note_window_applies'
             AND p.prosrc LIKE '%partner_note_window_applies(%') x
   WHERE regexp_replace(x.prosrc, '--[^\n]*', '', 'g') LIKE '%partner_note_window_applies(%';
  SELECT (SELECT (length(x.c) - length(replace(x.c, 'public.partner_note_window_applies(w.partner_user_id, w.agent_id, n.agent_id, i.pid)', '')))
                 / length('public.partner_note_window_applies(w.partner_user_id, w.agent_id, n.agent_id, i.pid)')
            FROM (SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS c FROM pg_proc p
                   WHERE p.oid = to_regprocedure('public.partner_rates_for(uuid[],boolean)')) x),
         (SELECT (length(x.c) - length(replace(x.c, 'public.partner_note_window_applies(w.partner_user_id, w.agent_id, n.agent_id, n.partner_user_id)', '')))
                 / length('public.partner_note_window_applies(w.partner_user_id, w.agent_id, n.agent_id, n.partner_user_id)')
            FROM (SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS c FROM pg_proc p
                   WHERE p.oid = to_regprocedure('public.partner_note_linked_late()')) x)
    INTO v_n, v_m;
  o := o || format(E'\n%s S0.17 note-window helper: %s; versions [%s]; truth table [%s] (want true,false,false,false,true,true,false,false,true,false,true: owner set counts only for the owner; owner null counts for anyone but the agent at the cut-off and the note''s agent now); called by [%s] (want partner_note_linked_late,partner_rates_for); partner_rates_for calls it on (w.partner_user_id, w.agent_id, n.agent_id, i.pid) %s time(s), partner_note_linked_late on (w.partner_user_id, w.agent_id, n.agent_id, n.partner_user_id) %s time(s) (want sql secdef=f volatility=i proacl {owner=X/owner}, anon/authenticated/service_role f, args=(p_owner uuid, p_agent_then uuid, p_agent_now uuid, p_person uuid) result=boolean; partner_note_window_applies/4 only; 1, 1)',
                   CASE WHEN COALESCE(v_b, false) AND v_t4 = 'partner_note_window_applies/4'
                             AND v_t2 = 'true,false,false,false,true,true,false,false,true,false,true'
                             AND v_t3 = 'partner_note_linked_late,partner_rates_for' AND v_n = 1 AND v_m = 1
                        THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_t, 'missing'), COALESCE(v_t4, 'none'), COALESCE(v_t2, ''), COALESCE(v_t3, ''),
                   COALESCE(v_n::text, 'missing'), COALESCE(v_m::text, 'missing'));

  -- (round 5) S0.18 The note guard (Phase 1; BEFORE UPDATE OF return_rate, return_rate_basis, partner_user_id; runs as
  --       the caller) also holds edge functions: its role list names service_role next to authenticated and anon
  --       (comments stripped); it is still SECURITY INVOKER (current_user must be the caller); its trigger is enabled
  --       on those three columns; the three refusals are there. Behaviour as service_role: S2.4. Also printed: whether
  --       service_role may UPDATE promissory_notes and bypasses RLS (else S2.4 cannot reach the guard).
  v_t := NULL; v_b := NULL; v_t2 := NULL; v_b2 := NULL;
  SELECT format('secdef=%s roles_incl_service_role=%s rate_refusal=%s move_refusal=%s link_refusal=%s', p.prosecdef,
                position('IF current_user IN (''authenticated'', ''anon'', ''service_role'') THEN' IN x.c) > 0,
                position('Returns rate is fixed when the note is written' IN x.c) > 0,
                position('A promissory note cannot be moved to another partner' IN x.c) > 0,
                position('Link a promissory note to a partner through the partner-linking tools, not directly' IN x.c) > 0),
         NOT p.prosecdef
           AND position('IF current_user IN (''authenticated'', ''anon'', ''service_role'') THEN' IN x.c) > 0
           AND position('Returns rate is fixed when the note is written' IN x.c) > 0
           AND position('A promissory note cannot be moved to another partner' IN x.c) > 0
           AND position('Link a promissory note to a partner through the partner-linking tools, not directly' IN x.c) > 0
    INTO v_t, v_b
    FROM pg_proc p CROSS JOIN LATERAL (SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS c) x
   WHERE p.oid = to_regprocedure('public.guard_promissory_note_return_rate()');
  SELECT format('trigger enabled=%s on the three columns=%s', t.tgenabled,
                pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF return_rate, return_rate_basis, partner_user_id ON %promissory_notes FOR EACH ROW EXECUTE FUNCTION %guard_promissory_note_return_rate()'),
         t.tgenabled <> 'D'
           AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF return_rate, return_rate_basis, partner_user_id ON %promissory_notes FOR EACH ROW EXECUTE FUNCTION %guard_promissory_note_return_rate()'
    INTO v_t2, v_b2
    FROM pg_trigger t WHERE t.tgrelid = 'public.promissory_notes'::regclass AND t.tgname = 'trg_zz_guard_note_return_rate';
  v_t3 := format('service_role may UPDATE promissory_notes=%s bypasses RLS=%s',
                 has_table_privilege('service_role', 'public.promissory_notes', 'UPDATE'),
                 (SELECT r2.rolbypassrls FROM pg_roles r2 WHERE r2.rolname = 'service_role'));
  o := o || format(E'\n%s S0.18 note guard: %s; %s (want secdef=f roles_incl_service_role=t rate_refusal=t move_refusal=t link_refusal=t; enabled, true); INFO %s',
                   CASE WHEN COALESCE(v_b, false) AND COALESCE(v_b2, false) THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_t, 'guard missing'), COALESCE(v_t2, 'trigger missing'), v_t3);

  -- (round 5) S0.19 The pledge and booking notices of a note linked to someone take that person's LOGIN email:
  --       _promissory_note_notice_contacts (comments stripped) joins auth.users on the note's person and uses u.email
  --       in both linked branches, never profiles.email; a note linked to its own author (partner_user_id = agent_id)
  --       falls back to the typed contacts (one branch each for phone and email). The two queue functions run as
  --       their owner (SECURITY DEFINER) and the helper as the invoker, so that owner must be able to read
  --       auth.users.email.
  v_t := NULL; v_t2 := NULL; v_b := NULL;
  SELECT format('auth_join=%s login_email=%s profile_email=%s author_branches=%s',
                position('LEFT JOIN auth.users u ON u.id = p_note.partner_user_id' IN x.c) > 0,
                (length(x.c) - length(replace(x.c, 'btrim(u.email)', ''))) / length('btrim(u.email)'),
                position('pr.email' IN x.c) > 0,
                (length(x.c) - length(replace(x.c, 'p_note.partner_user_id = p_note.agent_id', ''))) / length('p_note.partner_user_id = p_note.agent_id'))
    INTO v_t
    FROM (SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS c FROM pg_proc p
           WHERE p.oid = to_regprocedure('public._promissory_note_notice_contacts(public.promissory_notes)')) x;
  SELECT string_agg(format('%s secdef=%s owner reads auth.users.email=%s', p.proname, p.prosecdef,
                           has_column_privilege(p.proowner, 'auth.users', 'email', 'SELECT')), ' | ' ORDER BY p.proname),
         bool_and(p.prosecdef AND has_column_privilege(p.proowner, 'auth.users', 'email', 'SELECT')) AND count(*) = 2
    INTO v_t2, v_b
    FROM pg_proc p
   WHERE p.oid IN (to_regprocedure('public.psm_queue_promissory_pledge_notice(uuid)'),
                   to_regprocedure('public.psm_queue_house_booking_notice(uuid,text)'));
  o := o || format(E'\n%s S0.19 notice contacts take the login email: %s; queues [%s] (want auth_join=t login_email=2 profile_email=f author_branches=2; each secdef=t owner reads auth.users.email=t)',
                   CASE WHEN v_t = 'auth_join=t login_email=2 profile_email=f author_branches=2' AND COALESCE(v_b, false)
                        THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_t, 'helper missing'), COALESCE(v_t2, 'queues missing'));

  -- (round 6) S0.20 At most one OPEN request (pending, or approved and not yet applied) per portfolio. The unique index
  --       portfolio_rate_approvals_one_open on (portfolio_id) WHERE status = 'pending' OR (status = 'approved' AND
  --       applied_at IS NULL) exists, is valid, and has that predicate. The gate and the late link each have the clause
  --       c_oc once (comments stripped), and EXPLAIN (planned, never executed) of both statement shapes with that clause
  --       lists the index as a conflict arbiter next to portfolio_rate_approvals_one_pending. Behaviour, in a savepoint
  --       undone straight after (a random portfolio id; its deferred reference is never checked): beside a scheduled
  --       request, the gate's INSERT ... DO NOTHING writes nothing and a plain pending INSERT is refused by this index.
  v_t := NULL; v_t2 := NULL; v_t3 := NULL; v_t4 := NULL; v_t5 := NULL; v_b := NULL; v_n := NULL; v_m := NULL;
  v_k := NULL; v_k3 := NULL; v_err := NULL; v_pid := NULL;
  BEGIN   -- a sub-block: a missing index or clause is reported here and the later checks still run
    SELECT format('unique=%s valid=%s ready=%s columns=%s', i.indisunique, i.indisvalid, i.indisready,
                  (SELECT string_agg(a.attname, ',' ORDER BY k.o) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(n, o)
                     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n)),
           pg_get_expr(i.indpred, i.indrelid) = '((status = ''pending''::text) OR ((status = ''approved''::text) AND (applied_at IS NULL)))'
      INTO v_t, v_b
      FROM pg_index i
     WHERE i.indexrelid = to_regclass('public.portfolio_rate_approvals_one_open')
       AND i.indrelid = to_regclass('public.portfolio_rate_approvals');
    SELECT (SELECT (length(x.c) - length(replace(x.c, c_oc, ''))) / length(c_oc)
              FROM (SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS c FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.enforce_partner_return_rate_policy()')) x),
           (SELECT (length(x.c) - length(replace(x.c, c_oc, ''))) / length(c_oc)
              FROM (SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS c FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.partner_note_linked_late()')) x)
      INTO v_n, v_m;
    -- the gate's shape (INSERT ... VALUES) and the late link's (INSERT ... SELECT in a CTE ... RETURNING)
    FOR v_t5 IN EXECUTE 'EXPLAIN (COSTS OFF) INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by) '
                        || 'VALUES (gen_random_uuid(), 10, 10, 10, ''rate_change'', NULL) ' || c_oc LOOP
      IF position('Conflict Arbiter Indexes:' IN v_t5) > 0 THEN
        SELECT string_agg(btrim(y), ',' ORDER BY btrim(y)) INTO v_t2
          FROM unnest(string_to_array(split_part(v_t5, 'Conflict Arbiter Indexes:', 2), ',')) y;
      END IF;
    END LOOP;
    FOR v_t5 IN EXECUTE 'EXPLAIN (COSTS OFF) WITH ins AS (INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by) '
                        || 'SELECT x.id, x.note_rate, x.in_force, x.note_rate, ''note_late_link'', NULL::uuid '
                        || 'FROM unnest(ARRAY[gen_random_uuid()], ARRAY[15::numeric], ARRAY[10::numeric]) AS x(id, note_rate, in_force) '
                        || c_oc || ' RETURNING portfolio_id) SELECT count(*) FROM ins' LOOP
      IF position('Conflict Arbiter Indexes:' IN v_t5) > 0 THEN
        SELECT string_agg(btrim(y), ',' ORDER BY btrim(y)) INTO v_t3
          FROM unnest(string_to_array(split_part(v_t5, 'Conflict Arbiter Indexes:', 2), ',')) y;
      END IF;
    END LOOP;
    v_pid := gen_random_uuid();
    BEGIN
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, status, decided_at)
      VALUES (v_pid, 12, 10, 10, 'rate_change', 'approved', now());               -- scheduled: approved, not applied yet
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
      VALUES (v_pid, 15, 10, 10, 'rate_change', NULL)
      ON CONFLICT (portfolio_id) WHERE status = 'pending' DO NOTHING;
      GET DIAGNOSTICS v_k = ROW_COUNT;
      BEGIN
        INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
        VALUES (v_pid, 15, 10, 10, 'note_late_link', NULL);
        v_t4 := 'not refused';
      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_t4 = CONSTRAINT_NAME;
        v_t4 := '23505 ' || v_t4;
      END;
      RAISE EXCEPTION 'DR_UNDO';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'DR_UNDO' THEN v_err := SQLERRM; END IF;
    END;
    SELECT count(*) INTO v_k3 FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = v_pid;
  EXCEPTION WHEN OTHERS THEN
    v_err := concat_ws('; ', v_err, SQLERRM);
  END;
  v_pid := NULL;
  o := o || format(E'\n%s S0.20 one open request per portfolio: index portfolio_rate_approvals_one_open %s, predicate as written=%s; ON CONFLICT clause in the gate %s time(s), in the late link %s time(s); arbiters: gate shape [%s], late-link shape [%s]; beside a scheduled request (undone): ON CONFLICT insert wrote %s row(s), plain pending insert -> %s; rows left=%s (want unique=t valid=t ready=t columns=portfolio_id, true; 1, 1; portfolio_rate_approvals_one_open,portfolio_rate_approvals_one_pending twice; 0, 23505 portfolio_rate_approvals_one_open, 0)%s',
                   CASE WHEN v_err IS NULL AND v_t = 'unique=t valid=t ready=t columns=portfolio_id' AND COALESCE(v_b, false)
                             AND v_n = 1 AND v_m = 1
                             AND v_t2 = 'portfolio_rate_approvals_one_open,portfolio_rate_approvals_one_pending'
                             AND v_t3 = 'portfolio_rate_approvals_one_open,portfolio_rate_approvals_one_pending'
                             AND v_k = 0 AND v_t4 = '23505 portfolio_rate_approvals_one_open' AND v_k3 = 0
                        THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_t, 'missing'), COALESCE(v_b::text, 'missing'), COALESCE(v_n::text, 'missing'),
                   COALESCE(v_m::text, 'missing'), COALESCE(v_t2, ''), COALESCE(v_t3, ''), COALESCE(v_k::text, '?'),
                   COALESCE(v_t4, '?'), COALESCE(v_k3::text, '?'),
                   CASE WHEN v_err IS NOT NULL THEN ' ERROR: ' || left(v_err, 300) ELSE '' END);

  SELECT ur.user_id INTO v_ceo FROM public.user_roles ur
   WHERE ur.role = 'ceo' AND ur.enabled ORDER BY ur.user_id LIMIT 1;
  SELECT ur.user_id INTO v_ops FROM public.user_roles ur
   WHERE ur.role = 'partner_ops' AND ur.enabled AND NOT public._has_enabled_role(ur.user_id, ARRAY['ceo'])
   ORDER BY ur.user_id LIMIT 1;
  -- (A loop over the ordered role index: a single ORDER BY ... LIMIT 1 query plans as a full anti-join over
  --  ~59k agents and took 3 s.)
  FOR r IN SELECT ur.user_id FROM public.user_roles ur WHERE ur.role = 'agent' AND ur.enabled ORDER BY ur.user_id LOOP
    IF NOT EXISTS (SELECT 1 FROM public.user_roles u2 WHERE u2.user_id = r.user_id AND u2.enabled
                      AND u2.role::text NOT IN ('tenant', 'agent', 'supporter', 'landlord'))
       AND NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = r.user_id)
       AND NOT EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = r.user_id AND sp.revoked_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = r.user_id)
       AND NOT EXISTS (SELECT 1 FROM public.partner_agreements pa WHERE pa.partner_id = r.user_id)
       AND NOT EXISTS (SELECT 1 FROM public.promissory_notes n WHERE n.partner_user_id = r.user_id) THEN
      v_agent := r.user_id;
      EXIT;
    END IF;
  END LOOP;

  -- Signed partners (funder_has_signed_agreement) with float, not staff, no promissory note, not an unverified
  -- self-registered funder, no staff role.
  WITH signed AS MATERIALIZED (
    SELECT pa.partner_id AS uid FROM public.partner_agreements pa
     WHERE pa.countersigned_at IS NOT NULL OR pa.status IN ('signed', 'active', 'completed', 'countersigned', 'verified')
    UNION SELECT sa.supporter_id FROM public.supporter_agreement_acceptance sa WHERE sa.status = 'accepted'
  ), pool AS MATERIALIZED (
    SELECT s.uid FROM signed s JOIN public.wallet_balances_projection wb ON wb.user_id = s.uid
     WHERE wb.float_balance >= 1000000
       AND NOT EXISTS (SELECT 1 FROM public.hr_staff st WHERE st.user_id = s.uid AND st.active)
       AND NOT EXISTS (SELECT 1 FROM public.promissory_notes n WHERE n.partner_user_id = s.uid)
       AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = s.uid
                      AND NOT (COALESCE(p.signup_source, '') = 'funder-onboarding' AND p.funder_verified_at IS NULL))
       AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = s.uid AND ur.enabled
                          AND ur.role::text NOT IN ('tenant', 'agent', 'supporter', 'landlord'))
  )
  SELECT (SELECT p.uid FROM pool p
           WHERE (SELECT max(ip.roi_percentage) FROM public.investor_portfolios ip
                   WHERE ip.investor_id = p.uid AND ip.status IN ('active', 'locked')) = 20
           ORDER BY p.uid LIMIT 1),
         (SELECT p.uid FROM pool p
           WHERE NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = p.uid)
             AND NOT EXISTS (SELECT 1 FROM public.partner_agreements pa WHERE pa.partner_id = p.uid
                                AND pa.partner_signature_data_url IS NOT NULL AND pa.countersigned_at IS NULL)
           ORDER BY p.uid LIMIT 1)
    INTO v_p20, v_pnew;

  SELECT pa.partner_id INTO v_signed FROM public.partner_agreements pa
   WHERE pa.partner_signature_data_url IS NOT NULL AND pa.countersigned_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip
                      WHERE ip.investor_id = pa.partner_id AND ip.status IN ('active', 'locked', 'redeemed'))
     AND NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = pa.partner_id AND s.active)
   ORDER BY pa.partner_id LIMIT 1;

  FOR r IN
    SELECT s.user_id, s.id FROM public.hr_staff s JOIN public.profiles p ON p.id = s.user_id
     WHERE s.active
       AND NOT (COALESCE(p.signup_source, '') = 'funder-onboarding' AND p.funder_verified_at IS NULL)
       AND NOT public._has_enabled_role(s.user_id, ARRAY['ceo', 'cfo', 'partner_ops'])
       AND NOT EXISTS (SELECT 1 FROM public.hr_pay_staff_reinvestments rv
                         JOIN public.investor_portfolios ip ON ip.id = rv.portfolio_id
                        WHERE rv.user_id = s.user_id
                          AND ip.status IN ('pending_ops_approval', 'awaiting_partner_details', 'active'))
     ORDER BY s.user_id LIMIT 2
  LOOP
    IF v_staff_a IS NULL THEN v_staff_a := r.user_id; v_staff_a_id := r.id;
    ELSE v_staff_b := r.user_id; v_staff_b_id := r.id; END IF;
  END LOOP;

  -- A pre-cut-off note with nobody linked, that the note validation trigger accepts on update.
  SELECT n.id INTO v_late_note FROM public.promissory_notes n
   WHERE n.partner_user_id IS NULL AND n.status = 'pending' AND n.amount > 0
     AND (n.contribution_type = 'once_off' OR n.deduction_day BETWEEN 1 AND 28)
   ORDER BY n.id LIMIT 1;

  SELECT p.id INTO v_late FROM public.profiles p
   WHERE p.id IS DISTINCT FROM v_agent
     AND NOT (COALESCE(p.signup_source, '') = 'funder-onboarding' AND p.funder_verified_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.agent_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.promissory_notes n WHERE n.partner_user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.partner_agreements pa WHERE pa.partner_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur
                      WHERE ur.user_id = p.id AND ur.role::text NOT IN ('tenant', 'agent', 'supporter', 'landlord'))
   ORDER BY p.id LIMIT 1;

  -- (round 3) late2: the next brand-new person after 'late' in id order (S3.19 links a DRYRUN note to them inside a
  -- savepoint that is undone straight after).
  SELECT p.id INTO v_late2 FROM public.profiles p
   WHERE p.id > v_late AND p.id IS DISTINCT FROM v_agent
     AND NOT (COALESCE(p.signup_source, '') = 'funder-onboarding' AND p.funder_verified_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.agent_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.promissory_notes n WHERE n.partner_user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.partner_agreements pa WHERE pa.partner_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur
                      WHERE ur.user_id = p.id AND ur.role::text NOT IN ('tenant', 'agent', 'supporter', 'landlord'))
   ORDER BY p.id LIMIT 1;

  -- (round 6) agent2: the next plain agent after 'agent' in id order (the same tests as for 'agent'), other than late
  -- and late2. S2.3 moves the DRYRUN h4 note to them as a book transfer does, inside a savepoint undone straight after.
  IF v_agent IS NOT NULL THEN
    FOR r IN SELECT ur.user_id FROM public.user_roles ur
              WHERE ur.role = 'agent' AND ur.enabled AND ur.user_id > v_agent ORDER BY ur.user_id LOOP
      IF r.user_id IS DISTINCT FROM v_late AND r.user_id IS DISTINCT FROM v_late2
         AND NOT EXISTS (SELECT 1 FROM public.user_roles u2 WHERE u2.user_id = r.user_id AND u2.enabled
                            AND u2.role::text NOT IN ('tenant', 'agent', 'supporter', 'landlord'))
         AND NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = r.user_id)
         AND NOT EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = r.user_id AND sp.revoked_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = r.user_id)
         AND NOT EXISTS (SELECT 1 FROM public.partner_agreements pa WHERE pa.partner_id = r.user_id)
         AND NOT EXISTS (SELECT 1 FROM public.promissory_notes n WHERE n.partner_user_id = r.user_id) THEN
        v_agent2 := r.user_id;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  SELECT rv.id INTO v_rule FROM public.hr_pay_rule_versions rv ORDER BY rv.id LIMIT 1;
  SELECT rr.id INTO v_rr FROM public.rent_requests rr WHERE rr.supporter_id IS NOT NULL ORDER BY rr.id LIMIT 1;

  SELECT array_agg(x.id ORDER BY x.id) INTO v_h FROM (
    SELECT h.id FROM public.house_listings h
     WHERE h.status = 'available' AND h.tenant_id IS NULL AND COALESCE(h.is_hidden, false) = false AND h.verified
       AND h.monthly_rent BETWEEN 50000 AND 150000 AND h.agent_id IS NOT NULL
       AND NOT public.house_has_live_claim(h.id)
     ORDER BY h.id LIMIT 8) x;

  FOR r IN SELECT * FROM (VALUES
      ('ceo', v_ceo), ('partner_ops caller', v_ops), ('plain agent', v_agent),
      ('existing partner, highest live rate 20 (p20)', v_p20), ('new partner with float (pnew)', v_pnew),
      ('signed, not countersigned (signed)', v_signed),
      ('staff A user (payroll, switch off)', v_staff_a), ('staff B user (payroll, switch on)', v_staff_b),
      ('pre-cut-off pending note, nobody linked', v_late_note), ('brand-new person for the late link (late)', v_late),
      ('hr_pay rule version', v_rule), ('legacy rent request with a supporter', v_rr),
      ('second brand-new person for the locked late link (late2, S3.19)', v_late2),
      ('second plain agent, receives the book transfer (agent2, S2.3)', v_agent2)) f(k, v)
  LOOP
    o := o || format(E'\n%s F fixture %s = %s', CASE WHEN r.v IS NULL THEN 'FAIL' ELSE 'INFO' END,
                     r.k, COALESCE(r.v::text, 'fixture missing'));
  END LOOP;
  o := o || format(E'\n%s F fixture houses h1..h8 = %s', CASE WHEN cardinality(v_h) = 8 THEN 'INFO' ELSE 'FAIL' END,
                   COALESCE((SELECT string_agg(x::text, ' ') FROM unnest(v_h) x), 'none'));
  SELECT count(DISTINCT u) INTO v_n FROM unnest(ARRAY[v_ceo, v_ops, v_agent, v_p20, v_pnew, v_signed, v_staff_a, v_staff_b, v_late]) u;
  o := o || format(E'\n%s F the 9 people are distinct: %s', CASE WHEN v_n = 9 THEN 'INFO' ELSE 'FAIL' END, v_n);
  IF v_p20 IS NOT NULL AND v_pnew IS NOT NULL THEN
    SELECT public.funder_float_available(v_p20), public.funder_float_available(v_pnew) INTO v_rate, v_rate2;
    o := o || format(E'\n%s F operational float available: p20=%s pnew=%s (need >= 500,000 each)',
                     CASE WHEN v_rate >= 500000 AND v_rate2 >= 500000 THEN 'INFO' ELSE 'FAIL' END, v_rate, v_rate2);
  END IF;
  IF v_ceo IS NULL OR v_ops IS NULL OR v_agent IS NULL OR v_p20 IS NULL OR v_pnew IS NULL OR v_signed IS NULL
     OR v_staff_a IS NULL OR v_staff_b IS NULL OR v_late_note IS NULL OR v_late IS NULL OR v_rule IS NULL
     OR cardinality(v_h) IS DISTINCT FROM 8 THEN
    o := o || E'\nFAIL F cannot continue: a fixture is missing';
    EXIT main;
  END IF;
  o := o || format(E'\nINFO T1 fixtures picked in %s ms', round(extract(epoch FROM clock_timestamp() - v_lap) * 1000));

  -- =====================================================================================
  -- S0. What the migrations left behind (switch still OFF, nothing else run yet)
  -- =====================================================================================
  SELECT count(DISTINCT p.proname) INTO v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = ANY (ARRAY['partner_rate_now', '_partner_commitment_follow_rate', 'partner_quote_rate',
                                'agent_create_promissory_notes_split', 'partner_note_linked_late',
                                'stamp_rent_facilitation_reward_rate']);
  o := o || format(E'\n%s S0.1 Phase 2 functions: %s/6', CASE WHEN v_n = 6 THEN 'PASS' ELSE 'FAIL' END, v_n);

  SELECT count(*) INTO v_n FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.column_name = 'return_rate' AND c.column_default IS NULL AND c.is_nullable = 'YES'
     AND c.table_name IN ('promissory_note_pledge_notices', 'promissory_house_booking_notices', 'funder_house_progress_notices');
  SELECT count(*) FILTER (WHERE a.atthasmissing) INTO v_m FROM pg_attribute a
   WHERE a.attname = 'return_rate' AND a.attrelid IN ('public.promissory_note_pledge_notices'::regclass,
           'public.promissory_house_booking_notices'::regclass, 'public.funder_house_progress_notices'::regclass);
  o := o || format(E'\n%s S0.2 notice return_rate columns (nullable, no default): %s/3, with a stored missing value: %s (want 0)',
                   CASE WHEN v_n = 3 AND v_m = 0 THEN 'PASS' ELSE 'FAIL' END, v_n, v_m);

  SELECT string_agg(c.relname || '.' || t.tgname || '(' || CASE WHEN t.tgtype & 1 = 1 THEN 'row' ELSE 'statement' END || ')', ', '
                    ORDER BY t.tgname), count(*)
    INTO v_t, v_n
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
     AND t.tgname IN ('trg_zz_partner_note_linked_late', 'trg_zz_stamp_rent_reward_rate_ins', 'trg_zz_stamp_rent_reward_rate_upd');
  o := o || format(E'\n%s S0.3 Phase 2 triggers enabled: %s (%s)',
                   CASE WHEN v_n = 3 AND v_t LIKE '%promissory_notes.trg_zz_partner_note_linked_late(statement)%' THEN 'PASS' ELSE 'FAIL' END, v_n, v_t);

  SELECT string_agg(p.proname || '(' || p.pronargs || ')', ', ' ORDER BY p.proname, p.pronargs) INTO v_t FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('agent_list_empty_house_opportunities', 'empty_house_opportunity_summary');
  o := o || format(E'\n%s S0.4 one overload each, new shapes: %s (want agent_list_empty_house_opportunities(14), empty_house_opportunity_summary(2))',
                   CASE WHEN v_t = 'agent_list_empty_house_opportunities(14), empty_house_opportunity_summary(2)' THEN 'PASS' ELSE 'FAIL' END, v_t);

  v_b := has_function_privilege('anon', 'public.partner_quote_rate(text,uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.partner_quote_rate(text,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.partner_rate_now(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.partner_rate_now(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public._partner_commitment_follow_rate(uuid,numeric)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.agent_create_promissory_notes_split(jsonb,uuid[])', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.agent_create_promissory_notes_split(jsonb,uuid[])', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.agent_list_empty_house_opportunities(text,integer,integer,text,boolean,boolean,numeric,numeric,double precision,double precision,double precision,text,text,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.agent_list_empty_house_opportunities(text,integer,integer,text,boolean,boolean,numeric,numeric,double precision,double precision,double precision,text,text,uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.empty_house_opportunity_summary(text,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.empty_house_opportunity_summary(text,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.partner_note_linked_late()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.stamp_rent_facilitation_reward_rate()', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'public.rent_facilitation_reward_rates', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.rent_facilitation_reward_rates', 'SELECT')
     AND has_table_privilege('service_role', 'public.rent_facilitation_reward_rates', 'SELECT')
     AND NOT has_table_privilege('service_role', 'public.rent_facilitation_reward_rates', 'INSERT')
     AND (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.rent_facilitation_reward_rates'::regclass)
     AND EXISTS (SELECT 1 FROM pg_policies pp WHERE pp.schemaname = 'public' AND pp.tablename = 'rent_facilitation_reward_rates'
                   AND pp.policyname = 'mfa_required_for_staff' AND pp.permissive = 'RESTRICTIVE');
  o := o || format(E'\n%s S0.5 grants: quotes open to anon+authenticated; rule, follow-up and trigger functions closed; split, listing, summary authenticated only; reward-rate table service_role read-only with RLS + staff-MFA policy',
                   CASE WHEN v_b THEN 'PASS' ELSE 'FAIL' END);

  SELECT p.enabled, p.cutoff_at, p.release_ready INTO v_b, v_cutoff, v_basis FROM public.partner_return_policy p WHERE p.id;
  SELECT count(*) INTO v_n FROM public.audit_logs al
   WHERE al.action_type = 'partner_return_policy_settings_changed' AND al.created_at >= now();
  -- Phase 2 no longer marks the release ready (the release migration, Phase 7, does): no settings change at all.
  o := o || format(E'\n%s S0.6 policy after Phase 2: enabled=%s cutoff=%s release_ready=%s; settings changes audited: %s row(s) (want 0)',
                   CASE WHEN NOT v_b AND v_cutoff IS NULL AND NOT v_basis::boolean AND v_n = 0 THEN 'PASS' ELSE 'FAIL' END,
                   v_b, COALESCE(v_cutoff::text, 'none'), v_basis, v_n);

  SELECT COALESCE(sum(s.n_tup_ins + s.n_tup_upd + s.n_tup_del), 0) INTO v_n FROM pg_stat_xact_all_tables s
   WHERE s.relid IN ('public.investor_portfolios'::regclass, 'public.promissory_notes'::regclass, 'public.rent_requests'::regclass,
                     'public.partner_self_commitments'::regclass, 'public.partner_supported_houses'::regclass);
  o := o || format(E'\n%s S0.7 the migrations wrote no portfolio, note, rent request, commitment or house row: %s row(s) touched',
                   CASE WHEN v_n = 0 THEN 'PASS' ELSE 'FAIL' END, v_n);

  SELECT count(*) INTO v_n FROM public.rent_facilitation_reward_rates;
  SELECT count(*) INTO v_m FROM public.rent_requests rr WHERE rr.supporter_id IS NOT NULL;
  SELECT format('%s supporter=%s rate=%s basis=%s decided_at=funded_at:%s', x.rent_request_id,
                x.supporter_id = rr.supporter_id, trim_scale(x.rate), x.basis, x.decided_at = rr.funded_at),
         x.rate = 15 AND x.basis = 'legacy' AND x.supporter_id = rr.supporter_id
    INTO v_t, v_b
    FROM public.rent_facilitation_reward_rates x JOIN public.rent_requests rr ON rr.id = x.rent_request_id
   WHERE x.rent_request_id = v_rr;
  o := o || format(E'\n%s S0.8 legacy rent facilitation backfill: %s stored rate(s) = %s rent request(s) with a supporter (1 expected today); %s',
                   CASE WHEN v_n = v_m AND v_m = 1 AND v_b THEN 'PASS' ELSE 'FAIL' END, v_n, v_m, COALESCE(v_t, 'row missing'));

  SELECT md5(string_agg(ip.id::text || ':' || ip.roi_percentage::text, ',' ORDER BY ip.id)), count(*)
    INTO v_hash_before, v_live_before FROM public.investor_portfolios ip WHERE ip.status IN ('active', 'locked');
  o := o || format(E'\nINFO S0.9 live portfolios at start: %s, md5(id:rate)=%s', v_live_before, v_hash_before);

  SELECT string_agg(f.k || '=' || (md5(p.prosrc) = f.want), ' ') , bool_and(md5(p.prosrc) = f.want) INTO v_t, v_b
    FROM (VALUES ('prod_get_supporter_pool_stats', '83d1dd5d7d6e60d67f847356a04f0911'),
                 ('prod_empty_house_opportunity_summary', '571ce3b9683037b07d835d3fd564556f'),
                 ('prod_agent_list_empty_house_opportunities', '624ccb2a82b30277baff53908dea6537'),
                 ('prod_partner_supported_house_returns', 'c0c98be644faa85c1b26492d5203673f')) f(k, want)
    LEFT JOIN pg_proc p ON p.proname = f.k AND p.pronamespace = pg_my_temp_schema();
  o := o || format(E'\n%s S0.10 today''s code copied exactly (md5 of the production bodies): %s', CASE WHEN v_b THEN 'PASS' ELSE 'FAIL' END, v_t);

  -- =====================================================================================
  -- S1. Switch OFF: every path must equal production today
  -- =====================================================================================
  v_lap := clock_timestamp();

  -- S1.1 Quotes
  v_t := concat_ws(' | ',
    'public(anon)=' || COALESCE(pg_temp.dr_call(NULL, 'SELECT to_jsonb(public.partner_quote_rate(''public'', NULL))', 'anon') ->> 'ok', 'ERR'),
    'me(anon)=' || COALESCE(pg_temp.dr_call(NULL, 'SELECT to_jsonb(public.partner_quote_rate(''me'', NULL))', 'anon') ->> 'error', 'NOT REFUSED'),
    'me(p20)=' || COALESCE(pg_temp.dr_call(v_p20, 'SELECT to_jsonb(public.partner_quote_rate(''me'', NULL))') ->> 'ok', 'ERR'),
    'partner(ops->p20)=' || COALESCE(pg_temp.dr_call(v_ops, format('SELECT to_jsonb(public.partner_quote_rate(''partner'', %L))', v_p20)) ->> 'ok', 'ERR'),
    'partner(agent->p20)=' || COALESCE(pg_temp.dr_call(v_agent, format('SELECT to_jsonb(public.partner_quote_rate(''partner'', %L))', v_p20)) ->> 'error', 'NOT REFUSED'),
    'bogus=' || COALESCE(pg_temp.dr_call(v_agent, 'SELECT to_jsonb(public.partner_quote_rate(''everyone'', NULL))') ->> 'error', 'NOT REFUSED'));
  o := o || format(E'\n%s S1.1 off quotes: %s', CASE WHEN v_t ~ '^public\(anon\)=15(\.00)? \| me\(anon\)=AUTH_REQUIRED.* \| me\(p20\)=15(\.00)? \| partner\(ops->p20\)=15(\.00)? \| partner\(agent->p20\)=NOT_AUTHORIZED.* \| bogus=INVALID_QUOTE_FOR.*$'
                                                   THEN 'PASS' ELSE 'FAIL' END, v_t);

  -- S1.2 House listing: today's code vs the new one, old call shape and new parameters (agent session)
  v_j := pg_temp.dr_call(v_agent, 'SELECT pg_temp.prod_agent_list_empty_house_opportunities()', 'owner');
  v_j2 := pg_temp.dr_call(v_agent, pg_temp.dr_list_sql());
  v_j3 := pg_temp.dr_call(v_agent, pg_temp.dr_list_sql(', p_quote_for => ''public'', p_partner_id => NULL'));
  o := o || format(E'\n%s S1.2 off listing parity (agent): total %s=%s, districts equal=%s, houses equal=%s (same order=%s, %s rows), returns_rate_pct=%s (want 15); new params p_quote_for=public: houses equal=%s, rate=%s%s%s%s',
    CASE WHEN v_j ? 'ok' AND v_j2 ? 'ok' AND v_j3 ? 'ok'
              AND (v_j -> 'ok' -> 'total') = (v_j2 -> 'ok' -> 'total')
              AND (v_j -> 'ok' -> 'districts') = (v_j2 -> 'ok' -> 'districts')
              AND pg_temp.dr_sorted(v_j -> 'ok' -> 'houses') = pg_temp.dr_sorted(v_j2 -> 'ok' -> 'houses')
              AND jsonb_array_length(v_j -> 'ok' -> 'houses') > 0
              AND (v_j2 -> 'ok' ->> 'returns_rate_pct')::numeric = 15
              AND pg_temp.dr_sorted(v_j3 -> 'ok' -> 'houses') = pg_temp.dr_sorted(v_j2 -> 'ok' -> 'houses')
              AND (v_j3 -> 'ok' ->> 'returns_rate_pct')::numeric = 15
         THEN 'PASS' ELSE 'FAIL' END,
    v_j -> 'ok' -> 'total', v_j2 -> 'ok' -> 'total', (v_j -> 'ok' -> 'districts') = (v_j2 -> 'ok' -> 'districts'),
    pg_temp.dr_sorted(v_j -> 'ok' -> 'houses') = pg_temp.dr_sorted(v_j2 -> 'ok' -> 'houses'),
    (v_j -> 'ok' -> 'houses') = (v_j2 -> 'ok' -> 'houses'), jsonb_array_length(v_j2 -> 'ok' -> 'houses'),
    v_j2 -> 'ok' ->> 'returns_rate_pct',
    pg_temp.dr_sorted(v_j3 -> 'ok' -> 'houses') = pg_temp.dr_sorted(v_j2 -> 'ok' -> 'houses'), v_j3 -> 'ok' ->> 'returns_rate_pct',
    pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2), pg_temp.dr_err(v_j3));

  -- S1.3 Empty-house summary: today's code vs the new one called the old way (no arguments)
  v_j := pg_temp.dr_call(v_agent, 'SELECT pg_temp.prod_empty_house_opportunity_summary()', 'owner');
  v_j2 := pg_temp.dr_call(v_agent, 'SELECT public.empty_house_opportunity_summary()');
  o := o || format(E'\n%s S1.3 off summary parity: identical apart from returns_rate_pct=%s; houses=%s, if all funded/month=%s vs today %s%s%s',
    CASE WHEN v_j ? 'ok' AND v_j2 ? 'ok' AND ((v_j2 -> 'ok') - 'returns_rate_pct') = (v_j -> 'ok')
              AND (v_j2 -> 'ok' ->> 'returns_rate_pct')::numeric = 15 THEN 'PASS' ELSE 'FAIL' END,
    v_j2 -> 'ok' ->> 'returns_rate_pct', v_j2 -> 'ok' ->> 'house_count', v_j2 -> 'ok' ->> 'monthly_return_if_all_funded',
    v_j -> 'ok' ->> 'monthly_return_if_all_funded', pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));

  -- S1.4 Supporter pool card: today's code vs the new one (staff session)
  v_j := pg_temp.dr_call(v_ops, 'SELECT pg_temp.prod_get_supporter_pool_stats()::jsonb', 'owner');
  v_j2 := pg_temp.dr_call(v_ops, 'SELECT public.get_supporter_pool_stats()::jsonb');
  o := o || format(E'\n%s S1.4 off get_supporter_pool_stats identical to today: %s (today %s; obligationRatePct=%s)%s%s',
    CASE WHEN v_j ? 'ok' AND v_j2 ? 'ok' AND ((v_j2 -> 'ok') - 'obligationRatePct') = (v_j -> 'ok')
              AND (v_j2 -> 'ok' ->> 'obligationRatePct')::numeric = 15 THEN 'PASS' ELSE 'FAIL' END,
    (v_j2 -> 'ok') - 'obligationRatePct', v_j -> 'ok', v_j2 -> 'ok' ->> 'obligationRatePct', pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));

  -- S1.5 funder_create_pending_portfolio (p20's own session)
  v_j := pg_temp.dr_call(v_p20, 'SELECT public.funder_create_pending_portfolio(50000::numeric, NULL::uuid, 12)');
  v_pid := (v_j -> 'ok' ->> 'portfolio_id')::uuid;
  v_t := pg_temp.dr_pf(v_pid);
  o := o || format(E'\n%s S1.5 off funder_create_pending_portfolio(p20): %s, result roi=%s (want 15/15/switch_off/req=0, 15)%s',
                   CASE WHEN v_t = '15/15/switch_off/req=0' AND (v_j -> 'ok' ->> 'roi_percentage')::numeric = 15 THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_j -> 'ok' ->> 'roi_percentage', pg_temp.dr_err(v_j));

  -- S1.6 create_pending_portfolio (Partner Ops session): untyped and typed 20
  v_j := pg_temp.dr_call(v_ops, format('SELECT to_jsonb(x) FROM public.create_pending_portfolio(%L::uuid, 100000::numeric, 12, NULL::numeric, %L, %L, %L) x',
                                       v_p20, 'monthly_payout', 'DRYRUN P2 untyped', repeat('a', 40)));
  v_t := pg_temp.dr_pf((v_j -> 'ok' ->> 'portfolio_id')::uuid);
  v_j2 := pg_temp.dr_call(v_ops, format('SELECT to_jsonb(x) FROM public.create_pending_portfolio(%L::uuid, 100000::numeric, 12, 20::numeric, %L, %L, %L) x',
                                        v_p20, 'monthly_payout', 'DRYRUN P2 typed', repeat('b', 40)));
  v_t2 := pg_temp.dr_pf((v_j2 -> 'ok' ->> 'portfolio_id')::uuid);
  o := o || format(E'\n%s S1.6 off create_pending_portfolio(p20): untyped %s (want 15/15/switch_off/req=0), typed 20 %s (want 20/20/typed_switch_off/req=0)%s%s',
                   CASE WHEN v_t = '15/15/switch_off/req=0' AND v_t2 = '20/20/typed_switch_off/req=0' THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_t2, pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));

  -- S1.7 partner_support_houses (pnew's own session, 4-argument call as the screens make it) on h1
  v_j := pg_temp.dr_call(v_pnew, format('SELECT public.partner_support_houses(p_house_ids => ARRAY[%L]::uuid[], p_term_months => 12, p_idempotency_key => NULL, p_commitment_id => NULL)', v_h[1]));
  DROP TABLE IF EXISTS pg_temp._psh_pick;          -- ON COMMIT DROP table of the previous call
  v_pid := (v_j -> 'ok' ->> 'portfolio_id')::uuid; v_cid := (v_j -> 'ok' ->> 'commitment_id')::uuid;
  v_t := pg_temp.dr_pf(v_pid); v_t2 := pg_temp.dr_commit(v_cid);
  o := o || format(E'\n%s S1.7 off partner_support_houses(pnew, h1): portfolio %s; %s; result roi=%s monthly_return=%s of %s (want 15/15/switch_off/req=0; all 15, notice amounts right)%s',
                   CASE WHEN v_t = '15/15/switch_off/req=0' AND v_t2 = 'commitment=15 houses=15 notices=15 notice_returns_ok=true'
                             AND (v_j -> 'ok' ->> 'roi_percentage')::numeric = 15
                             AND (v_j -> 'ok' ->> 'monthly_return')::numeric = round((v_j -> 'ok' ->> 'committed_amount')::numeric * 15 / 100)
                        THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_t2, v_j -> 'ok' ->> 'roi_percentage', v_j -> 'ok' ->> 'monthly_return', v_j -> 'ok' ->> 'committed_amount',
                   pg_temp.dr_err(v_j));

  -- S1.8 get_countersign_summary (Partner Ops session)
  v_j := pg_temp.dr_call(v_ops, format('SELECT public.get_countersign_summary(%L::uuid, 1000000::numeric)', v_p20));
  o := o || format(E'\n%s S1.8 off get_countersign_summary(p20): roi_percentage=%s (want 15)%s',
                   CASE WHEN (v_j -> 'ok' ->> 'roi_percentage')::numeric = 15 THEN 'PASS' ELSE 'FAIL' END,
                   v_j -> 'ok' ->> 'roi_percentage', pg_temp.dr_err(v_j));

  -- S1.9 Payroll reinvestment (backend call, as the payroll job makes it) on a fabricated payslip for staff A.
  INSERT INTO public.hr_pay_periods (code, period_month, cut_off_date, pay_date, status)
  VALUES ('DRYRUN-P2-' || txid_current(), date_trunc('month', now())::date, current_date, current_date, 'closed')
  RETURNING id INTO v_period;
  INSERT INTO public.hr_pay_runs (period_id, rule_version_id, status) VALUES (v_period, v_rule, 'approved') RETURNING id INTO v_run;
  INSERT INTO public.hr_pay_payslips (run_id, staff_id, gross, chargeable_income, paye, nssf_employee, nssf_employer, net,
                                      employer_cost, rule_version_id, rule_status_at_run, inputs_snapshot, calculation_trace)
  VALUES (v_run, v_staff_a_id, 0, 0, 0, 0, 0, 0, 0, v_rule, 'provisional',
          '{"reinvestment": {"percentage": 10, "payout_mode": "monthly_payout"}}', '{"dryrun": true}')
  RETURNING id INTO v_slip_a;
  INSERT INTO public.hr_pay_payslips (run_id, staff_id, gross, chargeable_income, paye, nssf_employee, nssf_employer, net,
                                      employer_cost, rule_version_id, rule_status_at_run, inputs_snapshot, calculation_trace)
  VALUES (v_run, v_staff_b_id, 0, 0, 0, 0, 0, 0, 0, v_rule, 'provisional',
          '{"reinvestment": {"percentage": 10, "payout_mode": "monthly_payout"}}', '{"dryrun": true}')
  RETURNING id INTO v_slip_b;
  INSERT INTO public.hr_pay_payslip_lines (payslip_id, component_code, name, kind, amount)
  VALUES (v_slip_a, 'REINVEST', 'Salary reinvestment (dry run)', 'deduction', 100000),
         (v_slip_b, 'REINVEST', 'Salary reinvestment (dry run)', 'deduction', 100000);

  v_j := pg_temp.dr_call(NULL, format('SELECT public.hr_pay_post_staff_reinvestment(%L::uuid)', v_slip_a), 'owner');
  v_pid := (v_j -> 'ok' ->> 'portfolio_id')::uuid;
  v_t := pg_temp.dr_pf(v_pid);
  v_t2 := COALESCE(current_setting('app.partner_rate_context', true), '');
  o := o || format(E'\n%s S1.9 off payroll reinvestment (staff A): %s/%s, portfolio %s, result roi=%s, context after="%s" (want posted/portfolio_created, 20/20/typed_switch_off/req=0, 20, "")%s',
                   CASE WHEN v_j -> 'ok' ->> 'status' = 'posted' AND v_j -> 'ok' ->> 'kind' = 'portfolio_created'
                             AND v_t = '20/20/typed_switch_off/req=0' AND (v_j -> 'ok' ->> 'roi_percentage')::numeric = 20
                             AND v_t2 = '' THEN 'PASS' ELSE 'FAIL' END,
                   v_j -> 'ok' ->> 'status', v_j -> 'ok' ->> 'kind', v_t, v_j -> 'ok' ->> 'roi_percentage', v_t2, pg_temp.dr_err(v_j));

  -- S1.10 Split promissory booking (agent session): one pending note per house, h4 and h5
  v_payload := jsonb_build_object('partner_name', 'DRYRUN Split Partner', 'whatsapp_number', c_phone, 'contribution_type', 'once_off');
  v_j := pg_temp.dr_call(v_agent, format('SELECT public.agent_create_promissory_notes_split(%L::jsonb, ARRAY[%L, %L]::uuid[])',
                                         v_payload, v_h[4], v_h[5]));
  v_ids := ARRAY(SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(v_j -> 'ok' -> 'note_ids') x);
  v_t := pg_temp.dr_notes(v_ids);
  SELECT bool_and((e ->> 'monthly_return')::numeric = round((e -> 'note' ->> 'amount')::numeric * 15 / 100)
                  AND (e -> 'note' ->> 'amount')::numeric = (SELECT h.monthly_rent FROM public.house_listings h WHERE h.id = (e ->> 'house_id')::uuid))
    INTO v_b FROM jsonb_array_elements(v_j -> 'ok' -> 'notes') e;
  o := o || format(E'\n%s S1.10 off split notes (agent, h4+h5): %s; each note = its house rent, monthly_return at 15: %s (want n=2 status=pending rate=15/legacy linked=0 pledge=2:15 booking=2:15 pledge_amounts_ok=true ledger_rows=0)%s',
                   CASE WHEN v_t = 'n=2 status=pending rate=15/legacy linked=0 pledge=2:15 booking=2:15 pledge_amounts_ok=true ledger_rows=0'
                             AND v_b AND (v_j -> 'ok' ->> 'house_count')::int = 2 THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_b, pg_temp.dr_err(v_j));

  -- S1.11 Share link (agent session) quotes the public rate: 15 today
  SELECT h.monthly_rent INTO v_amt FROM public.house_listings h WHERE h.id = v_h[8];
  v_j := pg_temp.dr_call(v_agent, format('SELECT to_jsonb(x) FROM public.get_or_create_house_share_link(%L::uuid) x', v_h[8]));
  v_t := 'receive UGX ' || to_char(round(v_amt * 15 / 100), 'FM999,999,999') || ' every month';
  o := o || format(E'\n%s S1.11 off house share link: quotes "%s"=%s%s',
                   CASE WHEN position(v_t IN COALESCE(v_j -> 'ok' ->> 'og_description', '')) > 0 THEN 'PASS' ELSE 'FAIL' END,
                   v_t, position(v_t IN COALESCE(v_j -> 'ok' ->> 'og_description', '')) > 0, pg_temp.dr_err(v_j));

  SELECT count(*) INTO v_n FROM public.portfolio_rate_approvals;
  o := o || format(E'\n%s S1.12 off: CFO requests=%s (want 0)', CASE WHEN v_n = 0 THEN 'PASS' ELSE 'FAIL' END, v_n);

  -- S1.13 Rates come out without trailing zeros (15, not 15.00): the browser quote and the rule functions.
  v_t := concat_ws(' ',
    'quote(public,anon)=' || COALESCE(pg_temp.dr_call(NULL, 'SELECT to_jsonb(public.partner_quote_rate(''public'', NULL))', 'anon') ->> 'ok', 'ERR'),
    'quote(me,p20)=' || COALESCE(pg_temp.dr_call(v_p20, 'SELECT to_jsonb(public.partner_quote_rate(''me'', NULL))') ->> 'ok', 'ERR'),
    'new_contract=' || COALESCE(pg_temp.dr_call(NULL, 'SELECT to_jsonb(public.partner_new_contract_rate())', 'owner') ->> 'ok', 'ERR'),
    'rates_for(p20,pnew)=' || COALESCE(pg_temp.dr_call(NULL, format('SELECT jsonb_agg(x.rate ORDER BY array_position(ARRAY[%L, %L]::uuid[], x.partner_id)) FROM public.partner_rates_for(ARRAY[%L, %L]::uuid[]) x', v_p20, v_pnew, v_p20, v_pnew), 'owner') ->> 'ok', 'ERR'),
    'note_rate_for(pnew)=' || COALESCE(pg_temp.dr_call(NULL, format('SELECT jsonb_agg(x.rate) FROM public.partner_note_rate_for(%L::uuid) x', v_pnew), 'owner') ->> 'ok', 'ERR'));
  o := o || format(E'\n%s S1.13 off rates have no trailing zeros: %s (want every value 15, none 15.00)',
                   CASE WHEN v_t = 'quote(public,anon)=15 quote(me,p20)=15 new_contract=15 rates_for(p20,pnew)=[15, 15] note_rate_for(pnew)=[15]'
                        THEN 'PASS' ELSE 'FAIL' END, v_t);

  -- S1.14 partner_supported_house_returns (the partner's booked-house list): with the switch off it equals
  --       today's code apart from the new 'return_rate' key, which says 15. The two OFF split notes (h4, h5) are
  --       linked to the 'late' person inside a savepoint that is undone straight after, so no later section sees it.
  v_t := NULL; v_n := NULL; v_b := NULL; v_b2 := NULL; v_err := NULL; v_j := NULL; v_j2 := NULL;
  BEGIN
    UPDATE public.promissory_notes SET partner_user_id = v_late WHERE id = ANY (v_ids);
    v_j := pg_temp.dr_call(v_late, 'SELECT pg_temp.prod_partner_supported_house_returns()', 'owner');
    v_j2 := pg_temp.dr_call(v_late, 'SELECT public.partner_supported_house_returns()');
    v_b := (v_j2 -> 'ok' -> 'houses') IS NOT NULL AND (v_j -> 'ok' -> 'houses') IS NOT NULL
           AND (SELECT COALESCE(jsonb_agg(e - 'return_rate' ORDER BY e ->> 'intent_id'), '[]'::jsonb) FROM jsonb_array_elements(v_j2 -> 'ok' -> 'houses') e)
             = (SELECT COALESCE(jsonb_agg(e ORDER BY e ->> 'intent_id'), '[]'::jsonb) FROM jsonb_array_elements(v_j -> 'ok' -> 'houses') e)
           AND ((v_j2 -> 'ok') - 'houses') = ((v_j -> 'ok') - 'houses');
    SELECT string_agg(DISTINCT (e -> 'return_rate')::text, ','), count(*),
           bool_and((e ->> 'monthly_return')::numeric = round((e ->> 'monthly_rent')::numeric * 15 / 100)
                    AND (e ->> 'annual_return')::numeric = round((e ->> 'monthly_rent')::numeric * 15 / 100 * 12))
      INTO v_t, v_n, v_b2
      FROM jsonb_array_elements(v_j2 -> 'ok' -> 'houses') e WHERE (e ->> 'note_id')::uuid = ANY (v_ids);
    RAISE EXCEPTION 'DR_UNDO';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'DR_UNDO' THEN v_err := SQLERRM; END IF;
  END;
  SELECT count(*) INTO v_m FROM public.promissory_notes n WHERE n.id = ANY (v_ids) AND n.partner_user_id IS NOT NULL;
  -- (round 3) ::text: format('%s', boolean) prints t/f, the cast prints true/false.
  v_t2 := format('grants anon=%s authenticated=%s',
                 has_function_privilege('anon', 'public.partner_supported_house_returns()', 'EXECUTE')::text,
                 has_function_privilege('authenticated', 'public.partner_supported_house_returns()', 'EXECUTE')::text);
  o := o || format(E'\n%s S1.14 off partner_supported_house_returns (late person, h4+h5 linked inside an undone savepoint): same as today''s code apart from return_rate=%s; DRYRUN houses=%s return_rate=%s, monthly/annual at 15=%s; total_monthly_return new=%s today=%s; link undone (linked now=%s); %s (want true, 2, 15, true, 0, anon=false authenticated=true)%s%s%s',
                   CASE WHEN v_err IS NULL AND v_b AND v_n = 2 AND v_t = '15' AND v_b2 AND v_m = 0
                             AND v_t2 = 'grants anon=false authenticated=true' THEN 'PASS' ELSE 'FAIL' END,
                   v_b, v_n, v_t, v_b2, v_j2 -> 'ok' ->> 'total_monthly_return', v_j -> 'ok' ->> 'total_monthly_return', v_m, v_t2,
                   CASE WHEN v_err IS NOT NULL THEN ' ERROR: ' || left(v_err, 300) ELSE '' END, pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));
  -- (round 3) S1.15 get_supporter_pool_stats sends obligationRatePct without trailing zeros (15, not 15.00).
  v_j := pg_temp.dr_call(v_ops, 'SELECT public.get_supporter_pool_stats()::jsonb');
  o := o || format(E'\n%s S1.15 off get_supporter_pool_stats obligationRatePct as the screen receives it: %s (want 15)%s',
                   CASE WHEN (v_j -> 'ok' -> 'obligationRatePct')::text = '15' THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE((v_j -> 'ok' -> 'obligationRatePct')::text, 'missing'), pg_temp.dr_err(v_j));
  -- (round 5) S1.16 Before the switch-on, the OFF split note on h5 is linked to p20 (owner-side update; unlinked again
  --       in S2.5), so the switch-on snapshot freezes a DRYRUN pre-cut-off note linked to p20 (used by S2.2-S2.4).
  --       Linking before the cut-off opens no CFO request.
  PERFORM pg_temp.dr_as(NULL);
  UPDATE public.promissory_notes SET partner_user_id = v_p20 WHERE id = v_ids[2];
  SELECT count(*) INTO v_n FROM public.promissory_notes n WHERE n.id = v_ids[2] AND n.partner_user_id = v_p20;
  SELECT count(*) INTO v_m FROM public.portfolio_rate_approvals;
  o := o || format(E'\n%s S1.16 off: the DRYRUN h5 note linked to p20 before the switch-on (owner side): linked=%s; CFO requests=%s (want 1, 0)',
                   CASE WHEN v_n = 1 AND v_m = 0 THEN 'PASS' ELSE 'FAIL' END, v_n, v_m);
  o := o || format(E'\nINFO T2 switch-off section took %s ms', round(extract(epoch FROM clock_timestamp() - v_lap) * 1000));

  -- =====================================================================================
  -- S2. The CEO turns Partner Returns ON (the CEO's own browser session, MFA claims)
  -- =====================================================================================
  v_lap := clock_timestamp();
  -- S2.0 Phase 2 alone is not the release: the CEO is refused until release_ready is set.
  v_j := pg_temp.dr_call(v_ceo, 'SELECT public.set_partner_return_policy(true, NULL, ''DRYRUN_P2 rehearsal'')', 'authenticated', 'aal2');
  SELECT p.enabled INTO v_b FROM public.partner_return_policy p WHERE p.id;
  o := o || format(E'\n%s S2.0 CEO switch-on before the release is marked ready: refused (%s), enabled=%s',
                   CASE WHEN NOT (v_j ? 'ok') AND pg_temp.dr_err(v_j) ILIKE '%release%is not complete%' AND NOT v_b THEN 'PASS' ELSE 'FAIL' END,
                   left(pg_temp.dr_err(v_j), 160), v_b);
  -- Rehearsal only: mark the release ready from the owner session, as the release migration (Phase 7) will
  -- (audited; the email is queued and rolled back with everything else).
  UPDATE public.partner_return_policy SET release_ready = true WHERE id;
  v_j := pg_temp.dr_call(v_ceo, 'SELECT public.set_partner_return_policy(true, NULL, ''DRYRUN_P2 rehearsal'')', 'authenticated', 'aal2');
  SELECT p.enabled, p.cutoff_at INTO v_b, v_cutoff FROM public.partner_return_policy p WHERE p.id;
  SELECT count(*) INTO v_n FROM public.partner_return_note_windows;
  SELECT count(*) INTO v_m FROM public.partner_return_cohort;
  o := o || format(E'\n%s S2.1 CEO switch-on: enabled=%s changed=%s cutoff=%s; existing partners=%s, note windows=%s (%s ms)%s',
                   CASE WHEN v_j ? 'ok' AND v_b AND (v_j -> 'ok' ->> 'changed')::boolean AND v_cutoff IS NOT NULL
                             AND v_n > 0 AND v_m > 0 THEN 'PASS' ELSE 'FAIL' END,
                   v_b, v_j -> 'ok' ->> 'changed', v_cutoff, v_m, v_n,
                   round(extract(epoch FROM clock_timestamp() - v_lap) * 1000), pg_temp.dr_err(v_j));
  IF NOT COALESCE(v_b, false) THEN
    o := o || E'\nFAIL S2 cannot continue: the switch is not on';
    EXIT main;
  END IF;

  -- (round 5) S2.2 The switch-on snapshot froze who each note window is for: every window row carries the note's
  --       partner_user_id and agent_id as they stood at the cut-off (the notes are unchanged since: this transaction
  --       holds ACCESS EXCLUSIVE on promissory_notes), one window per open note, all at the cut-off. Counts only (linked /
  --       unlinked / linked to their own author / without an agent), and true/false for the two DRYRUN windows.
  v_t := NULL; v_b4 := NULL; v_b5 := NULL; v_err := NULL;
  v_n := NULL; v_m := NULL; v_k := NULL; v_k2 := NULL; v_l0 := NULL; v_l1 := NULL; v_l2 := NULL; v_l3 := NULL; v_l4 := NULL;
  SELECT p.cutoff_at INTO v_cutoff FROM public.partner_return_policy p WHERE p.id;
  SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END,
                    ', ' ORDER BY a.attname)
    INTO v_t FROM pg_attribute a
   WHERE a.attrelid = 'public.partner_return_note_windows'::regclass AND a.attname IN ('partner_user_id', 'agent_id')
     AND a.attnum > 0 AND NOT a.attisdropped;
  BEGIN   -- a sub-block, so a missing column is reported here and the later checks still run
  SELECT count(*), count(n.id),
         count(*) FILTER (WHERE n.id IS NOT NULL AND w.partner_user_id IS NOT DISTINCT FROM n.partner_user_id
                            AND w.agent_id IS NOT DISTINCT FROM n.agent_id),
         count(*) FILTER (WHERE w.snapshot_at = v_cutoff),
         count(*) FILTER (WHERE w.partner_user_id IS NOT NULL),
         count(*) FILTER (WHERE w.partner_user_id IS NULL),
         count(*) FILTER (WHERE w.partner_user_id = w.agent_id),
         count(*) FILTER (WHERE w.agent_id IS NULL)
    INTO v_n, v_m, v_k, v_k2, v_l0, v_l1, v_l2, v_l3
    FROM public.partner_return_note_windows w LEFT JOIN public.promissory_notes n ON n.id = w.note_id;
  SELECT count(*) INTO v_l4 FROM public.promissory_notes n WHERE n.status IN ('pending', 'activated', 'fulfilled');
  SELECT (SELECT w.partner_user_id = v_p20 AND w.agent_id = v_agent AND w.return_rate = 15
            FROM public.partner_return_note_windows w WHERE w.note_id = v_ids[2]),
         (SELECT w.partner_user_id IS NULL AND w.agent_id = v_agent AND w.return_rate = 15
            FROM public.partner_return_note_windows w WHERE w.note_id = v_ids[1])
    INTO v_b4, v_b5;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  o := o || format(E'\n%s S2.2 switch-on snapshot, who each window is for: columns [%s]; windows=%s, open notes=%s, with their note=%s, person and agent equal to the note''s=%s, at the cut-off=%s; linked=%s unlinked=%s linked to their own author=%s without an agent=%s; DRYRUN h5 window (p20, the agent, 15)=%s, h4 window (nobody, the agent, 15)=%s (want agent_id uuid, partner_user_id uuid; windows = open notes = with note = equal = at the cut-off = linked + unlinked; true, true)%s',
                   CASE WHEN v_err IS NULL AND v_t = 'agent_id uuid, partner_user_id uuid' AND v_n > 0 AND v_n = v_l4 AND v_m = v_n AND v_k = v_n
                             AND v_k2 = v_n AND v_l0 + v_l1 = v_n AND v_l0 >= 1 AND v_l1 >= 1
                             AND COALESCE(v_b4, false) AND COALESCE(v_b5, false)
                        THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_t, 'missing'), v_n, v_l4, v_m, v_k, v_k2, v_l0, v_l1, v_l2, v_l3,
                   COALESCE(v_b4::text, 'missing'), COALESCE(v_b5::text, 'missing'),
                   CASE WHEN v_err IS NOT NULL THEN ' ERROR: ' || left(v_err, 300) ELSE '' END);

  -- (round 5; round 6) S2.3 A window counts only for whom it is for. Owner-side moves of DRYRUN notes, each inside a
  --       savepoint undone straight after. (a) The h5 note, linked to p20 at the cut-off, is moved to late2 just after a
  --       DRYRUN portfolio was opened for late2 at 10: late2 stays 10/new, no catch-up is queued, p20 keeps 20, the note
  --       keeps 15/legacy. (b) The h4 note, unlinked at the cut-off and written by the agent, is linked to the agent: the
  --       agent stays 10/new; moved on to late2 it gives late2 15/promissory_note (control: it counts for anyone else).
  --       (c) (round 6) A book transfer: partner_ops_transfer_proxy_book moves an agent's notes to another agent with
  --       UPDATE promissory_notes SET agent_id = <to>, updated_at = now(). The h4 note (unlinked at the cut-off) is moved
  --       that way to agent2, who has just opened a DRYRUN portfolio at 10, then linked to agent2 by the owner: agent2
  --       stays 10/new and gets no catch-up request (partner_rates_for and the late link both pass the note's agent
  --       now); linked on to late2 it still gives late2 15/promissory_note.
  v_t := NULL; v_t2 := NULL; v_t3 := NULL; v_t4 := NULL; v_t5 := NULL; v_t6 := NULL; v_err := NULL; v_pid := NULL;
  v_n := NULL; v_m := NULL; v_t7 := NULL; v_t8 := NULL; v_t9 := NULL; v_pid2 := NULL;
  IF v_late2 IS NULL THEN
    v_err := 'fixture late2 is missing';
  ELSE
    BEGIN
      v_pid := gen_random_uuid();
      INSERT INTO public.investor_portfolios (id, investor_id, agent_id, portfolio_code, portfolio_pin,
                                              duration_months, investment_amount, status)
      VALUES (v_pid, v_late2, v_late2, 'DRYRUN-' || left(v_pid::text, 13), c_pin, 12, 100000, 'pending_ops_approval');
      PERFORM pg_temp.dr_as(NULL);
      UPDATE public.promissory_notes SET partner_user_id = v_late2 WHERE id = v_ids[2];
      SELECT trim_scale(x.rate)::text || '/' || x.basis INTO v_t FROM public.partner_rate_for(v_late2) x;
      v_t2 := pg_temp.dr_pf(v_pid) || ' ' || pg_temp.dr_req(v_pid);
      SELECT trim_scale(x.rate)::text || '/' || x.basis INTO v_t3 FROM public.partner_rate_for(v_p20) x;
      SELECT trim_scale(n.return_rate)::text || '/' || n.return_rate_basis INTO v_t6 FROM public.promissory_notes n WHERE n.id = v_ids[2];
      RAISE EXCEPTION 'DR_UNDO';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'DR_UNDO' THEN v_err := SQLERRM; END IF;
    END;
    BEGIN
      PERFORM pg_temp.dr_as(NULL);
      UPDATE public.promissory_notes SET partner_user_id = v_agent WHERE id = v_ids[1];
      SELECT trim_scale(x.rate)::text || '/' || x.basis INTO v_t4 FROM public.partner_rate_for(v_agent) x;
      UPDATE public.promissory_notes SET partner_user_id = v_late2 WHERE id = v_ids[1];
      SELECT trim_scale(x.rate)::text || '/' || x.basis INTO v_t5 FROM public.partner_rate_for(v_late2) x;
      RAISE EXCEPTION 'DR_UNDO';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'DR_UNDO' THEN v_err := concat_ws('; ', v_err, SQLERRM); END IF;
    END;
    -- (round 6) (c) the book transfer
    IF v_agent2 IS NULL THEN
      v_err := concat_ws('; ', v_err, 'fixture agent2 is missing');
    ELSE
      BEGIN
        PERFORM pg_temp.dr_as(NULL);
        SELECT trim_scale(x.rate)::text || '/' || x.basis INTO v_t7 FROM public.partner_rate_for(v_agent2) x;
        v_pid2 := gen_random_uuid();
        INSERT INTO public.investor_portfolios (id, investor_id, agent_id, portfolio_code, portfolio_pin,
                                                duration_months, investment_amount, status)
        VALUES (v_pid2, v_agent2, v_agent2, 'DRYRUN-' || left(v_pid2::text, 13), c_pin, 12, 100000, 'pending_ops_approval');
        PERFORM pg_temp.dr_as(NULL);
        UPDATE public.promissory_notes SET agent_id = v_agent2, updated_at = now() WHERE id = v_ids[1];   -- the transfer's statement
        UPDATE public.promissory_notes SET partner_user_id = v_agent2 WHERE id = v_ids[1];                -- linked to the receiving agent
        SELECT trim_scale(x.rate)::text || '/' || x.basis || ' ' || pg_temp.dr_pf(v_pid2) || ' ' || pg_temp.dr_req(v_pid2)
          INTO v_t8 FROM public.partner_rate_for(v_agent2) x;
        UPDATE public.promissory_notes SET partner_user_id = v_late2 WHERE id = v_ids[1];
        SELECT trim_scale(x.rate)::text || '/' || x.basis INTO v_t9 FROM public.partner_rate_for(v_late2) x;
        RAISE EXCEPTION 'DR_UNDO';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'DR_UNDO' THEN v_err := concat_ws('; ', v_err, SQLERRM); END IF;
      END;
    END IF;
  END IF;
  SELECT count(*) FILTER (WHERE n.id = v_ids[2] AND n.partner_user_id = v_p20)
         + count(*) FILTER (WHERE n.id = v_ids[1] AND n.partner_user_id IS NULL AND n.agent_id = v_agent)
    INTO v_n FROM public.promissory_notes n WHERE n.id IN (v_ids[1], v_ids[2]);
  SELECT count(*) INTO v_m FROM public.investor_portfolios ip WHERE ip.id IN (v_pid, v_pid2);
  o := o || format(E'\n%s S2.3 a window counts only for whom it is for (owner-side moves, undone): h5 note (p20 at the cut-off) moved to late2: late2 %s, DRYRUN portfolio %s (want 10/new, 10/10/new/req=0 none), p20 %s (want 20/existing_partner), note %s (want 15/legacy); h4 note (nobody at the cut-off, written by the agent) linked to the agent: agent %s (want 10/new), then moved to late2: late2 %s (want 15/promissory_note); (round 6) book transfer of the h4 note to agent2 (agent2 before: %s, want 10/new), then linked to agent2: agent2, their DRYRUN portfolio and its requests %s (want 10/new 10/10/new/req=0 none), then moved to late2: late2 %s (want 15/promissory_note); undone: notes as before=%s (want 2), DRYRUN portfolio rows=%s (want 0)%s',
                   CASE WHEN v_err IS NULL AND v_t = '10/new' AND v_t2 = '10/10/new/req=0 none' AND v_t3 = '20/existing_partner'
                             AND v_t6 = '15/legacy' AND v_t4 = '10/new' AND v_t5 = '15/promissory_note'
                             AND v_t7 = '10/new' AND v_t8 = '10/new 10/10/new/req=0 none' AND v_t9 = '15/promissory_note'
                             AND v_n = 2 AND v_m = 0
                        THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_t, 'missing'), COALESCE(v_t2, 'missing'), COALESCE(v_t3, 'missing'), COALESCE(v_t6, 'missing'),
                   COALESCE(v_t4, 'missing'), COALESCE(v_t5, 'missing'), COALESCE(v_t7, 'missing'), COALESCE(v_t8, 'missing'),
                   COALESCE(v_t9, 'missing'), v_n, v_m,
                   CASE WHEN v_err IS NOT NULL THEN ' ERROR: ' || left(v_err, 300) ELSE '' END);

  -- (round 5) S2.4 Edge functions (service_role) are held to the note guard too. As service_role (SET LOCAL ROLE, each
  --       inside a savepoint undone straight after): moving the DRYRUN h5 note (linked to p20) to pnew, changing its
  --       rate, and linking the unlinked DRYRUN h4 note to pnew after the cut-off are each refused with 42501 and the
  --       guard's own message. The role is back afterwards and the notes are unchanged.
  v_t := NULL; v_t2 := NULL; v_t3 := NULL; v_n := NULL; v_who_was := current_user::text;
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SET LOCAL ROLE service_role;
    UPDATE public.promissory_notes SET partner_user_id = v_pnew WHERE id = v_ids[2];
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_t := 'not refused (rows ' || v_n || ')';
    RAISE EXCEPTION 'DR_UNDO';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'DR_UNDO' THEN v_t := SQLSTATE || ' ' || SQLERRM; END IF;
  END;
  RESET ROLE;
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SET LOCAL ROLE service_role;
    UPDATE public.promissory_notes SET return_rate = return_rate + 5 WHERE id = v_ids[2];
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_t2 := 'not refused (rows ' || v_n || ')';
    RAISE EXCEPTION 'DR_UNDO';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'DR_UNDO' THEN v_t2 := SQLSTATE || ' ' || SQLERRM; END IF;
  END;
  RESET ROLE;
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SET LOCAL ROLE service_role;
    UPDATE public.promissory_notes SET partner_user_id = v_pnew WHERE id = v_ids[1];
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_t3 := 'not refused (rows ' || v_n || ')';
    RAISE EXCEPTION 'DR_UNDO';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'DR_UNDO' THEN v_t3 := SQLSTATE || ' ' || SQLERRM; END IF;
  END;
  RESET ROLE;
  PERFORM pg_temp.dr_as(NULL);
  v_b := current_user::text = v_who_was;
  SELECT count(*) FILTER (WHERE n.id = v_ids[2] AND n.partner_user_id = v_p20 AND n.return_rate = 15)
         + count(*) FILTER (WHERE n.id = v_ids[1] AND n.partner_user_id IS NULL AND n.return_rate = 15)
    INTO v_n FROM public.promissory_notes n WHERE n.id IN (v_ids[1], v_ids[2]);
  o := o || format(E'\n%s S2.4 as service_role (an edge function), undone: move the h5 note (p20) to pnew -> %s; change its rate -> %s; link the unlinked h4 note to pnew after the cut-off -> %s (want each 42501 with the guard''s message: cannot be moved / rate is fixed / not directly); role back=%s; notes unchanged=%s (want true, 2)',
                   CASE WHEN v_t LIKE '42501 A promissory note cannot be moved to another partner%'
                             AND v_t2 LIKE '42501 %Returns rate is fixed when the note is written%'
                             AND v_t3 LIKE '42501 Link a promissory note to a partner through the partner-linking tools, not directly%'
                             AND v_b AND v_n = 2
                        THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(left(v_t, 160), 'nothing'), COALESCE(left(v_t2, 160), 'nothing'), COALESCE(left(v_t3, 160), 'nothing'),
                   v_b, v_n);

  -- (round 5) S2.5 The DRYRUN h5 note is unlinked again (owner side), so S3 starts as in round 4: p20 has no note. Its
  --       window stays, frozen for p20, and counts for nobody while the note is unlinked.
  PERFORM pg_temp.dr_as(NULL);
  UPDATE public.promissory_notes SET partner_user_id = NULL WHERE id = v_ids[2];
  SELECT count(*) INTO v_n FROM public.promissory_notes n WHERE n.partner_user_id = v_p20;
  o := o || format(E'\nINFO S2.5 the DRYRUN h5 note unlinked again (owner side): notes linked to p20 now=%s (want 0)', v_n);
  -- (round 5) end of S2.2-S2.5

  -- =====================================================================================
  -- S3. Switch ON: every path takes each person's rate
  -- =====================================================================================
  v_lap := clock_timestamp();

  -- S3.1 Quotes
  v_t := concat_ws(' | ',
    'public(anon)=' || COALESCE(pg_temp.dr_call(NULL, 'SELECT to_jsonb(public.partner_quote_rate(''public'', NULL))', 'anon') ->> 'ok', 'ERR'),
    'me(p20)=' || COALESCE(pg_temp.dr_call(v_p20, 'SELECT to_jsonb(public.partner_quote_rate(''me'', NULL))') ->> 'ok', 'ERR'),
    'me(pnew)=' || COALESCE(pg_temp.dr_call(v_pnew, 'SELECT to_jsonb(public.partner_quote_rate(''me'', NULL))') ->> 'ok', 'ERR'),
    'me(agent)=' || COALESCE(pg_temp.dr_call(v_agent, 'SELECT to_jsonb(public.partner_quote_rate(''me'', NULL))') ->> 'ok', 'ERR'),
    'partner(ops->p20)=' || COALESCE(pg_temp.dr_call(v_ops, format('SELECT to_jsonb(public.partner_quote_rate(''partner'', %L))', v_p20)) ->> 'ok', 'ERR'),
    'partner(ops->signed)=' || COALESCE(pg_temp.dr_call(v_ops, format('SELECT to_jsonb(public.partner_quote_rate(''partner'', %L))', v_signed)) ->> 'ok', 'ERR'),
    'partner(ops->staffA)=' || COALESCE(pg_temp.dr_call(v_ops, format('SELECT to_jsonb(public.partner_quote_rate(''partner'', %L))', v_staff_a)) ->> 'ok', 'ERR'),
    'partner(agent->p20)=' || COALESCE(pg_temp.dr_call(v_agent, format('SELECT to_jsonb(public.partner_quote_rate(''partner'', %L))', v_p20)) ->> 'error', 'NOT REFUSED'));
  o := o || format(E'\n%s S3.1 on quotes: %s',
                   CASE WHEN v_t ~ '^public\(anon\)=10(\.00)? \| me\(p20\)=20(\.00)? \| me\(pnew\)=10(\.00)? \| me\(agent\)=10(\.00)? \| partner\(ops->p20\)=20(\.00)? \| partner\(ops->signed\)=15(\.00)? \| partner\(ops->staffA\)=20(\.00)? \| partner\(agent->p20\)=NOT_AUTHORIZED.*$'
                        THEN 'PASS' ELSE 'FAIL' END, v_t);

  -- S3.2 House listing: old call shape quotes the public 10; 'me' and staff 'partner' quote the person
  v_j := pg_temp.dr_call(v_agent, 'SELECT pg_temp.prod_agent_list_empty_house_opportunities()', 'owner');
  v_j2 := pg_temp.dr_call(v_agent, pg_temp.dr_list_sql());
  v_j3 := pg_temp.dr_call(v_p20, pg_temp.dr_list_sql(', p_quote_for => ''me'''));
  SELECT COALESCE(jsonb_agg(e ->> 'house_id' ORDER BY e ->> 'house_id'), '[]') INTO v_t FROM jsonb_array_elements(v_j -> 'ok' -> 'houses') e;
  SELECT COALESCE(jsonb_agg(e ->> 'house_id' ORDER BY e ->> 'house_id'), '[]') INTO v_t2 FROM jsonb_array_elements(v_j2 -> 'ok' -> 'houses') e;
  o := o || format(E'\n%s S3.2 on listing, old call shape (agent): rate=%s every house at 10=%s, same houses and total as today''s code=%s; p_quote_for=me (p20): rate=%s every house at 20=%s%s%s%s',
    CASE WHEN v_j2 ? 'ok' AND v_j3 ? 'ok' AND (v_j2 -> 'ok' ->> 'returns_rate_pct')::numeric = 10
              AND pg_temp.dr_houses_at(v_j2 -> 'ok' -> 'houses', 10) AND v_t = v_t2
              AND (v_j -> 'ok' -> 'total') = (v_j2 -> 'ok' -> 'total')
              AND (v_j3 -> 'ok' ->> 'returns_rate_pct')::numeric = 20 AND pg_temp.dr_houses_at(v_j3 -> 'ok' -> 'houses', 20)
         THEN 'PASS' ELSE 'FAIL' END,
    v_j2 -> 'ok' ->> 'returns_rate_pct', pg_temp.dr_houses_at(v_j2 -> 'ok' -> 'houses', 10),
    v_t = v_t2 AND (v_j -> 'ok' -> 'total') = (v_j2 -> 'ok' -> 'total'),
    v_j3 -> 'ok' ->> 'returns_rate_pct', pg_temp.dr_houses_at(v_j3 -> 'ok' -> 'houses', 20),
    pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2), pg_temp.dr_err(v_j3));
  v_j := pg_temp.dr_call(v_agent, pg_temp.dr_list_sql(format(', p_quote_for => ''partner'', p_partner_id => %L', v_p20)));
  v_j2 := pg_temp.dr_call(v_ops, pg_temp.dr_list_sql(format(', p_quote_for => ''partner'', p_partner_id => %L', v_p20)));
  o := o || format(E'\n%s S3.3 on listing for a named partner: agent refused=%s; Partner Ops quoting p20: rate=%s at 20=%s%s',
    CASE WHEN COALESCE(v_j ->> 'error', '') LIKE 'NOT_AUTHORIZED%' AND (v_j2 -> 'ok' ->> 'returns_rate_pct')::numeric = 20
              AND pg_temp.dr_houses_at(v_j2 -> 'ok' -> 'houses', 20) THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(left(v_j ->> 'error', 80), 'NOT REFUSED'), v_j2 -> 'ok' ->> 'returns_rate_pct',
    pg_temp.dr_houses_at(v_j2 -> 'ok' -> 'houses', 20), pg_temp.dr_err(v_j2));

  -- S3.4 Summary: old call shape quotes the public 10
  v_j := pg_temp.dr_call(v_agent, 'SELECT pg_temp.prod_empty_house_opportunity_summary()', 'owner');
  v_j2 := pg_temp.dr_call(v_agent, 'SELECT public.empty_house_opportunity_summary()');
  SELECT COALESCE(sum(round(COALESCE(h.monthly_rent, 0) * (10::numeric / 100))), 0) INTO v_amt
    FROM public.house_listings h
   WHERE h.status = 'available' AND h.tenant_id IS NULL AND COALESCE(h.is_hidden, false) = false
     AND COALESCE(h.monthly_rent, 0) > 0 AND NOT public.house_has_live_claim(h.id);
  v_j3 := pg_temp.dr_call(v_agent, format('SELECT public.empty_house_opportunity_summary(%L, %L::uuid)', 'partner', v_p20));
  o := o || format(E'\n%s S3.4 on summary (agent): rate=%s, if all funded/month=%s (want %s at 10), houses %s = today''s code %s; named partner by agent refused=%s%s%s',
    CASE WHEN v_j2 ? 'ok' AND (v_j2 -> 'ok' ->> 'returns_rate_pct')::numeric = 10
              AND (v_j2 -> 'ok' ->> 'monthly_return_if_all_funded')::numeric = v_amt
              AND (v_j2 -> 'ok' -> 'house_count') = (v_j -> 'ok' -> 'house_count')
              AND (v_j2 -> 'ok' -> 'total_rent_needed') = (v_j -> 'ok' -> 'total_rent_needed')
              AND COALESCE(v_j3 ->> 'error', '') LIKE 'NOT_AUTHORIZED%' THEN 'PASS' ELSE 'FAIL' END,
    v_j2 -> 'ok' ->> 'returns_rate_pct', v_j2 -> 'ok' ->> 'monthly_return_if_all_funded', v_amt,
    v_j2 -> 'ok' ->> 'house_count', v_j -> 'ok' ->> 'house_count', COALESCE(left(v_j3 ->> 'error', 60), 'NOT REFUSED'),
    pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));

  -- S3.5 Supporter pool card: nothing was put in after the cut-off, so it is still today's figure
  v_j := pg_temp.dr_call(v_ops, 'SELECT pg_temp.prod_get_supporter_pool_stats()::jsonb', 'owner');
  v_j2 := pg_temp.dr_call(v_ops, 'SELECT public.get_supporter_pool_stats()::jsonb');
  o := o || format(E'\n%s S3.5 on get_supporter_pool_stats still identical to today: %s (obligationRatePct=%s)%s',
    CASE WHEN v_j ? 'ok' AND v_j2 ? 'ok' AND ((v_j2 -> 'ok') - 'obligationRatePct') = (v_j -> 'ok')
              AND (v_j2 -> 'ok' ->> 'obligationRatePct')::numeric = 15 THEN 'PASS' ELSE 'FAIL' END,
    ((v_j2 -> 'ok') - 'obligationRatePct') = (v_j -> 'ok'), v_j2 -> 'ok' ->> 'obligationRatePct', pg_temp.dr_err(v_j2));

  -- S3.6 funder_create_pending_portfolio
  v_j := pg_temp.dr_call(v_p20, 'SELECT public.funder_create_pending_portfolio(50000::numeric, NULL::uuid, 12)');
  v_t := pg_temp.dr_pf((v_j -> 'ok' ->> 'portfolio_id')::uuid);
  v_j2 := pg_temp.dr_call(v_pnew, 'SELECT public.funder_create_pending_portfolio(50000::numeric, NULL::uuid, 12)');
  v_t2 := pg_temp.dr_pf((v_j2 -> 'ok' ->> 'portfolio_id')::uuid);
  o := o || format(E'\n%s S3.6 on funder_create_pending_portfolio: p20 %s result %s (want 20/20/existing_partner/req=0, 20); pnew %s result %s (want 10/10/new/req=0, 10)%s%s',
                   CASE WHEN v_t = '20/20/existing_partner/req=0' AND (v_j -> 'ok' ->> 'roi_percentage')::numeric = 20
                             AND v_t2 = '10/10/new/req=0' AND (v_j2 -> 'ok' ->> 'roi_percentage')::numeric = 10 THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_j -> 'ok' ->> 'roi_percentage', v_t2, v_j2 -> 'ok' ->> 'roi_percentage', pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));

  -- S3.7 create_pending_portfolio: untyped p20; typed 20 for pnew (CFO); typed 20 for p20 (equal, no request)
  v_j := pg_temp.dr_call(v_ops, format('SELECT to_jsonb(x) FROM public.create_pending_portfolio(%L::uuid, 100000::numeric, 12, NULL::numeric, %L, %L, %L) x',
                                       v_p20, 'monthly_payout', 'DRYRUN P2 on untyped', repeat('c', 40)));
  v_t := pg_temp.dr_pf((v_j -> 'ok' ->> 'portfolio_id')::uuid);
  v_j2 := pg_temp.dr_call(v_ops, format('SELECT to_jsonb(x) FROM public.create_pending_portfolio(%L::uuid, 100000::numeric, 12, 20::numeric, %L, %L, %L) x',
                                        v_pnew, 'monthly_payout', 'DRYRUN P2 on typed', repeat('d', 40)));
  v_pid := (v_j2 -> 'ok' ->> 'portfolio_id')::uuid;
  v_t2 := pg_temp.dr_pf(v_pid) || ' ' || pg_temp.dr_req(v_pid);
  SELECT count(*) INTO v_n FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = v_pid AND a.requested_by = v_ops;
  v_j3 := pg_temp.dr_call(v_ops, format('SELECT to_jsonb(x) FROM public.create_pending_portfolio(%L::uuid, 100000::numeric, 12, 20::numeric, %L, %L, %L) x',
                                        v_p20, 'monthly_payout', 'DRYRUN P2 on typed equal', repeat('e', 40)));
  v_t3 := pg_temp.dr_pf((v_j3 -> 'ok' ->> 'portfolio_id')::uuid);
  o := o || format(E'\n%s S3.7 on create_pending_portfolio: untyped p20 %s (want 20/20/existing_partner/req=0); typed 20 for pnew %s, requested by ops=%s (want 10/10/new/req=1 new_portfolio:pending:20/10/10, 1); typed 20 for p20 %s (want 20/20/existing_partner/req=0)%s%s%s',
                   CASE WHEN v_t = '20/20/existing_partner/req=0' AND v_t2 = '10/10/new/req=1 new_portfolio:pending:20/10/10'
                             AND v_n = 1 AND v_t3 = '20/20/existing_partner/req=0' THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_t2, v_n, v_t3, pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2), pg_temp.dr_err(v_j3));

  -- S3.8 partner_support_houses: p20 on h2 (20), pnew on h3 (10)
  v_j := pg_temp.dr_call(v_p20, format('SELECT public.partner_support_houses(p_house_ids => ARRAY[%L]::uuid[], p_term_months => 12, p_idempotency_key => NULL, p_commitment_id => NULL)', v_h[2]));
  DROP TABLE IF EXISTS pg_temp._psh_pick;
  v_t := pg_temp.dr_pf((v_j -> 'ok' ->> 'portfolio_id')::uuid) || ' ' || pg_temp.dr_commit((v_j -> 'ok' ->> 'commitment_id')::uuid);
  v_j2 := pg_temp.dr_call(v_pnew, format('SELECT public.partner_support_houses(p_house_ids => ARRAY[%L]::uuid[], p_term_months => 12, p_idempotency_key => NULL, p_commitment_id => NULL)', v_h[3]));
  DROP TABLE IF EXISTS pg_temp._psh_pick;
  v_t2 := pg_temp.dr_pf((v_j2 -> 'ok' ->> 'portfolio_id')::uuid) || ' ' || pg_temp.dr_commit((v_j2 -> 'ok' ->> 'commitment_id')::uuid);
  o := o || format(E'\n%s S3.8 on partner_support_houses: p20/h2 %s result roi=%s monthly=%s of %s; pnew/h3 %s result roi=%s monthly=%s of %s%s%s',
                   CASE WHEN v_t = '20/20/existing_partner/req=0 commitment=20 houses=20 notices=20 notice_returns_ok=true'
                             AND (v_j -> 'ok' ->> 'roi_percentage')::numeric = 20
                             AND (v_j -> 'ok' ->> 'monthly_return')::numeric = round((v_j -> 'ok' ->> 'committed_amount')::numeric * 20 / 100)
                             AND v_t2 = '10/10/new/req=0 commitment=10 houses=10 notices=10 notice_returns_ok=true'
                             AND (v_j2 -> 'ok' ->> 'roi_percentage')::numeric = 10
                             AND (v_j2 -> 'ok' ->> 'monthly_return')::numeric = round((v_j2 -> 'ok' ->> 'committed_amount')::numeric * 10 / 100)
                        THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_j -> 'ok' ->> 'roi_percentage', v_j -> 'ok' ->> 'monthly_return', v_j -> 'ok' ->> 'committed_amount',
                   v_t2, v_j2 -> 'ok' ->> 'roi_percentage', v_j2 -> 'ok' ->> 'monthly_return', v_j2 -> 'ok' ->> 'committed_amount',
                   pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));

  -- S3.9 get_countersign_summary shows each partner's own rate
  v_t := concat_ws(' ',
    'p20=' || COALESCE(pg_temp.dr_call(v_ops, format('SELECT public.get_countersign_summary(%L::uuid, 1000000::numeric)', v_p20)) -> 'ok' ->> 'roi_percentage', 'ERR'),
    'pnew=' || COALESCE(pg_temp.dr_call(v_ops, format('SELECT public.get_countersign_summary(%L::uuid, 1000000::numeric)', v_pnew)) -> 'ok' ->> 'roi_percentage', 'ERR'),
    'signed=' || COALESCE(pg_temp.dr_call(v_ops, format('SELECT public.get_countersign_summary(%L::uuid, 1000000::numeric)', v_signed)) -> 'ok' ->> 'roi_percentage', 'ERR'),
    'staffA=' || COALESCE(pg_temp.dr_call(v_ops, format('SELECT public.get_countersign_summary(%L::uuid, 1000000::numeric)', v_staff_a)) -> 'ok' ->> 'roi_percentage', 'ERR'));
  o := o || format(E'\n%s S3.9 on get_countersign_summary: %s (want p20=20 pnew=10 signed=15 staffA=20)',
                   CASE WHEN v_t ~ '^p20=20(\.00)? pnew=10(\.00)? signed=15(\.00)? staffA=20(\.00)?$' THEN 'PASS' ELSE 'FAIL' END, v_t);

  -- S3.10 Payroll reinvestment (staff B): employee rate, no CFO request, context cleared after the insert
  v_j := pg_temp.dr_call(NULL, format('SELECT public.hr_pay_post_staff_reinvestment(%L::uuid)', v_slip_b), 'owner');
  v_pid := (v_j -> 'ok' ->> 'portfolio_id')::uuid;
  v_t := pg_temp.dr_pf(v_pid);
  v_t2 := COALESCE(current_setting('app.partner_rate_context', true), '');
  SELECT count(*) INTO v_n FROM public.hr_pay_staff_reinvestments x WHERE x.payslip_id IN (v_slip_a, v_slip_b);
  o := o || format(E'\n%s S3.10 on payroll reinvestment (staff B): %s/%s, portfolio %s, result roi=%s, context after="%s", reinvestment rows=%s (want posted/portfolio_created, 20/20/salary_reinvestment/req=0, 20, "", 2)%s',
                   CASE WHEN v_j -> 'ok' ->> 'status' = 'posted' AND v_j -> 'ok' ->> 'kind' = 'portfolio_created'
                             AND v_t = '20/20/salary_reinvestment/req=0' AND (v_j -> 'ok' ->> 'roi_percentage')::numeric = 20
                             AND v_t2 = '' AND v_n = 2 THEN 'PASS' ELSE 'FAIL' END,
                   v_j -> 'ok' ->> 'status', v_j -> 'ok' ->> 'kind', v_t, v_j -> 'ok' ->> 'roi_percentage', v_t2, v_n, pg_temp.dr_err(v_j));

  -- S3.11 Split promissory booking (agent session): h6 and h7, nobody linked -> new-partner 10
  v_j := pg_temp.dr_call(v_agent, format('SELECT public.agent_create_promissory_notes_split(%L::jsonb, ARRAY[%L, %L]::uuid[])',
                                         v_payload, v_h[6], v_h[7]));
  v_ids_on := ARRAY(SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(v_j -> 'ok' -> 'note_ids') x);
  v_t := pg_temp.dr_notes(v_ids_on);
  SELECT bool_and((e ->> 'monthly_return')::numeric = round((e -> 'note' ->> 'amount')::numeric * 10 / 100)
                  AND (e ->> 'return_rate')::numeric = 10
                  AND (e -> 'note' ->> 'amount')::numeric = (SELECT h.monthly_rent FROM public.house_listings h WHERE h.id = (e ->> 'house_id')::uuid))
    INTO v_b FROM jsonb_array_elements(v_j -> 'ok' -> 'notes') e;
  SELECT count(*) INTO v_n FROM public.promissory_note_house_intents i WHERE i.note_id = ANY (v_ids_on) AND i.status = 'reserved';
  o := o || format(E'\n%s S3.11 on split notes (agent, h6+h7): %s; result figures at 10: %s; houses reserved=%s (want n=2 status=pending rate=10/new linked=0 pledge=2:10 booking=2:10 pledge_amounts_ok=true ledger_rows=0, true, 2)%s',
                   CASE WHEN v_t = 'n=2 status=pending rate=10/new linked=0 pledge=2:10 booking=2:10 pledge_amounts_ok=true ledger_rows=0'
                             AND v_b AND v_n = 2 THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_b, v_n, pg_temp.dr_err(v_j));
  SELECT count(*) INTO v_n FROM public.general_ledger g
   WHERE g.source_table = 'promissory_notes' AND g.source_id = ANY (v_ids || v_ids_on);
  SELECT COALESCE(sum(s.n_tup_ins), 0) INTO v_m FROM pg_stat_xact_all_tables s WHERE s.relid = 'public.promissory_notes'::regclass;
  o := o || format(E'\n%s S3.12 no ledger receivable for the 4 pending notes: ledger rows for them=%s; notes inserted this transaction=%s (want 0, 4)',
                   CASE WHEN v_n = 0 AND v_m = 4 THEN 'PASS' ELSE 'FAIL' END, v_n, v_m);

  -- S3.13 Share link refreshes to the public 10; the public offer page quotes 10
  SELECT h.monthly_rent INTO v_amt FROM public.house_listings h WHERE h.id = v_h[8];
  v_j := pg_temp.dr_call(v_agent, format('SELECT to_jsonb(x) FROM public.get_or_create_house_share_link(%L::uuid) x', v_h[8]));
  v_t := 'receive UGX ' || to_char(round(v_amt * 10 / 100), 'FM999,999,999') || ' every month';
  v_j2 := pg_temp.dr_call(NULL, format('SELECT public.public_house_support_offer(%L)', v_j -> 'ok' ->> 'code'), 'anon');
  o := o || format(E'\n%s S3.13 on house share link: refreshed (created=%s) and quotes "%s"=%s; public offer page (anon) monthly_return=%s (want %s)%s%s',
                   CASE WHEN NOT (v_j -> 'ok' ->> 'created')::boolean AND position(v_t IN COALESCE(v_j -> 'ok' ->> 'og_description', '')) > 0
                             AND (v_j2 -> 'ok' ->> 'monthly_return')::numeric = round(v_amt * 10 / 100) THEN 'PASS' ELSE 'FAIL' END,
                   v_j -> 'ok' ->> 'created', v_t, position(v_t IN COALESCE(v_j -> 'ok' ->> 'og_description', '')) > 0,
                   v_j2 -> 'ok' ->> 'monthly_return', round(v_amt * 10 / 100), pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));

  -- S3.14 Late link: a portfolio opened after the cut-off at 10 inside a pre-cut-off note's window, then the
  --       note is linked to that person by an owner-side update -> exactly one note_late_link CFO request.
  v_late_pf := gen_random_uuid();
  INSERT INTO public.investor_portfolios (id, investor_id, agent_id, portfolio_code, portfolio_pin,
                                          duration_months, investment_amount, status)
  VALUES (v_late_pf, v_late, v_late, 'DRYRUN-' || left(v_late_pf::text, 13), c_pin, 12, 100000, 'pending_ops_approval');
  v_t := pg_temp.dr_pf(v_late_pf);
  SELECT w.ends_on, trim_scale(w.return_rate) INTO v_ends, v_rate FROM public.partner_return_note_windows w WHERE w.note_id = v_late_note;
  PERFORM pg_temp.dr_as(NULL);
  UPDATE public.promissory_notes SET partner_user_id = v_late WHERE id = v_late_note;
  SELECT count(*) INTO v_n FROM public.portfolio_rate_approvals a WHERE a.source = 'note_late_link';
  v_t2 := pg_temp.dr_pf(v_late_pf) || ' ' || pg_temp.dr_req(v_late_pf);
  SELECT x.rate, x.basis INTO v_rate2, v_basis FROM public.partner_rate_for(v_late) x;
  SELECT trim_scale(n.return_rate) || '/' || n.return_rate_basis INTO v_t3 FROM public.promissory_notes n WHERE n.id = v_late_note;
  o := o || format(E'\n%s S3.14 late link: portfolio before %s (want 10/10/new/req=0); window %s at %s (open=%s); after linking: note_late_link requests=%s, portfolio %s (want 1, 10/10/new/req=1 note_late_link:pending:15/10/15); note still %s; person now %s/%s (want 15/promissory_note)',
                   CASE WHEN v_t = '10/10/new/req=0' AND v_ends >= current_date AND v_n = 1
                             AND v_t2 = '10/10/new/req=1 note_late_link:pending:15/10/15' AND v_t3 = '15/legacy'
                             AND v_rate2 = 15 AND v_basis = 'promissory_note' THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_ends, v_rate, v_ends >= current_date, v_n, v_t2, v_t3, v_rate2, v_basis);

  -- S3.15 A note written after the cut-off for an unknown person (10/new) shows the person's own rate once linked.
  UPDATE public.promissory_notes SET partner_user_id = v_p20 WHERE id = v_ids_on[1];
  SELECT trim_scale(n.return_rate) || '/' || n.return_rate_basis INTO v_t FROM public.promissory_notes n WHERE n.id = v_ids_on[1];
  SELECT trim_scale(n.return_rate) || '/' || n.return_rate_basis INTO v_t2 FROM public.promissory_notes n WHERE n.id = v_ids_on[2];
  SELECT count(*) INTO v_n FROM public.portfolio_rate_approvals a WHERE a.source = 'note_late_link';
  o := o || format(E'\n%s S3.15 post-cut-off note linked to p20: %s (want 20/existing_partner); the other note %s (want 10/new); note_late_link requests still %s (want 1)',
                   CASE WHEN v_t = '20/existing_partner' AND v_t2 = '10/new' AND v_n = 1 THEN 'PASS' ELSE 'FAIL' END, v_t, v_t2, v_n);
  -- S3.16 partner_supported_house_returns after the switch-on: p20's linked note (h6, now 20/existing_partner)
  --       shows the note's own rate; today's code would still say 15.
  v_j := pg_temp.dr_call(v_p20, 'SELECT public.partner_supported_house_returns()');
  v_j2 := pg_temp.dr_call(v_p20, 'SELECT pg_temp.prod_partner_supported_house_returns()', 'owner');
  SELECT string_agg((e -> 'return_rate')::text, ','), count(*),
         bool_and((e ->> 'monthly_return')::numeric = round((e ->> 'monthly_rent')::numeric * 20 / 100)
                  AND (e ->> 'annual_return')::numeric = round((e ->> 'monthly_rent')::numeric * 20 / 100 * 12)),
         max(e ->> 'monthly_return')
    INTO v_t, v_n, v_b, v_t3
    FROM jsonb_array_elements(v_j -> 'ok' -> 'houses') e WHERE (e ->> 'note_id')::uuid = v_ids_on[1];
  SELECT max(e ->> 'monthly_return') INTO v_t2
    FROM jsonb_array_elements(v_j2 -> 'ok' -> 'houses') e WHERE (e ->> 'note_id')::uuid = v_ids_on[1];
  o := o || format(E'\n%s S3.16 on partner_supported_house_returns (p20, note on h6): houses=%s return_rate=%s monthly/annual at 20=%s (monthly %s; today''s code %s) (want 1, 20, true)%s%s',
                   CASE WHEN v_n = 1 AND v_t = '20' AND v_b THEN 'PASS' ELSE 'FAIL' END,
                   v_n, v_t, v_b, v_t3, v_t2, pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));

  -- S3.17 Rates still come out without trailing zeros after the switch-on.
  v_t := concat_ws(' ',
    'quote(public,anon)=' || COALESCE(pg_temp.dr_call(NULL, 'SELECT to_jsonb(public.partner_quote_rate(''public'', NULL))', 'anon') ->> 'ok', 'ERR'),
    'quote(me,p20)=' || COALESCE(pg_temp.dr_call(v_p20, 'SELECT to_jsonb(public.partner_quote_rate(''me'', NULL))') ->> 'ok', 'ERR'),
    'new_contract=' || COALESCE(pg_temp.dr_call(NULL, 'SELECT to_jsonb(public.partner_new_contract_rate())', 'owner') ->> 'ok', 'ERR'),
    'rates_for(p20,pnew,staffA)=' || COALESCE(pg_temp.dr_call(NULL, format('SELECT jsonb_agg(x.rate ORDER BY array_position(ARRAY[%L, %L, %L]::uuid[], x.partner_id)) FROM public.partner_rates_for(ARRAY[%L, %L, %L]::uuid[]) x',
                                                     v_p20, v_pnew, v_staff_a, v_p20, v_pnew, v_staff_a), 'owner') ->> 'ok', 'ERR'),
    'note_rate_for(pnew)=' || COALESCE(pg_temp.dr_call(NULL, format('SELECT jsonb_agg(x.rate) FROM public.partner_note_rate_for(%L::uuid) x', v_pnew), 'owner') ->> 'ok', 'ERR'),
    'note_rate_for(nobody)=' || COALESCE(pg_temp.dr_call(NULL, 'SELECT jsonb_agg(x.rate) FROM public.partner_note_rate_for(NULL::uuid) x', 'owner') ->> 'ok', 'ERR'));
  o := o || format(E'\n%s S3.17 on rates have no trailing zeros: %s (want public 10, p20 20, new 10, [20, 10, 20], [10], [10])',
                   CASE WHEN v_t = 'quote(public,anon)=10 quote(me,p20)=20 new_contract=10 rates_for(p20,pnew,staffA)=[20, 10, 20] note_rate_for(pnew)=[10] note_rate_for(nobody)=[10]'
                        THEN 'PASS' ELSE 'FAIL' END, v_t);

  -- S3.18 post_rent_facilitation_reward: the wallet text is built in the database from the stored rate (only a
  --       trailing "(managed by ...)" is kept from the caller's text, round 3: with one level of nested brackets)
  --       and the ledger texts say "Returns", never ROI; round 3: the result's rate is trimmed (15, not 15.00).
  --       The real funded request is made due only inside a savepoint that is undone straight after the reward,
  --       so the request, the payment row, the ledger rows and the wallet change all disappear before S4.
  SELECT count(*) INTO v_m
    FROM regexp_matches(pg_get_functiondef('public.post_rent_facilitation_reward(uuid,integer,uuid,text)'::regprocedure),
                        '''description'',\s*format\(''[^'']*ROI', 'g');
  SELECT count(*) INTO v_k
    FROM regexp_matches(pg_get_functiondef('public.post_rent_facilitation_reward(uuid,integer,uuid,text)'::regprocedure),
                        '''description'',\s*format\(''[^'']*Returns', 'g');
  v_t := NULL; v_t2 := NULL; v_t3 := NULL; v_t4 := NULL; v_err := NULL; v_j := NULL; v_n := NULL;
  SELECT rr.roi_payments_count, rr.rent_amount INTO v_pay, v_amt FROM public.rent_requests rr WHERE rr.id = v_rr;
  v_pay := COALESCE(v_pay, 0) + 1;
  v_rent_txt := to_char(v_amt, 'FM999,999,999,990');
  BEGIN
    UPDATE public.rent_requests SET next_roi_due_date = now() - interval '1 minute' WHERE id = v_rr;
    v_j := pg_temp.dr_call(NULL, format('SELECT public.post_rent_facilitation_reward(%L::uuid, %s, NULL::uuid, %L)', v_rr, v_pay,
                                        '99% monthly ROI on a loan of UGX 1 (managed by DRYRUN Agent (Kampala office))'), 'owner');
    SELECT max(g.description) FILTER (WHERE g.category = 'roi_wallet_credit'),
           max(g.description) FILTER (WHERE g.category = 'roi_expense'), count(*)
      INTO v_t, v_t2, v_n
      FROM public.general_ledger g WHERE g.transaction_group_id = (v_j -> 'ok' ->> 'transaction_group_id')::uuid;
    RAISE EXCEPTION 'DR_UNDO';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'DR_UNDO' THEN v_err := SQLERRM; END IF;
  END;
  v_t3 := format('15%% monthly reward (payment #%s) on rent facilitation of UGX %s (managed by DRYRUN Agent (Kampala office))', v_pay, v_rent_txt);
  v_t4 := format('Platform Returns payout #%s to supporter for rent facilitation of UGX %s', v_pay, v_rent_txt);
  SELECT rr.roi_payments_count INTO v_k2 FROM public.rent_requests rr WHERE rr.id = v_rr;
  o := o || format(E'\n%s S3.18 reward texts: static ROI descriptions=%s Returns descriptions=%s (want 0, 3); posted inside an undone savepoint: status=%s rate=%s amount=%s (want posted, 15, %s); wallet text="%s" (want "%s"); platform text="%s"; ledger rows=%s (want 2); request back to payment count %s (want %s)%s%s',
                   CASE WHEN v_err IS NULL AND v_m = 0 AND v_k = 3 AND v_j -> 'ok' ->> 'status' = 'posted'
                             AND v_j -> 'ok' ->> 'rate' = '15' AND (v_j -> 'ok' ->> 'amount')::numeric = round(v_amt * 15 / 100)
                             AND v_t = v_t3 AND v_t2 = v_t4 AND v_n = 2 AND v_t !~ 'ROI|99%' AND COALESCE(v_k2, 0) = v_pay - 1
                        THEN 'PASS' ELSE 'FAIL' END,
                   v_m, v_k, v_j -> 'ok' ->> 'status', v_j -> 'ok' ->> 'rate', v_j -> 'ok' ->> 'amount', round(v_amt * 15 / 100),
                   v_t, v_t3, v_t2, v_n, v_k2, v_pay - 1,
                   CASE WHEN v_err IS NOT NULL THEN ' ERROR: ' || left(v_err, 300) ELSE '' END, pg_temp.dr_err(v_j));
  -- (round 3) S3.19 Late link of a DRYRUN note to a real person, inside a savepoint undone straight after. The OFF split
  --       note on h4 (pending, nobody linked, window frozen at the cut-off at 15) is linked to late2 (a real profile
  --       with nothing, so 10 now) just after a DRYRUN portfolio was opened for late2 at 10. Checks: the portfolio
  --       row is KEY SHARE locked by this transaction during the link (pg_locks does not list row locks: its xmax
  --       goes from 0 to an xid of this transaction, age <= 0; no other session can lock a row this transaction
  --       inserted and has not committed), the session holds at most 256 partner-rate advisory
  --       locks with late2's bucket among them, the catch-up is queued, and partner_rate_lock called with 20,000
  --       real profiles at once holds at most 256 (round 2: one lock per person ran out of shared memory locally).
  v_t := NULL; v_t2 := NULL; v_t3 := NULL; v_t4 := NULL; v_err := NULL; v_b := NULL; v_pid := NULL;
  v_l1 := NULL; v_l2 := NULL; v_l3 := NULL; v_people := NULL; v_xmin := NULL; v_xmax0 := NULL; v_xmax1 := NULL; v_age := NULL;
  SELECT x.held INTO v_l0 FROM pg_temp.dr_rate_locks() x;
  IF v_late2 IS NULL THEN
    v_err := 'fixture late2 is missing';
  ELSE
    BEGIN
      v_pid := gen_random_uuid();
      INSERT INTO public.investor_portfolios (id, investor_id, agent_id, portfolio_code, portfolio_pin,
                                              duration_months, investment_amount, status)
      VALUES (v_pid, v_late2, v_late2, 'DRYRUN-' || left(v_pid::text, 13), c_pin, 12, 100000, 'pending_ops_approval');
      v_t := pg_temp.dr_pf(v_pid);
      SELECT ip.xmin::text, ip.xmax::text INTO v_xmin, v_xmax0 FROM public.investor_portfolios ip WHERE ip.id = v_pid;
      SELECT x.held INTO v_l1 FROM pg_temp.dr_rate_locks() x;
      PERFORM pg_temp.dr_as(NULL);
      UPDATE public.promissory_notes SET partner_user_id = v_late2 WHERE id = v_ids[1];
      SELECT ip.xmax::text, CASE WHEN ip.xmax <> '0'::xid THEN age(ip.xmax) END INTO v_xmax1, v_age
        FROM public.investor_portfolios ip WHERE ip.id = v_pid;
      SELECT x.held, x.who_held INTO v_l2, v_b FROM pg_temp.dr_rate_locks(v_late2) x;
      v_t2 := pg_temp.dr_pf(v_pid) || ' ' || pg_temp.dr_req(v_pid);
      SELECT trim_scale(w.return_rate) || ' until ' || w.ends_on INTO v_t3
        FROM public.partner_return_note_windows w WHERE w.note_id = v_ids[1];
      SELECT string_agg(DISTINCT l.mode, ',') INTO v_t4 FROM pg_locks l
       WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.granted
         AND l.relation = 'public.investor_portfolios'::regclass;
      SELECT count(*) INTO v_people FROM (SELECT p.id FROM public.profiles p ORDER BY p.id LIMIT 20000) x;
      PERFORM public.partner_rate_lock(ARRAY(SELECT p.id FROM public.profiles p ORDER BY p.id LIMIT 20000));
      SELECT x.held INTO v_l3 FROM pg_temp.dr_rate_locks() x;
      RAISE EXCEPTION 'DR_UNDO';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'DR_UNDO' THEN v_err := SQLERRM; END IF;
    END;
  END IF;
  SELECT x.held INTO v_l4 FROM pg_temp.dr_rate_locks() x;
  SELECT count(*) INTO v_n FROM public.promissory_notes n WHERE n.id = v_ids[1] AND n.partner_user_id IS NOT NULL;
  SELECT count(*) INTO v_m FROM public.investor_portfolios ip WHERE ip.id = v_pid;
  o := o || format(E'\n%s S3.19 locked late link (DRYRUN h4 note -> late2, undone): portfolio before %s (want 10/10/new/req=0); window %s; row lock xmax before=%s after=%s (age %s), row version written by xid %s (want 0, then an xid of this transaction, age <= 0: KEY SHARE taken during the link); after: %s (want 10/10/new/req=1 note_late_link:pending:15/10/15); partner-rate advisory locks held: before %s, after the portfolio %s, after the link %s with late2''s bucket=%s, after partner_rate_lock(%s people) %s (want <= 256 each, true, 256 for 20,000 people); investor_portfolios locks [%s]; undone: advisory locks %s (want %s), note linked=%s, portfolio rows=%s (want 0, 0)%s',
                   CASE WHEN v_err IS NULL AND v_t = '10/10/new/req=0' AND v_xmax0 = '0' AND v_xmax1 <> '0' AND v_age <= 0
                             AND v_t2 = '10/10/new/req=1 note_late_link:pending:15/10/15'
                             AND v_l2 <= 256 AND v_b AND v_l3 <= 256 AND v_l3 >= v_l2 AND (v_people < 20000 OR v_l3 = 256)
                             AND v_l4 = v_l0 AND v_n = 0 AND v_m = 0
                        THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_t3, v_xmax0, v_xmax1, v_age, v_xmin, v_t2, v_l0, v_l1, v_l2, v_b, v_people, v_l3, v_t4, v_l4, v_l0, v_n, v_m,
                   CASE WHEN v_err IS NOT NULL THEN ' ERROR: ' || left(v_err, 300) ELSE '' END);

  -- (round 3) S3.20 _promissory_note_rate_json, the rate part of every note RPC result, on this rehearsal's DRYRUN notes:
  --       the h6 note linked to p20 in S3.15 (20) shows no rate, basis, monthly or annual figure to the agent, and
  --       its own 20 to p20; the unlinked h7 note shows its 10 to the agent. Rates without trailing zeros.
  SELECT public._promissory_note_rate_json(n, v_agent), public._promissory_note_rate_json(n, v_p20), n.amount
    INTO v_j, v_j2, v_amt FROM public.promissory_notes n WHERE n.id = v_ids_on[1];
  SELECT public._promissory_note_rate_json(n, v_agent), n.amount INTO v_j3, v_rate FROM public.promissory_notes n WHERE n.id = v_ids_on[2];
  v_t := format('agent->h6(p20): note has return_rate=%s basis=%s; return_rate=%s monthly=%s annual=%s',
                (v_j -> 'note') ? 'return_rate', (v_j -> 'note') ? 'return_rate_basis',
                v_j -> 'return_rate', v_j -> 'monthly_return', v_j -> 'annual_return');
  v_t2 := format('p20->h6: note return_rate=%s basis=%s; return_rate=%s monthly=%s',
                 v_j2 -> 'note' -> 'return_rate', (v_j2 -> 'note') ? 'return_rate_basis', v_j2 -> 'return_rate', v_j2 -> 'monthly_return');
  v_t3 := format('agent->h7(nobody): note return_rate=%s basis=%s; return_rate=%s monthly=%s',
                 v_j3 -> 'note' -> 'return_rate', (v_j3 -> 'note') ? 'return_rate_basis', v_j3 -> 'return_rate', v_j3 -> 'monthly_return');
  o := o || format(E'\n%s S3.20 _promissory_note_rate_json: %s | %s | %s (want f/f/null/null/null | 20/f/20/%s | 10/f/10/%s)',
                   CASE WHEN v_t = 'agent->h6(p20): note has return_rate=f basis=f; return_rate=null monthly=null annual=null'
                             AND v_t2 = format('p20->h6: note return_rate=20 basis=f; return_rate=20 monthly=%s', round(v_amt * 20 / 100))
                             AND v_t3 = format('agent->h7(nobody): note return_rate=10 basis=f; return_rate=10 monthly=%s', round(v_rate * 10 / 100))
                        THEN 'PASS' ELSE 'FAIL' END,
                   v_t, v_t2, v_t3, round(v_amt * 20 / 100), round(v_rate * 10 / 100));

  -- (round 3) S3.21 The round-2 leak end to end: the agent records a promissory note and a one-house split booking (h8)
  --       for the phone of an existing person (p20, else staff A or B). Both notes link to that person at insert and
  --       carry the person's own rate, but the agent's results show no rate, basis, monthly or annual figure.
  --       Inside a savepoint undone straight after (with the pledge and booking notices it queues).
  v_phone := NULL; v_who := NULL; v_t := NULL; v_t2 := NULL; v_t3 := NULL; v_err := NULL; v_j := NULL; v_j2 := NULL;
  SELECT x.phone, x.id INTO v_phone, v_who
    FROM (SELECT p.phone, p.id, f.ord FROM unnest(ARRAY[v_p20, v_staff_a, v_staff_b]) WITH ORDINALITY AS f(id, ord)
            JOIN public.profiles p ON p.id = f.id
           WHERE length(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')) >= 9) x
   ORDER BY x.ord LIMIT 1;
  IF v_phone IS NULL THEN
    v_err := 'none of p20, staff A, staff B has a phone on the profile';
  ELSE
    BEGIN
      v_j := pg_temp.dr_call(v_agent, format('SELECT public.agent_create_promissory_note(%L::jsonb, ''{}''::uuid[])',
               jsonb_build_object('partner_name', 'DRYRUN Rate Probe', 'whatsapp_number', v_phone, 'amount', 100000,
                                  'contribution_type', 'once_off')));
      v_j2 := pg_temp.dr_call(v_agent, format('SELECT public.agent_create_promissory_notes_split(%L::jsonb, ARRAY[%L]::uuid[])',
                jsonb_build_object('partner_name', 'DRYRUN Rate Probe', 'whatsapp_number', v_phone, 'contribution_type', 'once_off'),
                v_h[8]));
      SELECT string_agg(format('%s:%s/%s', CASE WHEN n.partner_user_id = v_who THEN 'fixture'
                                                WHEN n.partner_user_id IS NULL THEN 'nobody' ELSE 'another person' END,
                               trim_scale(n.return_rate), n.return_rate_basis), ',' ORDER BY n.id = (v_j -> 'ok' -> 'note' ->> 'id')::uuid DESC)
        INTO v_t3 FROM public.promissory_notes n
       WHERE n.id IN ((v_j -> 'ok' -> 'note' ->> 'id')::uuid, (v_j2 -> 'ok' -> 'note_ids' ->> 0)::uuid);
      RAISE EXCEPTION 'DR_UNDO';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'DR_UNDO' THEN v_err := SQLERRM; END IF;
    END;
  END IF;
  v_t := format('note: note has return_rate=%s basis=%s; return_rate=%s monthly=%s annual=%s',
                (v_j -> 'ok' -> 'note') ? 'return_rate', (v_j -> 'ok' -> 'note') ? 'return_rate_basis',
                v_j -> 'ok' -> 'return_rate', v_j -> 'ok' -> 'monthly_return', v_j -> 'ok' -> 'annual_return');
  v_t2 := format('split: note has return_rate=%s basis=%s; return_rate=%s monthly=%s annual=%s',
                 (v_j2 -> 'ok' -> 'notes' -> 0 -> 'note') ? 'return_rate', (v_j2 -> 'ok' -> 'notes' -> 0 -> 'note') ? 'return_rate_basis',
                 v_j2 -> 'ok' -> 'notes' -> 0 -> 'return_rate', v_j2 -> 'ok' -> 'notes' -> 0 -> 'monthly_return',
                 v_j2 -> 'ok' -> 'notes' -> 0 -> 'annual_return');
  SELECT count(*) INTO v_n FROM public.promissory_notes n WHERE n.partner_name = 'DRYRUN Rate Probe';
  o := o || format(E'\n%s S3.21 agent books for a known phone (%s): stored notes [%s] (want both linked at insert with that person''s rate); agent sees %s | %s (want f/f/null/null/null for both); undone: probe notes left=%s (want 0)%s%s%s',
                   CASE WHEN v_err IS NULL AND v_j ? 'ok' AND v_j2 ? 'ok'
                             AND v_t3 ~ '^(fixture|another person):[0-9.]+/[a-z_]+,(fixture|another person):[0-9.]+/[a-z_]+$'
                             AND v_t = 'note: note has return_rate=f basis=f; return_rate=null monthly=null annual=null'
                             AND v_t2 = 'split: note has return_rate=f basis=f; return_rate=null monthly=null annual=null'
                             AND v_n = 0
                        THEN 'PASS' ELSE 'FAIL' END,
                   CASE v_who WHEN v_p20 THEN 'p20' WHEN v_staff_a THEN 'staff A' WHEN v_staff_b THEN 'staff B' ELSE 'none' END,
                   COALESCE(v_t3, ''), v_t, v_t2, v_n,
                   CASE WHEN v_err IS NOT NULL THEN ' ERROR: ' || left(v_err, 300) ELSE '' END, pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));

  -- (round 3) S3.22 obligationRatePct after the switch-on, as the screen receives it (nothing was put in after the
  --       cut-off, so still 15; never 15.00).
  v_j := pg_temp.dr_call(v_ops, 'SELECT public.get_supporter_pool_stats()::jsonb');
  o := o || format(E'\n%s S3.22 on get_supporter_pool_stats obligationRatePct as the screen receives it: %s (want 15)%s',
                   CASE WHEN (v_j -> 'ok' -> 'obligationRatePct')::text = '15' THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE((v_j -> 'ok' -> 'obligationRatePct')::text, 'missing'), pg_temp.dr_err(v_j));

  -- (round 4) S3.23 _promissory_note_rate_json also leaves out the linked account's id: the h6 note (linked to p20 in
  --       S3.15) shown to the agent has no partner_user_id key; shown to p20 it carries p20's own id; the unlinked h7
  --       note keeps the key, null, for the agent.
  v_b := NULL; v_b2 := NULL; v_b3 := NULL; v_j := NULL;
  SELECT (public._promissory_note_rate_json(n, v_agent) -> 'note') ? 'partner_user_id',
         (public._promissory_note_rate_json(n, v_p20) -> 'note' ->> 'partner_user_id') = v_p20::text
    INTO v_b, v_b2 FROM public.promissory_notes n WHERE n.id = v_ids_on[1];
  SELECT (public._promissory_note_rate_json(n, v_agent) -> 'note') ? 'partner_user_id',
         public._promissory_note_rate_json(n, v_agent) -> 'note' -> 'partner_user_id'
    INTO v_b3, v_j FROM public.promissory_notes n WHERE n.id = v_ids_on[2];
  o := o || format(E'\n%s S3.23 _promissory_note_rate_json and the linked account: agent->h6(p20) has partner_user_id=%s; p20->h6 shows p20''s own id=%s; agent->h7(nobody) has the key=%s value=%s (want false, true, true, null)',
                   CASE WHEN v_b = false AND v_b2 AND v_b3 AND v_j = 'null'::jsonb THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_b::text, 'missing'), COALESCE(v_b2::text, 'missing'), COALESCE(v_b3::text, 'missing'), COALESCE(v_j::text, 'missing'));

  -- (round 4) S3.24 Where the pledge and booking notices go. The agent records a promissory note and a one-house split
  --       booking (h8) for the phone of an existing person (as S3.21, typed in another format with the same last 9
  --       digits) with a DRYRUN email, and a note for the DRYRUN phone (nobody) with the same DRYRUN email. Every
  --       notice of a linked note must carry the linked person's PROFILE phone and LOGIN email (auth.users; round 5,
  --       no longer profiles.email), not what was typed; the unlinked note's notice keeps the typed contacts. Only
  --       match true/false is printed, never a contact. Inside a savepoint undone straight after (notes, intents and
  --       notices).
  v_phone := NULL; v_who := NULL; v_t := NULL; v_t2 := NULL; v_err := NULL; v_j := NULL; v_j2 := NULL; v_j3 := NULL;
  v_note := NULL; v_note2 := NULL; v_note3 := NULL; v_b := NULL; v_b2 := NULL; v_b4 := NULL; v_b5 := NULL; v_b6 := NULL;
  v_typed := 'dryrun-p2-notice@example.invalid';
  SELECT x.phone, x.id INTO v_phone, v_who
    FROM (SELECT p.phone, p.id, f.ord FROM unnest(ARRAY[v_p20, v_staff_a, v_staff_b]) WITH ORDINALITY AS f(id, ord)
            JOIN public.profiles p ON p.id = f.id
           WHERE length(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')) >= 9) x
   ORDER BY x.ord LIMIT 1;
  IF v_phone IS NULL THEN
    v_err := 'none of p20, staff A, staff B has a phone on the profile';
  ELSE
    v_b2 := btrim(v_phone) LIKE '+%';
    v_phone := CASE WHEN v_b2 THEN '0' ELSE '+256' END || right(regexp_replace(v_phone, '\D', '', 'g'), 9);
    BEGIN
      v_j := pg_temp.dr_call(v_agent, format('SELECT public.agent_create_promissory_note(%L::jsonb, ''{}''::uuid[])',
               jsonb_build_object('partner_name', 'DRYRUN Notice Probe', 'whatsapp_number', v_phone, 'email', v_typed,
                                  'amount', 100000, 'contribution_type', 'once_off')));
      v_j2 := pg_temp.dr_call(v_agent, format('SELECT public.agent_create_promissory_notes_split(%L::jsonb, ARRAY[%L]::uuid[])',
                jsonb_build_object('partner_name', 'DRYRUN Notice Probe', 'whatsapp_number', v_phone, 'email', v_typed,
                                   'contribution_type', 'once_off'), v_h[8]));
      v_j3 := pg_temp.dr_call(v_agent, format('SELECT public.agent_create_promissory_note(%L::jsonb, ''{}''::uuid[])',
                jsonb_build_object('partner_name', 'DRYRUN Notice Probe', 'whatsapp_number', c_phone, 'email', v_typed,
                                   'amount', 100000, 'contribution_type', 'once_off')));
      v_note := (v_j -> 'ok' -> 'note' ->> 'id')::uuid;
      v_note2 := (v_j2 -> 'ok' -> 'note_ids' ->> 0)::uuid;
      v_note3 := (v_j3 -> 'ok' -> 'note' ->> 'id')::uuid;
      -- linked notes: each notice row against the profile phone and the login email of the person the note is linked to
      SELECT string_agg(format('%s:%s %s phone=%s email=%s not_typed=%s', k.which, k.kind,
                               CASE WHEN n.partner_user_id = v_who THEN 'fixture'
                                    WHEN n.partner_user_id IS NULL THEN 'nobody' ELSE 'another person' END,
                               k.phone IS NOT DISTINCT FROM NULLIF(btrim(pr.phone), ''),
                               k.email IS NOT DISTINCT FROM NULLIF(btrim(u.email), ''),
                               k.email IS DISTINCT FROM v_typed), ' | ' ORDER BY k.which, k.kind)
        INTO v_t
        FROM (SELECT 'note' AS which, 'pledge' AS kind, x.note_id, x.phone, x.email
                FROM public.promissory_note_pledge_notices x WHERE x.note_id = v_note
              UNION ALL
              SELECT 'split', 'pledge', x.note_id, x.phone, x.email
                FROM public.promissory_note_pledge_notices x WHERE x.note_id = v_note2
              UNION ALL
              SELECT 'split', 'booking:' || x.kind, x.note_id, x.phone, x.email
                FROM public.promissory_house_booking_notices x WHERE x.note_id = v_note2) k
        JOIN public.promissory_notes n ON n.id = k.note_id
        LEFT JOIN public.profiles pr ON pr.id = n.partner_user_id
        LEFT JOIN auth.users u ON u.id = n.partner_user_id;
      -- the typed phone really differs from the profile's (so phone=t is the profile's, not the typed one), whether
      -- the linked people have a login email (if not, the notice has none and the typed one is not used), and
      -- whether their profile email is the login email (if it is, email=t cannot tell the two apart)
      SELECT bool_and(v_phone IS DISTINCT FROM NULLIF(btrim(pr.phone), '')), bool_and(NULLIF(btrim(u.email), '') IS NOT NULL),
             bool_and(lower(NULLIF(btrim(pr.email), '')) IS NOT DISTINCT FROM lower(NULLIF(btrim(u.email), '')))
        INTO v_b4, v_b5, v_b6
        FROM public.promissory_notes n JOIN public.profiles pr ON pr.id = n.partner_user_id
        LEFT JOIN auth.users u ON u.id = n.partner_user_id
       WHERE n.id IN (v_note, v_note2);
      -- unlinked note: the typed contacts
      SELECT format('%s phone=%s email=%s', CASE WHEN n.partner_user_id IS NULL THEN 'nobody' ELSE 'linked' END,
                    x.phone IS NOT DISTINCT FROM c_phone, x.email IS NOT DISTINCT FROM v_typed)
        INTO v_t2
        FROM public.promissory_note_pledge_notices x JOIN public.promissory_notes n ON n.id = x.note_id
       WHERE x.note_id = v_note3;
      RAISE EXCEPTION 'DR_UNDO';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'DR_UNDO' THEN v_err := SQLERRM; END IF;
    END;
  END IF;
  SELECT count(*) INTO v_n FROM public.promissory_notes n WHERE n.partner_name = 'DRYRUN Notice Probe';
  SELECT count(*) INTO v_m FROM public.promissory_note_pledge_notices x WHERE x.note_id IN (v_note, v_note2, v_note3);
  SELECT count(*) INTO v_k FROM public.promissory_house_booking_notices x WHERE x.note_id IN (v_note, v_note2, v_note3);
  o := o || format(E'\n%s S3.24 notice contacts (agent types %s''s phone in another format=%s + a DRYRUN email; and the DRYRUN phone): linked [%s] (want note:pledge, split:booking:booked, split:pledge, each fixture or another person, phone=t email=t not_typed=t; email = the login email); linked people have a login email=%s, their profile email is the login email=%s; unlinked note: %s (want nobody phone=t email=t); undone: probe notes=%s pledge notices=%s booking notices=%s (want 0, 0, 0)%s%s%s%s',
    CASE WHEN v_err IS NULL AND v_j ? 'ok' AND v_j2 ? 'ok' AND v_j3 ? 'ok' AND COALESCE(v_b4, false)
              AND v_t ~ '^note:pledge (fixture|another person) phone=t email=t not_typed=t \| split:booking:booked (fixture|another person) phone=t email=t not_typed=t \| split:pledge (fixture|another person) phone=t email=t not_typed=t$'
              AND v_t2 = 'nobody phone=t email=t' AND v_n = 0 AND v_m = 0 AND v_k = 0
         THEN 'PASS' ELSE 'FAIL' END,
    CASE v_who WHEN v_p20 THEN 'p20' WHEN v_staff_a THEN 'staff A' WHEN v_staff_b THEN 'staff B' ELSE 'none' END,
    COALESCE(v_b4::text, 'unknown'), COALESCE(v_t, ''), COALESCE(v_b5::text, 'unknown'), COALESCE(v_b6::text, 'unknown'),
    COALESCE(v_t2, 'missing'), v_n, v_m, v_k,
    CASE WHEN v_err IS NOT NULL THEN ' ERROR: ' || left(v_err, 300) ELSE '' END,
    pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2), pg_temp.dr_err(v_j3));

  -- (round 4) S3.25 partner_supported_house_returns for a note picked up by the caller's email but linked to someone
  --       else. Inside a savepoint undone straight after, the DRYRUN h6 note (linked to p20 in S3.15, at 20) is given
  --       the email of another real person (the first of pnew, signed, late, late2 with an email on the profile;
  --       else that person's phone as WhatsApp). That person's list shows the house with return_rate, monthly_return
  --       and annual_return null (keys present) and adds nothing to the totals; p20's list still shows 20; the note
  --       is unchanged afterwards. No contact is printed.
  v_who2 := NULL; v_mail := NULL; v_t := NULL; v_t2 := NULL; v_t3 := NULL; v_t6 := NULL; v_err := NULL; v_j := NULL; v_j2 := NULL;
  v_n := NULL; v_b := NULL; v_b2 := NULL; v_b3 := NULL; v_b4 := NULL;
  SELECT x.id, x.how INTO v_who2, v_t3 FROM (
    SELECT f.id, f.ord, CASE WHEN NULLIF(btrim(p.email), '') IS NOT NULL THEN 'email' ELSE 'phone' END AS how
      FROM unnest(ARRAY[v_pnew, v_signed, v_late, v_late2]) WITH ORDINALITY AS f(id, ord)
      JOIN public.profiles p ON p.id = f.id
     WHERE f.id IS DISTINCT FROM v_p20
       AND (NULLIF(btrim(p.email), '') IS NOT NULL OR length(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')) >= 9)) x
   ORDER BY x.how = 'email' DESC, x.ord LIMIT 1;
  SELECT md5(n::text) INTO v_mail FROM public.promissory_notes n WHERE n.id = v_ids_on[1];
  IF v_who2 IS NULL THEN
    v_err := 'none of pnew, signed, late, late2 has an email or a phone on the profile';
  ELSE
    BEGIN
      PERFORM pg_temp.dr_as(NULL);
      IF v_t3 = 'email' THEN
        UPDATE public.promissory_notes n SET email = (SELECT lower(btrim(p.email)) FROM public.profiles p WHERE p.id = v_who2)
         WHERE n.id = v_ids_on[1];
      ELSE
        UPDATE public.promissory_notes n SET whatsapp_number = (SELECT btrim(p.phone) FROM public.profiles p WHERE p.id = v_who2)
         WHERE n.id = v_ids_on[1];
      END IF;
      SELECT n.partner_user_id = v_p20 INTO v_b3 FROM public.promissory_notes n WHERE n.id = v_ids_on[1];
      v_j := pg_temp.dr_call(v_who2, 'SELECT public.partner_supported_house_returns()');
      v_j2 := pg_temp.dr_call(v_p20, 'SELECT public.partner_supported_house_returns()');
      SELECT count(*), bool_and(e ? 'return_rate' AND e ? 'monthly_return' AND e ? 'annual_return'),
             string_agg(format('%s/%s/%s', e -> 'return_rate', e -> 'monthly_return', e -> 'annual_return'), ',')
        INTO v_n, v_b, v_t
        FROM jsonb_array_elements(v_j -> 'ok' -> 'houses') e WHERE (e ->> 'note_id')::uuid = v_ids_on[1];
      v_b2 := (v_j -> 'ok' ->> 'total_monthly_return')::numeric
              = COALESCE((SELECT sum((e ->> 'monthly_return')::numeric) FROM jsonb_array_elements(v_j -> 'ok' -> 'houses') e
                           WHERE (e ->> 'note_id')::uuid <> v_ids_on[1]), 0)
          AND (v_j -> 'ok' ->> 'total_annual_return')::numeric
              = COALESCE((SELECT sum((e ->> 'annual_return')::numeric) FROM jsonb_array_elements(v_j -> 'ok' -> 'houses') e
                           WHERE (e ->> 'note_id')::uuid <> v_ids_on[1]), 0);
      SELECT string_agg((e -> 'return_rate')::text, ',') INTO v_t2
        FROM jsonb_array_elements(v_j2 -> 'ok' -> 'houses') e WHERE (e ->> 'note_id')::uuid = v_ids_on[1];
      RAISE EXCEPTION 'DR_UNDO';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'DR_UNDO' THEN v_err := SQLERRM; END IF;
    END;
  END IF;
  SELECT md5(n::text) = v_mail INTO v_b4 FROM public.promissory_notes n WHERE n.id = v_ids_on[1];
  o := o || format(E'\n%s S3.25 partner_supported_house_returns, h6 note linked to p20 picked up by %s of another person (%s): note still linked to p20=%s; their list: houses=%s return_rate/monthly/annual=%s keys present=%s, totals leave it out=%s; p20''s list return_rate=%s; note unchanged afterwards=%s (want true, 1, null/null/null, true, true, 20, true)%s%s%s',
    CASE WHEN v_err IS NULL AND v_b3 AND v_n = 1 AND v_t = 'null/null/null' AND v_b AND v_b2 AND v_t2 = '20' AND v_b4
         THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(v_t3, 'nothing'),
    CASE v_who2 WHEN v_pnew THEN 'pnew' WHEN v_signed THEN 'signed' WHEN v_late THEN 'late' WHEN v_late2 THEN 'late2' ELSE 'none' END,
    COALESCE(v_b3::text, 'unknown'), v_n, COALESCE(v_t, ''), COALESCE(v_b::text, 'unknown'), COALESCE(v_b2::text, 'unknown'),
    COALESCE(v_t2, ''), COALESCE(v_b4::text, 'unknown'),
    CASE WHEN v_err IS NOT NULL THEN ' ERROR: ' || left(v_err, 300) ELSE '' END, pg_temp.dr_err(v_j), pg_temp.dr_err(v_j2));
  o := o || format(E'\nINFO T3 switch-on section took %s ms', round(extract(epoch FROM clock_timestamp() - v_lap) * 1000));

  -- =====================================================================================
  -- S4. Integrity and monitoring
  -- =====================================================================================
  v_lap := clock_timestamp();
  BEGIN
    SET CONSTRAINTS ALL IMMEDIATE;   -- deferred FK on portfolio_rate_approvals and the ledger balance triggers
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  o := o || format(E'\n%s S4.1 deferred constraints (CFO request FK, ledger group balance) hold: %s',
                   CASE WHEN v_err IS NULL THEN 'PASS' ELSE 'FAIL' END, COALESCE(v_err, 'ok'));

  SELECT COALESCE(string_agg(x.k || '=' || x.n, ', ' ORDER BY x.k), 'none'), COALESCE(sum(x.n), 0) INTO v_t, v_n
    FROM (SELECT a.source || ':' || a.status AS k, count(*) AS n FROM public.portfolio_rate_approvals a GROUP BY 1) x;
  o := o || format(E'\n%s S4.2 CFO queue after the run: %s (want new_portfolio:pending=1, note_late_link:pending=1)',
                   CASE WHEN v_t = 'new_portfolio:pending=1, note_late_link:pending=1' AND v_n = 2 THEN 'PASS' ELSE 'FAIL' END, v_t);

  SELECT md5(string_agg(ip.id::text || ':' || ip.roi_percentage::text, ',' ORDER BY ip.id)), count(*)
    INTO v_hash_after, v_live_after FROM public.investor_portfolios ip WHERE ip.status IN ('active', 'locked');
  o := o || format(E'\n%s S4.3 every live portfolio kept its stored rate: %s live, md5 before=%s after=%s',
                   CASE WHEN v_hash_after = v_hash_before AND v_live_after = v_live_before THEN 'PASS' ELSE 'FAIL' END,
                   v_live_after, v_hash_before, v_hash_after);

  SELECT count(*) FILTER (WHERE c.ok), count(*), string_agg(c.check_name || ': ' || COALESCE(c.detail, ''), ' | ') FILTER (WHERE NOT c.ok)
    INTO v_n, v_m, v_t FROM public.assert_partner_return_policy_intact() c;
  o := o || format(E'\n%s S4.4 assert_partner_return_policy_intact: %s/%s ok (want 17/17)%s',
                   CASE WHEN v_m = 17 AND v_n = v_m THEN 'PASS' ELSE 'FAIL' END, v_n, v_m,
                   CASE WHEN v_t IS NOT NULL THEN ' failing: ' || v_t ELSE '' END);

  SELECT count(*), string_agg(c.issue || ':' || c.portfolio_id, ', ') INTO v_n, v_t FROM public.partner_rate_conformance(NULL) c;
  o := o || format(E'\n%s S4.5 partner_rate_conformance() rows=%s%s',
                   CASE WHEN v_n = 0 THEN 'PASS' ELSE 'FAIL' END, v_n, CASE WHEN v_t IS NOT NULL THEN ' ' || left(v_t, 300) ELSE '' END);

  v_n := public.record_partner_return_policy_drift();
  SELECT count(*) INTO v_m FROM public.money_path_drift_events e WHERE e.check_name LIKE 'partner\_rate.%' AND e.resolved_at IS NULL;
  o := o || format(E'\n%s S4.6 record_partner_return_policy_drift()=%s, open partner_rate events=%s (want 0, 0)',
                   CASE WHEN v_n = 0 AND v_m = 0 THEN 'PASS' ELSE 'FAIL' END, v_n, v_m);

  SELECT p.release_ready, p.enabled INTO v_b, v_ctx FROM public.partner_return_policy p WHERE p.id;
  o := o || format(E'\n%s S4.7 release_ready=%s (set by this rehearsal before S2; switch on=%s)', CASE WHEN v_b THEN 'PASS' ELSE 'FAIL' END, v_b, v_ctx);

  -- The legacy reward job's function on the real funded request (next payment). The stored-rate path is only
  -- reached once the payment is due; until then it must answer not_due and change nothing.
  SELECT rr.roi_payments_count, rr.next_roi_due_date INTO v_n, v_cutoff FROM public.rent_requests rr WHERE rr.id = v_rr;
  v_j := pg_temp.dr_call(NULL, format('SELECT public.post_rent_facilitation_reward(%L::uuid, %s)', v_rr, COALESCE(v_n, 0) + 1), 'owner');
  o := o || format(E'\n%s S4.8 post_rent_facilitation_reward(next payment %s, due %s): %s%s',
                   CASE WHEN v_j -> 'ok' ->> 'status' = 'not_due'
                          OR (v_j -> 'ok' ->> 'status' = 'posted' AND (v_j -> 'ok' ->> 'rate')::numeric = 15) THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_n, 0) + 1, v_cutoff, COALESCE(v_j -> 'ok', 'null'::jsonb), pg_temp.dr_err(v_j));

  -- What this transaction queued for the outside world (all discarded by the rollback).
  SELECT COALESCE(sum(s.n_tup_ins) FILTER (WHERE s.schemaname = 'net' AND s.relname = 'http_request_queue'), 0),
         COALESCE(sum(s.n_tup_ins) FILTER (WHERE s.schemaname = 'pgmq' AND s.relname LIKE 'q\_%'), 0),
         COALESCE(sum(s.n_tup_ins) FILTER (WHERE s.schemaname = 'public' AND s.relname = 'general_ledger'), 0),
         COALESCE(sum(s.n_tup_ins) FILTER (WHERE s.schemaname = 'public' AND s.relname = 'notifications'), 0)
    INTO v_n, v_m, v_k, v_rate FROM pg_stat_xact_all_tables s;
  o := o || format(E'\nINFO S4.9 queued in this transaction and discarded by the rollback: pg_net HTTP requests=%s, pgmq messages (emails)=%s, ledger rows=%s, notifications kept by the allowlist trigger=%s',
                   v_n, v_m, v_k, v_rate);
  o := o || format(E'\nINFO T4 integrity section took %s ms', round(extract(epoch FROM clock_timestamp() - v_lap) * 1000));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_ctx = PG_EXCEPTION_CONTEXT;
  o := o || format(E'\nFAIL ABORTED (everything after this point did not run): %s | at: %s', v_err, left(v_ctx, 400));
END main;

  v_ms := round(extract(epoch FROM clock_timestamp() - now()) * 1000);
  o := o || format(E'\n%s T elapsed since BEGIN (migrations + rehearsal): %s ms (target < 5000)',
                   CASE WHEN v_ms < 5000 THEN 'PASS' ELSE 'FAIL' END, v_ms);

  v_n := (length(o) - length(replace(o, E'\nPASS ', ''))) / length(E'\nPASS ');
  v_m := (length(o) - length(replace(o, E'\nFAIL ', ''))) / length(E'\nFAIL ');
  RAISE EXCEPTION 'DRYRUN_P2 %', format('pass=%s fail=%s', v_n, v_m) || o;
END $t$;
ROLLBACK;
