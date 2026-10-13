-- ═══════════════════════════════════════════════════════════════════════════
-- Food M1 — production READ-ONLY evidence pack (for an authorised operator)
-- ═══════════════════════════════════════════════════════════════════════════
-- Prepared 2026-10-13 against release candidate a3f41d3cdc (+ the reversal fix
-- on top of it). NOT run by the assistant: no production access was available.
--
-- HOW TO RUN
--   * As a read-only role (not service_role, not postgres), in the SQL editor
--     or psql. The session is set to default_transaction_read_only, so every
--     statement is read-only and cannot write even if one tried to.
--   * Catalogue queries only, plus three aggregate COUNTs (E5). No personal
--     records, names, phone numbers, amounts per person or balances are read.
--   * Return the complete output verbatim (pg_get_functiondef text included).
--     Do not edit it; definitions are compared line by line with the repo.
--
-- EVIDENCE CLASSES
--   Output of this pack = operator-supplied PRODUCTION evidence.
--   Everything quoted in the comments ("repo:") = REPOSITORY evidence only.
--
-- WHAT THE WHOLE PACK CANNOT PROVE
--   Definitions show what code exists, not that every path behaves as read
--   (e.g. data-dependent branches, settings set per role or per database,
--   edge-function code, which is checked separately in E7).
-- ═══════════════════════════════════════════════════════════════════════════

-- Every statement below runs in its own READ-ONLY transaction (the session
-- default), so it cannot write, and one statement's error (e.g. an object that
-- does not exist) does not hide the output of the others.
SET default_transaction_read_only = on;
SET statement_timeout = '60s';

-- ─────────────────────────────────────────────────────────────────────────
-- E0. Context: which database and role this output came from
--   PROVES: the output belongs to the intended project and was taken read-only.
--   CANNOT PROVE: anything about objects.
SELECT current_database() AS db, current_user AS role, session_user AS login_role, now() AS taken_at,
       current_setting('transaction_read_only') AS read_only,
       current_setting('default_transaction_read_only') AS default_read_only, version();

-- E0b. Proof that writes are rejected in this session.
--   Expected output: ERROR  25006  cannot execute CREATE TABLE in a read-only transaction.
--   The block ALWAYS ends in an exception, so even if read-only were somehow
--   not in force, everything it did is rolled back: it can never leave an
--   object behind. If the output is instead 'READ_ONLY_NOT_ENFORCED', stop and
--   report it: the session is not read-only and nothing further should run.
--   PROVES: this session cannot write.  CANNOT PROVE: anything about objects.
DO $probe$
BEGIN
  CREATE TABLE public.food_m1_readonly_probe_do_not_create (x int);
  RAISE EXCEPTION 'READ_ONLY_NOT_ENFORCED (rolled back; nothing was kept)';
END
$probe$;

-- ─────────────────────────────────────────────────────────────────────────
-- E1. Recipient eligibility (C-P2)
--   repo: drizzle/migrations/0045 — check_transfer_recipient_eligibility(
--         p_recipient_id uuid, p_item text DEFAULT NULL, p_sender_id uuid DEFAULT NULL)
--         RETURNS TABLE(eligible boolean, reason text, display_name text, has_wallet boolean),
--         SECURITY DEFINER, EXECUTE to authenticated + service_role.
--   Food a3f41d3cdc calls it BY NAME with exactly those argument names.
--   PROVES: whether the live function exists with that exact signature, its body
--           (frozen / closed / self / no-account rules), owner and grants.
--   CANNOT PROVE: that wallet-transfer as deployed calls it (see E7).
SELECT p.oid::regprocedure AS signature, pg_get_function_result(p.oid) AS returns,
       p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS owner, p.proacl AS grants,
       p.proconfig AS settings, pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('check_transfer_recipient_eligibility', 'welile_transfer_items',
                     'is_fraud_identifier_blocked', 'fraud_block_user_identifiers');
--   repo: fraud_block_user_identifiers (20260706131556:143) sets profiles.is_frozen.
--   PROVES (next): the columns the eligibility rule reads exist.
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'profiles' AND column_name IN ('is_frozen', 'deleted_at', 'frozen_reason'))
     OR (table_name = 'wallets' AND column_name = 'user_id'))
 ORDER BY 1, 2;

