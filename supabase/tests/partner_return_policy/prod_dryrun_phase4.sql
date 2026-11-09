-- Phase 4 (Partner Returns: 4a, 4a-assistant, 4b) production rehearsal, design v2 §10.3. NEVER COMMITS. Counts only:
-- no names, no person ids, no contacts, no rates of named people in the output.
-- (Replaces the 5 Nov file of the superseded per-contract design.)
--
-- Run in ONE transaction, ONLY with the owner's go-ahead. Part A (up to the line that opens part B) only reads the
-- catalogue and must run BEFORE the migrations; part B is everything after that line:
--   BEGIN;
--   SET LOCAL statement_timeout = '60s';
--   <part A of this file>
--   <supabase/migrations/20261108160000_partner_return_policy_phase1.sql>
--   <supabase/migrations/20261108161000_partner_return_policy_phase2.sql>
--   <supabase/migrations/20261108162000_partner_return_policy_phase4.sql>
--   <supabase/migrations/20261108162500_assistant_partner_new_portfolio_rate.sql>
--   <supabase/pending/20261108163000_partner_return_policy_phase4_masks.sql>
--   <part B of this file>
--   ROLLBACK;
-- Part B always ends in RAISE EXCEPTION 'DRYRUN_P4 pass=.. fail=..' (PASS/FAIL/INFO lines in the message), which aborts
-- the transaction; the trailing ROLLBACK is a second belt. Rehearsed locally by run_phase4_tests.sh dryrun (stub data).
-- Expected FAILs in production today: note_browser_writes_closed for release (security migration 20261106200000 not
-- applied: insert policy present, trg_guard_note_direct_edit absent).

