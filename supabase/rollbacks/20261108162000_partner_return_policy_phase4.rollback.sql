-- Rollback of 20261108162000_partner_return_policy_phase4.sql (Partner Returns Phase 4a).
--
-- STEP 1 IS NOT SQL. Lovable redeploys every edge function from `lovable` together, so a one-off redeploy
-- would be undone by the next bulk deploy. First commit a revert of supabase/functions/activate-promissory-note
-- and supabase/functions/lookup-promissory-note on `lovable` back to 5e2ad5e930's versions ONLY (never
-- origin's: origin's activate reads user_id from the request body and links with a service-role client, and
-- origin's lookup returns the note's full WhatsApp number and email; Lovable idle, Josh's go-ahead), revert in
-- the same commit the edge files that call
-- partner_confirmed_login_emails / profile_ids_by_emails / get_partner_return_report (they would degrade:
-- no email figures, per-partner email lookups failing in import-partners), wait for Lovable's deploy, and
-- check their ezbr_sha256. Remove get_my_new_portfolio_rate from agent-assistant/tools.ts too (then run the
-- 4a-assistant rollback).
-- STEP 2: roll back 4b first (supabase/rollbacks/20261108163000_partner_return_policy_phase4_masks.rollback.sql):
-- its readers call partner_rate_visible_to_caller, which this file drops. The block below refuses otherwise.
-- STEP 3: this file. Backfilled notice return_rate values stay (nullable metadata). The D3 link hold goes too
-- (trg_zz_guard_note_window_link, which also refuses agent changes that would open a note's window without
-- proof): after a cut-off, production's profile triggers then link pre-cut-off notes by unverified profile
-- phone / email again, and staff can move a linked note's agent freely; 'promissory_note_link_held' events
-- already written stay, and browsers can write that event type again (system_events_no_browser_link_held
-- is dropped). Phase 1's frozen note contacts (partner_return_note_windows.contact_phones / contact_email)
-- stay with the windows.
-- After the first switch-on (cut-off set) Phase 1's note guard refuses service-role linking, so the old
-- activate-promissory-note cannot link notes any more: rolling 4a back then leaves note linking to Partner
-- Ops (promissory_confirm_arrival_match). The block below warns.
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  v_still text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_still
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('get_portfolio_by_activation_token', 'agent_onboarded_portfolios', 'get_user_trust_profile',
                       'get_public_trust_profile', 'get_partner_wallet_hub')
     AND (position('partner_rate_visible_to_caller' in p.prosrc) > 0
          OR position('Partner Returns Phase 4b' in p.prosrc) > 0);
  IF to_regprocedure('public.partner_returns_visible_to_caller(uuid)') IS NOT NULL THEN
    v_still := concat_ws(', ', v_still, 'partner_returns_visible_to_caller');
  END IF;
  IF v_still IS NOT NULL THEN
    RAISE EXCEPTION '4a rollback refused: roll back 4b first (still masked by 4b: %)', v_still USING ERRCODE = '55000';
  END IF;
  IF (SELECT p.cutoff_at FROM public.partner_return_policy p WHERE p.id) IS NOT NULL THEN
    RAISE WARNING '4a rollback after the Partner Returns cut-off: the old activate-promissory-note cannot link notes (Phase 1 guard); Partner Ops must link them';
  END IF;
END $pre$;