-- ─────────────────────────────────────────────────────────────────────────
-- E2. Food M1 presence and migration status
--   Expected today: NO Food objects and NO Food versions (never deployed).
--   PROVES: whether any Food migration or object already exists in production
--           (a partial earlier apply would change the deployment plan), and
--           whether the renumbered versions are free.
--   CANNOT PROVE: anything about future apply order (that is the release plan).
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE version IN ('20261009120000', '20261009120001', '20261009130000', '20261009130001',
                   '20261009160000', '20261009170000', '20261012120000', '20261013120000',
                   '20261013120001', '20261013125000', '20261013126000', '20261013127000',
                   '20261013128000')
 ORDER BY version;
--   (20261009120000, 20261009130000, 20261013120000 are EXPECTED to exist: they
--    are lovable's Apophia, Emma and CTO-report migrations. Food uses …0001.)
SELECT max(version) AS latest_applied_version FROM supabase_migrations.schema_migrations;
SELECT c.relname, c.relkind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname LIKE 'food\_%' ORDER BY 1;
--   (the release adds, among others: food_orders, food_order_events, food_audit,
--    food_payment_attempts; none is expected to exist yet)
SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner) AS owner, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND (p.proname LIKE 'food\_%' OR p.proname IN ('post_portfolio_roi_ledger', '_ledger_can_post_partner_returns'))
 ORDER BY 1;

-- ─────────────────────────────────────────────────────────────────────────
-- E3. Balance, holds, advance lock and advance recovery (C-P1)
--   repo: get_user_available_balance (20260824072654:44) =
--         GREATEST(0, wallet_balances_projection.withdrawable - funder_pending_hold
--                     - CASE advance_withdrawals_paused THEN get_advance_locked_withdrawable END);
--         get_agent_sweepable_withdrawable (20260719161607:5) shields wallet_transfer
--         cash_in since the oldest active advance; tg_recover_advance_arrears_on_earning
--         (20260808064247:641) fires on commission categories only.
--   PROVES: the live bodies Food relies on (Food calls get_user_available_balance
--           as-is) and whether recovery treats wallet_transfer credits as the
--           repo does (no Food exemption, no extra protection).
--   CANNOT PROVE: edge-function recovery logic (process-agent-advance-deductions)
--                 as deployed; see E7.
SELECT p.oid::regprocedure, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proacl,
       pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('get_user_available_balance', 'funder_pending_hold', 'get_advance_locked_withdrawable',
                     'get_agent_sweepable_withdrawable', 'recover_agent_arrears_from_credit',
                     'tg_recover_advance_arrears_on_earning', 'sweep_agent_advance_recovery',
                     'enforce_no_fraud_wallet_earnings')
 ORDER BY 1;
--   Treasury controls Food reads (structure + flags; no personal data).
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'treasury_controls' ORDER BY ordinal_position;
SELECT control_key, enabled, value
  FROM public.treasury_controls
 WHERE control_key IN ('maintenance_mode', 'maintenance_until', 'withdrawals_paused',
                       'credits_paused', 'advance_withdrawals_paused');

-- ─────────────────────────────────────────────────────────────────────────
-- E4. Ledger posting: every create_ledger_transaction overload and every
--     trigger on general_ledger (C-P3)
--   repo: latest 3-arg definition 20260914180000 (ledger.authorized, advisory
--         lock + replay on idempotency_key, positive amounts, routing check,
--         withdrawable balance check, balanced group).
--   PROVES: all live overloads, owners and grants; every trigger and its
--           function body (incl. any production-only gate such as the TID float
--           gate) that fires for a Food posting exactly as for wallet-transfer.
--   CANNOT PROVE: per-role/per-database settings read via current_setting()
--                 at run time (E4c lists database/role settings).
SELECT p.oid::regprocedure, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proacl,
       pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'create\_ledger\_transaction%'
 ORDER BY 1;
SELECT t.tgname, t.tgenabled, t.tgfoid::regprocedure AS trigger_function, pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.general_ledger'::regclass AND NOT t.tgisinternal
 ORDER BY t.tgname;
SELECT DISTINCT p.oid::regprocedure, pg_get_functiondef(p.oid) AS definition
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE t.tgrelid = 'public.general_ledger'::regclass AND NOT t.tgisinternal;
-- E4b. any function mentioning the TID-backed float gate
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosrc ILIKE '%tid_backed%' ORDER BY 1;
-- E4c. database / role level settings a function might read
SELECT coalesce(r.rolname, '(all roles)') AS role, coalesce(d.datname, '(all dbs)') AS db, s.setconfig
  FROM pg_db_role_setting s
  LEFT JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase;