-- ============================== PART A (before the migrations) ==============================
CREATE TEMP TABLE _dry4 (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO _dry4
SELECT 'a_roi_default', COALESCE((SELECT c.column_default FROM information_schema.columns c
                                   WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios' AND c.column_name = 'roi_percentage'), 'none')
UNION ALL
SELECT 'a_claim_cycle_reads_rate', COALESCE((SELECT (position('roi_percentage' in p.prosrc) > 0)::text FROM pg_proc p
                                              JOIN pg_namespace ns ON ns.oid = p.pronamespace
                                             WHERE ns.nspname = 'public' AND p.proname = '_claim_return_cycle' LIMIT 1), 'missing')
UNION ALL
SELECT 'a_reward_has_amount', COALESCE((SELECT (position('''amount''' in p.prosrc) > 0)::text FROM pg_proc p
                                         JOIN pg_namespace ns ON ns.oid = p.pronamespace
                                        WHERE ns.nspname = 'public' AND p.proname = 'post_rent_facilitation_reward' LIMIT 1), 'missing')
UNION ALL
SELECT 'a_reader:' || f.fn, md5(pg_get_functiondef(f.fn::regprocedure)) || '|' || COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = f.fn::regprocedure), '-')
  FROM (VALUES ('public.get_portfolio_by_activation_token(uuid)'), ('public.agent_onboarded_portfolios()'),
               ('public.get_user_trust_profile(text)'), ('public.get_public_trust_profile(text)'),
               ('public.get_partner_wallet_hub(uuid,integer,integer)')) f(fn)
UNION ALL
SELECT 'a_phase4_names_present', (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname IN ('lookup_promissory_note', 'activate_promissory_note', 'partner_rate_visible_to_caller',
     '_promissory_note_rate_view', 'portfolio_rate_requests_stamp_actor', 'partner_confirmed_login_emails', 'profile_ids_by_emails',
     '_partner_return_phase4_checks', 'get_partner_return_report', 'assistant_partner_new_portfolio_rate',
     '_note_contact_proven', 'guard_note_window_link', '_promissory_note_funded_house_rates', 'partner_returns_visible_to_caller'))
UNION ALL
SELECT 'a_open_booking', (SELECT count(*)::text FROM public.promissory_house_booking_notices b WHERE b.sms_sent_at IS NULL OR b.email_sent_at IS NULL)
UNION ALL
SELECT 'a_open_pledge', (SELECT count(*)::text FROM public.promissory_note_pledge_notices p WHERE p.sms_status = 'pending' OR p.email_status = 'pending');

-- ============================== PART B (after Phase 1, 2, 4a, 4a-assistant, 4b) ==============================
DO $t$
DECLARE
  o    text := '';
  v_n  integer := 0;   -- pass
  v_m  integer := 0;   -- fail
  r    record;
  v    text;
  j    jsonb;
  v_k  integer;
BEGIN
  -- helper pattern: o := o || line; counts kept in v_n / v_m
  -- 0. Part A facts (§2.6 extra asserts)
  v := (SELECT d.v FROM _dry4 d WHERE d.k = 'a_roi_default');
  IF v ~ '^\(?15(\.0+)?\)?(::numeric)?$' THEN v_n := v_n + 1; o := o || E'\nPASS  A1 investor_portfolios.roi_percentage default before Phase 1: ' || v;
  ELSE v_m := v_m + 1; o := o || E'\nFAIL  A1 investor_portfolios.roi_percentage default before Phase 1 is not 15: ' || v; END IF;
  v := (SELECT d.v FROM _dry4 d WHERE d.k = 'a_claim_cycle_reads_rate');
  IF v = 'true' THEN v_n := v_n + 1; o := o || E'\nPASS  A2 _claim_return_cycle reads roi_percentage (the stored rate)';
  ELSE v_m := v_m + 1; o := o || E'\nFAIL  A2 _claim_return_cycle source does not contain roi_percentage: ' || v; END IF;
  v := (SELECT d.v FROM _dry4 d WHERE d.k = 'a_reward_has_amount');
  IF v = 'true' THEN v_n := v_n + 1; o := o || E'\nPASS  A3 production post_rent_facilitation_reward builds a result with an amount key';
  ELSE v_m := v_m + 1; o := o || E'\nFAIL  A3 production post_rent_facilitation_reward has no amount key: ' || v; END IF;
  v := (SELECT d.v FROM _dry4 d WHERE d.k = 'a_phase4_names_present');
  IF v = '0' THEN v_n := v_n + 1; o := o || E'\nPASS  A4 none of the fourteen Phase 4 functions existed before';
  ELSE v_m := v_m + 1; o := o || E'\nFAIL  A4 Phase 4 function names already present before the build: ' || v; END IF;

  -- 1. The assert and Phase 4's checks
  SELECT count(*)::text || '/' || COALESCE(string_agg(c.check_name, ',' ORDER BY c.check_name) FILTER (WHERE NOT c.ok), 'all ok') INTO v
    FROM public.assert_partner_return_policy_intact() c;
  IF v IN ('26/all ok', '26/open_notices_carry_rate') THEN v_n := v_n + 1; ELSE v_m := v_m + 1; END IF;
  o := o || E'\n' || CASE WHEN v IN ('26/all ok', '26/open_notices_carry_rate') THEN 'PASS' ELSE 'FAIL' END
         || '  B1 assert after the build (rows/failing; open_notices_carry_rate may fail for a mixed-rate funded notice): ' || v;
  SELECT COALESCE(string_agg(c.check_name || '=' || c.detail, '; ' ORDER BY c.check_name) FILTER (WHERE NOT c.ok), 'all ok') INTO v
    FROM public._partner_return_phase4_checks(false) c;
  o := o || E'\nINFO  B2 Phase 4 checks failing now: ' || v;
  SELECT COALESCE(string_agg(c.check_name, ',' ORDER BY c.check_name) FILTER (WHERE NOT c.ok), 'none') INTO v
    FROM public._partner_return_phase4_checks(true) c;
  o := o || E'\nINFO  B3 Phase 4 checks that still block release_ready: ' || v;

  -- 2. Notice backfill (counts)
  o := o || E'\nINFO  B4 unsent booking notices before / now with a rate / now without: ' || (SELECT d.v FROM _dry4 d WHERE d.k = 'a_open_booking') || ' / '
         || (SELECT count(*) FROM public.promissory_house_booking_notices b WHERE (b.sms_sent_at IS NULL OR b.email_sent_at IS NULL) AND b.return_rate IS NOT NULL) || ' / '
         || (SELECT count(*) FROM public.promissory_house_booking_notices b WHERE (b.sms_sent_at IS NULL OR b.email_sent_at IS NULL) AND b.return_rate IS NULL)
         || ' (by kind without: ' || COALESCE((SELECT string_agg(x.kind || '=' || x.n, ',' ORDER BY x.kind) FROM (SELECT b.kind, count(*) AS n FROM public.promissory_house_booking_notices b
              WHERE (b.sms_sent_at IS NULL OR b.email_sent_at IS NULL) AND b.return_rate IS NULL GROUP BY b.kind) x), 'none') || ')';
  o := o || E'\nINFO  B5 pending pledge notices before / now without a rate: ' || (SELECT d.v FROM _dry4 d WHERE d.k = 'a_open_pledge') || ' / '
         || (SELECT count(*) FROM public.promissory_note_pledge_notices p WHERE (p.sms_status = 'pending' OR p.email_status = 'pending') AND p.return_rate IS NULL);
  o := o || E'\nINFO  B6 unsent house-progress notices with / without a rate: '
         || (SELECT count(*) FILTER (WHERE f.return_rate IS NOT NULL) || ' / ' || count(*) FILTER (WHERE f.return_rate IS NULL)
               FROM public.funder_house_progress_notices f WHERE f.sms_sent_at IS NULL OR f.email_sent_at IS NULL);
  SELECT string_agg(trim_scale(x.rate)::text || 'x' || x.n, ',' ORDER BY x.rate) INTO v
    FROM (SELECT b.return_rate AS rate, count(*) AS n FROM public.promissory_house_booking_notices b
           WHERE (b.sms_sent_at IS NULL OR b.email_sent_at IS NULL) AND b.return_rate IS NOT NULL GROUP BY 1) x;
  IF v IS NULL OR v ~ '^15x[0-9]+$' THEN v_n := v_n + 1; o := o || E'\nPASS  B7 every backfilled unsent booking notice states 15 (switch off): ' || COALESCE(v, 'none');
  ELSE v_m := v_m + 1; o := o || E'\nFAIL  B7 backfilled booking notices state rates other than 15 with the switch off: ' || v; END IF;

  -- 3. Grants (§2.4), with production's default ACL
  SELECT string_agg(m.fn || ' ' || has_function_privilege('anon', m.fn, 'EXECUTE') || '/' || has_function_privilege('authenticated', m.fn, 'EXECUTE') || '/'
                    || has_function_privilege('service_role', m.fn, 'EXECUTE'), '; ') FILTER (
           WHERE has_function_privilege('anon', m.fn, 'EXECUTE') IS DISTINCT FROM m.a
              OR has_function_privilege('authenticated', m.fn, 'EXECUTE') IS DISTINCT FROM m.u
              OR has_function_privilege('service_role', m.fn, 'EXECUTE') IS DISTINCT FROM m.s)
    INTO v
    FROM (VALUES ('public.partner_rate_visible_to_caller(uuid)', false, false, true),
                 ('public._promissory_note_rate_view(public.promissory_notes,uuid)', false, false, false),
                 ('public.lookup_promissory_note(text)', true, true, true),
                 ('public.activate_promissory_note(text)', false, true, false),
                 ('public.partner_confirmed_login_emails(uuid[])', false, false, true),
                 ('public.profile_ids_by_emails(text[])', false, false, true),
                 ('public._partner_return_phase4_checks(boolean)', false, false, true),
                 ('public.get_partner_return_report(date,date)', false, false, true),
                 ('public.assistant_partner_new_portfolio_rate()', false, true, false),
                 ('public.assert_partner_return_policy_intact()', false, false, true),
                 ('public.get_portfolio_by_activation_token(uuid)', true, true, true),
                 ('public.agent_onboarded_portfolios()', false, true, true),
                 ('public.get_user_trust_profile(text)', false, true, true),
                 ('public.get_partner_wallet_hub(uuid,integer,integer)', false, true, true),
                 ('public.get_public_trust_profile(text)', true, true, true)) m(fn, a, u, s);
  IF v IS NULL THEN v_n := v_n + 1; o := o || E'\nPASS  B8 grants matrix §2.4 (anon/authenticated/service_role) holds for all 15 functions';
  ELSE v_m := v_m + 1; o := o || E'\nFAIL  B8 grants differ from §2.4: ' || v; END IF;
  IF has_function_privilege('anon', 'public.portfolio_rate_requests_stamp_actor()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portfolio_rate_requests_stamp_actor()', 'EXECUTE') THEN
    v_m := v_m + 1; o := o || E'\nFAIL  B9 the requester trigger function is callable by a browser role';
  ELSE v_n := v_n + 1; o := o || E'\nPASS  B9 the requester trigger function is not callable by anon or authenticated'; END IF;

  -- 4. The five readers: 4b marker, ACL unchanged
  SELECT count(*) FILTER (WHERE position('Partner Returns Phase 4b' in p.prosrc) > 0
                            AND split_part(d.v, '|', 2) = COALESCE(p.proacl::text, '-')) INTO v_k
    FROM _dry4 d JOIN pg_proc p ON p.oid = substr(d.k, 10)::regprocedure WHERE d.k LIKE 'a_reader:%';
  IF v_k = 5 THEN v_n := v_n + 1; o := o || E'\nPASS  B10 the five readers carry the 4b marker and kept their production ACL';
  ELSE v_m := v_m + 1; o := o || E'\nFAIL  B10 readers with the 4b marker and an unchanged ACL: ' || v_k || '/5'; END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.portfolio_rate_approvals'::regclass
        AND t.tgname = 'trg_portfolio_rate_requests_stamp_actor' AND t.tgenabled <> 'D') = 1 THEN
    v_n := v_n + 1; o := o || E'\nPASS  B11 the requester trigger is installed and enabled';
  ELSE v_m := v_m + 1; o := o || E'\nFAIL  B11 the requester trigger is missing or disabled'; END IF;

  -- 5. The report (as a backend context), counts only
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    j := public.get_partner_return_report((now() AT TIME ZONE 'Africa/Kampala')::date - 6, (now() AT TIME ZONE 'Africa/Kampala')::date);
    SELECT string_agg(k, ',' ORDER BY k COLLATE "C") INTO v FROM jsonb_object_keys(j) k;
    IF v = 'assert_has_phase4_hook,cfo_queue,checks_failing,conformance,drift_open,monitor,new_portfolios,note_links_held,notes,policy,release_checks_failing,rule_check,window'
       AND jsonb_typeof(j -> 'assert_has_phase4_hook') = 'boolean' AND (j ->> 'assert_has_phase4_hook')::boolean
       AND j::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-' THEN
      v_n := v_n + 1; o := o || E'\nPASS  B12 report: keys as designed (note_links_held included), hook present, no person id in it';
    ELSE v_m := v_m + 1; o := o || E'\nFAIL  B12 report keys/hook/ids: ' || v || ' hook=' || COALESCE(j ->> 'assert_has_phase4_hook', 'null'); END IF;
    o := o || E'\nINFO  B13 report rule_check ' || (j -> 'rule_check')::text || ' | cfo_queue pending=' || COALESCE(j -> 'cfo_queue' ->> 'pending', '-')
           || ' lowering=' || COALESCE(j -> 'cfo_queue' ->> 'pending_lowering', '-') || ' | checks_failing ' || (j -> 'checks_failing')::text
           || ' | release_checks_failing ' || (j -> 'release_checks_failing')::text || ' | monitor scheduled=' || COALESCE(j -> 'monitor' ->> 'scheduled', '-')
           || ' last_status=' || COALESCE(j -> 'monitor' ->> 'last_status', '-');
  EXCEPTION WHEN others THEN
    v_m := v_m + 1; o := o || E'\nFAIL  B12 report raised: ' || SQLSTATE || ' ' || left(SQLERRM, 160);
  END;

  -- 6. The activation link: compatibility keys empty, contacts never returned, legacy 15 shown (sample of 200 notes)
  SELECT count(*) || '/' || count(*) FILTER (WHERE x.j ->> 'whatsapp_number' = '' AND x.j ->> 'email' = '')
         || '/' || count(*) FILTER (WHERE (x.j ->> 'return_rate')::numeric = 15) || '/' || count(*) FILTER (WHERE x.j ->> 'linked_to_me' = 'false')
    INTO v
    FROM (SELECT public.lookup_promissory_note(n.activation_token) AS j FROM public.promissory_notes n
           WHERE n.activation_token IS NOT NULL ORDER BY n.created_at DESC LIMIT 200) x WHERE x.j IS NOT NULL;
  o := o || E'\nINFO  B14 lookup on the newest notes: answered/compat keys empty/15 shown/linked_to_me false = ' || v;
  IF split_part(v, '/', 1) = split_part(v, '/', 2) AND split_part(v, '/', 1) = split_part(v, '/', 3) THEN
    v_n := v_n + 1; o := o || E'\nPASS  B14 every answered lookup has empty compatibility keys and shows the legacy 15 (switch off)';
  ELSE v_m := v_m + 1; o := o || E'\nFAIL  B14 lookup compatibility or switch-off parity broken: ' || v; END IF;
  SELECT count(*) INTO v_k FROM (SELECT n.activation_token FROM public.promissory_notes n GROUP BY 1 HAVING count(*) > 1) d;
  o := o || E'\nINFO  B15 activation tokens shared by more than one note (lookup answers NULL for them): ' || v_k;

  -- 7. Batch readers answer (counts only)
  o := o || E'\nINFO  B16 partner_confirmed_login_emails for the newest 1,000 investors: '
         || (SELECT count(*) FROM public.partner_confirmed_login_emails(ARRAY(SELECT DISTINCT ip.investor_id FROM public.investor_portfolios ip
                                                                               WHERE ip.investor_id IS NOT NULL LIMIT 1000)));

  RAISE EXCEPTION 'DRYRUN_P4 %', format('pass=%s fail=%s', v_n, v_m) || o;
END $t$;
ROLLBACK;