-- The assert back to Phase 2's body (20261108161000), verbatim: the Phase 4 hook line removed.
CREATE OR REPLACE FUNCTION public.assert_partner_return_policy_intact()
 RETURNS TABLE(check_name text, ok boolean, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol   public.partner_return_policy%ROWTYPE;
  v_src   text;
  v_bad   integer;
BEGIN
  SELECT * INTO v_pol FROM public.partner_return_policy WHERE id;
  RETURN QUERY SELECT 'policy_row_exists', v_pol.id IS NOT NULL, 'partner_return_policy must hold exactly one row';

  RETURN QUERY SELECT 'gate_trigger_enabled',
    EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_rate_policy' AND t.tgenabled <> 'D')
    AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_carry_guard' AND t.tgenabled <> 'D'),
    'every new portfolio must pass the Partner Returns gate';

  RETURN QUERY SELECT 'rate_has_no_default',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
               AND c.column_name = 'roi_percentage' AND c.column_default IS NULL AND c.is_nullable = 'NO'),
    'the portfolio Returns rate must be required and have no default (the gate fills it)';

  RETURN QUERY SELECT 'decision_stamp_columns',
    (SELECT count(*) = 4 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
        AND c.column_name IN ('entitled_rate', 'rate_basis', 'rate_decided_at', 'rate_existing_at_decision')),
    'each portfolio must record the rate it was entitled to and why';

  RETURN QUERY SELECT 'note_rate_column',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'promissory_notes'
               AND c.column_name = 'return_rate' AND c.is_nullable = 'NO'),
    'each promissory note must record its Returns rate';

  RETURN QUERY SELECT 'note_triggers_enabled',
    (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = 'public.promissory_notes'::regclass
       AND t.tgname IN ('trg_zz_stamp_note_return_rate', 'trg_zz_guard_note_return_rate') AND t.tgenabled <> 'D'),
    'promissory notes must be stamped at insert and guarded on update';

  RETURN QUERY SELECT 'cutoff_guards_enabled',
    (SELECT count(*) = 4 FROM pg_trigger t
      WHERE t.tgname IN ('trg_partner_return_policy_guard', 'trg_partner_return_cohort_guard',
                         'trg_partner_return_note_windows_guard', 'trg_partner_return_legacy_guard') AND t.tgenabled <> 'D'),
    'the cut-off, the existing-partner list, the note windows and the legacy list must be protected';

  RETURN QUERY SELECT 'cutoff_set_when_enabled',
    (NOT COALESCE(v_pol.enabled, false))
      OR (v_pol.cutoff_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.partner_return_cohort)),
    'with the switch on, the cut-off must be set and the existing-partner list filled';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'set_partner_return_policy' LIMIT 1;
  RETURN QUERY SELECT 'switch_ceo_only',
    v_src IS NOT NULL AND position('ARRAY[''ceo'']' in v_src) > 0
      AND v_src !~ 'ARRAY\[[^]]*''cfo''',
    'only the CEO may turn the switch on or off';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'apply_portfolio_renewal' LIMIT 1;
  RETURN QUERY SELECT 'renewal_keeps_rate',
    v_src IS NOT NULL
      AND v_src !~* 'update\s+(public\.)?investor_portfolios(\s+(as\s+)?\w+)?\s+set\s+([^;]*?,\s*)?(\w+\.)?roi_percentage\s*=',
    'a renewal must keep the portfolio''s stored rate';

  SELECT count(*) INTO v_bad FROM public.partner_rate_conformance(NULL);
  RETURN QUERY SELECT 'rates_conform', v_bad = 0,
    v_bad || ' portfolio(s) since the cut-off have a Returns rate that does not match what they were entitled to (see partner_rate_conformance())';

  RETURN QUERY SELECT 'cron_jobs_scheduled',
    CASE WHEN to_regclass('cron.job') IS NULL THEN false
         ELSE (SELECT count(*) = 2 FROM cron.job j
                WHERE j.jobname IN ('apply-portfolio-rate-changes-705pm', 'partner-rate-drift-check') AND j.active) END,
    'the next-cycle job and the drift check must be scheduled';
  -- Phase 2: every creation path leaves the rate to the gate (or types it on purpose, which the
  -- gate checks), and nothing quotes a fixed 15% any more.
  SELECT count(*) INTO v_bad
    FROM (VALUES ('funder_create_pending_portfolio'), ('psm_confirm_commitment_for'),
                 ('partner_support_houses'), ('countersign_prepare_support')) f(fn)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn)
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f.fn
                    AND p.prosrc ~* 'insert\s+into\s+(public\.)?investor_portfolios\s*\([^)]*roi_percentage');
  RETURN QUERY SELECT 'creation_paths_leave_rate_to_gate', v_bad = 0,
    v_bad || ' creation function(s) are missing or type a Returns rate themselves (they must let the gate decide)';

  SELECT count(*) INTO v_bad
    FROM (VALUES ('psm_confirm_commitment_for', 'partner_rate_now'), ('partner_support_houses', 'partner_rate_now'),
                 ('get_countersign_summary', 'partner_rate_now'), ('hr_pay_post_staff_reinvestment', 'partner_rate_context'),
                 ('agent_list_empty_house_opportunities', 'partner_quote_rate'),
                 ('empty_house_opportunity_summary', 'partner_quote_rate'),
                 ('post_rent_facilitation_reward', 'rent_facilitation_reward_rates')) f(fn, must)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn)
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f.fn AND position(f.must in p.prosrc) = 0);
  RETURN QUERY SELECT 'creation_paths_use_rule', v_bad = 0,
    v_bad || ' function(s) no longer take their rate from the Partner Returns rule';

  SELECT count(*) INTO v_bad
    FROM (VALUES ('enqueue_funder_house_notice'), ('get_or_create_house_share_link'), ('get_supporter_pool_stats'),
                 ('agent_create_promissory_note_for_houses'), ('agent_create_promissory_note'),
                 ('psm_queue_promissory_pledge_notice'), ('post_rent_facilitation_reward'),
                 ('agent_list_empty_house_opportunities'), ('empty_house_opportunity_summary'),
                 ('get_or_create_plan_share_link'), ('public_house_support_offer'), ('public_support_plan'),
                 ('hr_pay_post_staff_reinvestment'), ('partner_supported_house_returns')) f(fn)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn)
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f.fn
                    AND p.prosrc ~ '0\.15|\m(15|20)%');
  RETURN QUERY SELECT 'quotes_use_stored_or_public_rate', v_bad = 0,
    v_bad || ' quote/notice function(s) are missing or still use a fixed Returns rate';

  RETURN QUERY SELECT 'phase2_triggers_enabled',
    (SELECT count(*) = 3 FROM pg_trigger t
      WHERE t.tgname IN ('trg_zz_partner_note_linked_late', 'trg_zz_stamp_rent_reward_rate_ins',
                         'trg_zz_stamp_rent_reward_rate_upd') AND t.tgenabled <> 'D'),
    'late-linked promissory notes and legacy rent-facilitation fundings must be decided by the rule';

  RETURN QUERY SELECT 'release_ready', COALESCE(v_pol.release_ready OR NOT v_pol.enabled, true),
    'the switch may only be on after the release marked every creation path, agreement, edge function and screen ready (ready='
      || COALESCE(v_pol.release_ready::text, 'unknown') || ')';