-- ─────────────────────────────────────────────────────────────────────────
-- E5. Standard wallet-transfer reversal mechanism and its recorded effects
--   repo: drizzle 0451 reverse_wallet_transfer(p_reference text): sender only,
--         posts two wallet_transfer legs with reference_id = <ref>||'-REV' and
--         idempotency_key = 'reversal:'||<ref>, amount = least(sent, recipient's
--         available) (can be partial), closed once the recipient has withdrawn.
--         0453 wallet_transfer_reversal_status. Food reads exactly those two signals.
--   PROVES: the live bodies match (so Food's detection is reliable); the live
--           reversal really uses those two signals (aggregate counts, no rows).
--   CANNOT PROVE: UI behaviour; reversals by any other mechanism (E5c looks for
--                 other functions writing '-REV').
SELECT p.oid::regprocedure, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proacl,
       pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('reverse_wallet_transfer', 'wallet_transfer_reversal_status',
                     'wallet_transfer_reversal_states', 'lock_wallet_for_transfer_reversal')
 ORDER BY 1;
-- E5b. aggregate only: how reversal legs are actually recorded
SELECT count(*)                                                        AS reversal_legs,
       count(*) FILTER (WHERE idempotency_key LIKE 'reversal:%')        AS with_reversal_key,
       count(*) FILTER (WHERE idempotency_key = 'reversal:' || left(reference_id, length(reference_id) - 4))
                                                                       AS key_matches_reference,
       count(DISTINCT source_table)                                     AS distinct_source_tables
  FROM public.general_ledger
 WHERE category = 'wallet_transfer' AND reference_id LIKE '%-REV';
-- E5c. any other function that writes a '-REV' reference
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosrc LIKE '%-REV%' ORDER BY 1;

-- ─────────────────────────────────────────────────────────────────────────
-- E6. Permission impact of 20261013126000 (revokes EXECUTE on
--     create_ledger_transaction% from PUBLIC, anon, authenticated)
--   PROVES: who can execute today; which functions call the ledger as
--           SECURITY INVOKER (those would fail for user-session callers after
--           the revoke); the owner that definer callers (incl. Food) run as.
--   CANNOT PROVE: edge functions or browser code that call the ledger RPC
--                 directly with a user JWT (repo search: only COOPartnersPage,
--                 rerouted in af745b3); confirm in E7.
SELECT p.oid::regprocedure,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role_exec,
       pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'create\_ledger\_transaction%';
SELECT p.oid::regprocedure, p.prosecdef AS security_definer,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosrc ILIKE '%create_ledger_transaction%'
   AND p.proname NOT LIKE 'create\_ledger\_transaction%'
   AND NOT p.prosecdef          -- invoker functions only: these break after the revoke
 ORDER BY 1;
-- E6b. Definer callers (including, once deployed, food_pay_order) run the
--   ledger function AS THEIR OWNER. After the revoke from PUBLIC an owner
--   keeps EXECUTE only by owning the ledger function, being superuser, or
--   holding an explicit (or role-inherited) grant. Any row with
--   keeps_execute_without_public = false would break.
--   PROVES: whether the revoke would break any existing definer caller.
--   CANNOT PROVE: the owner the Food migrations will get (that is the role
--   that applies them; E6c shows who owns existing functions).
WITH ledger AS (
  SELECT p.oid, p.proowner, coalesce(p.proacl, acldefault('f', p.proowner)) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE 'create\_ledger\_transaction%'
), callers AS (
  SELECT p.oid, p.proowner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef AND p.prosrc ILIKE '%create_ledger_transaction%'
     AND p.proname NOT LIKE 'create\_ledger\_transaction%'
)
SELECT pg_get_userbyid(c.proowner) AS caller_owner, count(*) AS definer_callers, l.oid::regprocedure AS ledger_function,
       bool_or(c.proowner = l.proowner
               OR (SELECT rolsuper FROM pg_roles WHERE oid = c.proowner)
               OR EXISTS (SELECT 1 FROM aclexplode(l.acl) a
                           WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 0
                             AND pg_has_role(c.proowner, a.grantee, 'USAGE'))) AS keeps_execute_without_public
  FROM callers c CROSS JOIN ledger l
 GROUP BY c.proowner, l.oid ORDER BY 1, 3;
-- E6c. Who owns functions in public (the role migrations run as)
SELECT pg_get_userbyid(p.proowner) AS owner, count(*) AS functions,
       count(*) FILTER (WHERE p.prosecdef) AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' GROUP BY p.proowner ORDER BY 2 DESC;

RESET statement_timeout;

-- ─────────────────────────────────────────────────────────────────────────
-- E7. Not SQL: deployed edge-function source. See
--     docs/food-m1-production-evidence-and-isolation.md for the exact
--     read-only export request to the Lovable agent.
--   PROVES: the deployed standard path matches the repo copy compared here.