END $function$;
REVOKE ALL ON FUNCTION public.assert_partner_return_policy_intact() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_partner_return_policy_intact() TO service_role;

-- The Phase 4 objects. No CASCADE: a dependency that is not expected must stop the rollback.
DROP TRIGGER IF EXISTS trg_portfolio_rate_requests_stamp_actor ON public.portfolio_rate_approvals;
DROP TRIGGER IF EXISTS trg_zz_guard_note_window_link ON public.promissory_notes;
DROP POLICY IF EXISTS system_events_no_browser_link_held ON public.system_events;
DROP FUNCTION IF EXISTS public.guard_note_window_link();
DROP FUNCTION IF EXISTS public.activate_promissory_note(text);
DROP FUNCTION IF EXISTS public._note_contact_proven(uuid, uuid);
DROP FUNCTION IF EXISTS public.lookup_promissory_note(text);
DROP FUNCTION IF EXISTS public._promissory_note_rate_view(public.promissory_notes, uuid);
DROP FUNCTION IF EXISTS public.portfolio_rate_requests_stamp_actor();
DROP FUNCTION IF EXISTS public.partner_confirmed_login_emails(uuid[]);
DROP FUNCTION IF EXISTS public.profile_ids_by_emails(text[]);
DROP FUNCTION IF EXISTS public.get_partner_return_report(date, date);
DROP FUNCTION IF EXISTS public._partner_return_phase4_checks(boolean);
DROP FUNCTION IF EXISTS public._promissory_note_funded_house_rates(uuid, uuid);
DROP FUNCTION IF EXISTS public.partner_rate_visible_to_caller(uuid);
