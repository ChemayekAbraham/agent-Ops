-- Phase 1 (per-person Partner Returns, owner rules 2026-11-06) production rehearsal. NEVER COMMITS.
--
-- Run in ONE transaction, directly after the migration text:
--   BEGIN;
--   SET LOCAL statement_timeout = '20s';
--   <supabase/migrations/20261105150000_partner_return_policy_phase1.sql>
--   <this file>
-- The DO block always ends in RAISE EXCEPTION 'DRYRUN_P1V2 ...' (PASS/FAIL lines in the message), which aborts
-- the transaction; the trailing ROLLBACK is a second belt. Nothing is kept: test portfolios, the switch, the
-- cut-off, the existing-partner list, cron jobs, audit rows and queued emails (pgmq.send is transactional) all
-- roll back.
-- While it runs, the migration holds ACCESS EXCLUSIVE on investor_portfolios and promissory_notes (and SHARE on
-- pending_wallet_operations for the index), so production reads of portfolios and notes wait until it ends.
-- Keep it short (target < 5 s from BEGIN) and run it at a quiet moment.
--
-- Fixtures are picked from live data with ORDER BY (deterministic). On 2026-11-06 they resolved to:
--   ceo          29a0cfa8-1eaf-453c-874c-0fc72fa4f74b   (also holds cfo; 3 enabled CEOs)
--   cfo          cfa56623-e6cb-4023-b601-3dbd4fdbc027   (not a CEO)
--   super_admin  bd266fc7-1066-468a-8beb-347430d9d9b6   (not a CEO)
--   h15          000081c4-46d6-4e14-8e14-1f31c0b9bcb7   (live portfolios all 15%, not staff)
--   h20          0220c524-c0c8-4745-9021-b38a87d7f05f   (live portfolios all 20%, not staff)
--   mixed        2470c782-4248-40b2-a5b9-d7acc84b82b3   (live 15% and 20%, not staff)
--   staff        08e3ecb5-6a23-46e6-a15c-d89946990d8f   (hr_staff.active, no portfolio)
--   signed       0155a17e-ec8b-4c9f-b017-8b7e0b52bff4   (signed, not countersigned, no live/redeemed portfolio)
--   note_only    022da7e9-b9a6-47cd-a243-02b5b9912546   (linked to a pre-cut-off note, no portfolio, no agreement)
--   new_user     00005b8c-265f-43c4-a22c-34285fa28492   (no portfolio as investor or agent, no note, not staff,
--                                                        no agreement, no staff role)
--   pending note 0398f11f-e840-463e-a9f9-0537b98abd5b   (browser refusal checks only; never changed)
--   h20 live pf  04146bd2-1117-4668-81d1-a70641eb9399   (edited 20 -> 15 to prove the change is queued, rate kept)
-- Expected existing-partner list at the cut-off on 2026-11-06: 1,188 (1,136 live holders + 52 signed-agreement).
-- staff_mfa_config.mode is 'shadow' in production, so the aal2 claims are carried but require_staff_aal2() passes
-- either way: this rehearsal does not prove the MFA refusal path.
--
-- Test portfolios are status 'pending_ops_approval' (no wallet debit, no commission, no landlord-pool reserve)
-- with an already-bcrypt-shaped PIN (trg_hash_portfolio_pin skips hashing), pool_origin NULL (the company-managed
-- allocator returns at once). No promissory note is inserted (a note insert posts a receivable to the ledger);
-- the note stamp is checked through partner_note_rate_for(), the function the stamp trigger calls.

SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';

DO $t$
DECLARE
  o text := '';
  v_ceo uuid; v_cfo uuid; v_sa uuid;
  v_h15 uuid; v_h20 uuid; v_mixed uuid; v_staff uuid; v_signed uuid; v_note uuid; v_new uuid;
  v_note_id uuid; v_h20_pf uuid; v_inv_off uuid;
  v_id uuid; v_p_h20 uuid; v_p_browser uuid;
  v_rate numeric; v_basis text; v_ent numeric; v_rb text; v_dec timestamptz; v_rate2 numeric;
  v_n int; v_m int; v_k int; v_b boolean; v_t text; v_j jsonb;
  v_cutoff timestamptz; v_cutoff2 timestamptz; v_enabled boolean;
  v_cohort_expected int; v_cohort int; v_hash_before text; v_hash_after text;
  v_err text; v_ctx text; v_ms numeric;
  r record;
  -- Already bcrypt-shaped, so trg_hash_portfolio_pin does not spend ~70 ms per insert hashing it.
  c_pin constant text := '$2a$10$' || repeat('D', 53);
BEGIN
<<main>>
BEGIN
  -- =====================================================================================
  -- F. Fixtures (deterministic)
  -- =====================================================================================
  SELECT ur.user_id INTO v_ceo FROM public.user_roles ur
   WHERE ur.role = 'ceo' AND ur.enabled ORDER BY ur.user_id LIMIT 1;
  SELECT ur.user_id INTO v_cfo FROM public.user_roles ur
   WHERE ur.role = 'cfo' AND ur.enabled AND NOT public._has_enabled_role(ur.user_id, ARRAY['ceo'])
   ORDER BY ur.user_id LIMIT 1;
  SELECT ur.user_id INTO v_sa FROM public.user_roles ur
   WHERE ur.role = 'super_admin' AND ur.enabled AND NOT public._has_enabled_role(ur.user_id, ARRAY['ceo'])
   ORDER BY ur.user_id LIMIT 1;

  -- Holders of live portfolios: not active staff, and not an unverified self-registered funder
  -- (trg_enforce_funder_verified_for_portfolio would refuse their new portfolio).
  WITH live AS (
    SELECT ip.investor_id, min(ip.roi_percentage) AS mn, max(ip.roi_percentage) AS mx,
           bool_or(ip.roi_percentage = 15) AS has15, bool_or(ip.roi_percentage = 20) AS has20
      FROM public.investor_portfolios ip
     WHERE ip.investor_id IS NOT NULL AND ip.status IN ('active', 'locked')
     GROUP BY ip.investor_id
  ), ok AS (
    SELECT l.* FROM live l JOIN public.profiles p ON p.id = l.investor_id
     WHERE NOT (COALESCE(p.signup_source, '') = 'funder-onboarding' AND p.funder_verified_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = l.investor_id AND s.active)
  )
  SELECT (SELECT ok.investor_id FROM ok WHERE ok.mn = 15 AND ok.mx = 15 ORDER BY ok.investor_id LIMIT 1),
         (SELECT ok.investor_id FROM ok WHERE ok.mn = 20 AND ok.mx = 20 ORDER BY ok.investor_id LIMIT 1),
         (SELECT ok.investor_id FROM ok WHERE ok.has15 AND ok.has20 AND ok.mx = 20 ORDER BY ok.investor_id LIMIT 1)
    INTO v_h15, v_h20, v_mixed;

  SELECT s.user_id INTO v_staff FROM public.hr_staff s JOIN public.profiles p ON p.id = s.user_id
   WHERE s.active
     AND NOT (COALESCE(p.signup_source, '') = 'funder-onboarding' AND p.funder_verified_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip
                      WHERE ip.investor_id = s.user_id AND ip.status IN ('active', 'locked') AND ip.roi_percentage > 20)
   ORDER BY s.user_id LIMIT 1;

  SELECT pa.partner_id INTO v_signed FROM public.partner_agreements pa
   WHERE pa.partner_signature_data_url IS NOT NULL AND pa.countersigned_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip
                      WHERE ip.investor_id = pa.partner_id AND ip.status IN ('active', 'locked', 'redeemed'))
     AND NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = pa.partner_id AND s.active)
   ORDER BY pa.partner_id LIMIT 1;

  SELECT n.partner_user_id INTO v_note FROM public.promissory_notes n
   WHERE n.partner_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = n.partner_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = n.partner_user_id AND s.active)
     AND NOT EXISTS (SELECT 1 FROM public.partner_agreements pa WHERE pa.partner_id = n.partner_user_id)
   ORDER BY n.partner_user_id LIMIT 1;

  SELECT p.id INTO v_new FROM public.profiles p
   WHERE NOT (COALESCE(p.signup_source, '') = 'funder-onboarding' AND p.funder_verified_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.agent_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.promissory_notes n WHERE n.partner_user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.partner_agreements pa WHERE pa.partner_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur
                      WHERE ur.user_id = p.id AND ur.role::text NOT IN ('tenant', 'agent', 'supporter', 'landlord'))
   ORDER BY p.id LIMIT 1;

  SELECT n.id INTO v_note_id FROM public.promissory_notes n
   WHERE n.status = 'pending' AND n.partner_user_id IS NOT NULL AND n.partner_user_id IS DISTINCT FROM v_new
   ORDER BY n.id LIMIT 1;

  SELECT ip.id INTO v_h20_pf FROM public.investor_portfolios ip
   WHERE ip.investor_id = v_h20 AND ip.status = 'active' AND ip.roi_percentage = 20
     AND NOT public.is_portfolio_on_hold(ip.id)
   ORDER BY ip.id LIMIT 1;

  FOR r IN SELECT * FROM (VALUES ('ceo', v_ceo), ('cfo', v_cfo), ('super_admin', v_sa),
                                 ('existing 15% holder', v_h15), ('existing 20% non-staff holder', v_h20),
                                 ('15+20 mixed holder', v_mixed), ('active staff member', v_staff),
                                 ('signed uncountersigned agreement, no live portfolio', v_signed),
                                 ('pre-cut-off note, no portfolio', v_note), ('brand-new user', v_new),
                                 ('pending note (browser checks)', v_note_id),
                                 ('live 20% portfolio of the 20% holder', v_h20_pf)) f(k, v)
  LOOP
    o := o || format(E'\n%s F fixture %s = %s', CASE WHEN r.v IS NULL THEN 'FAIL' ELSE 'INFO' END,
                     r.k, COALESCE(r.v::text, 'fixture missing'));
  END LOOP;

  -- =====================================================================================
  -- S1. Migration objects exist (switch still OFF)
  -- =====================================================================================
  SELECT count(*) INTO v_n
    FROM unnest(ARRAY['partner_return_policy', 'partner_return_cohort', 'portfolio_rate_approvals']) t
   WHERE to_regclass('public.' || t) IS NOT NULL;
  o := o || format(E'\n%s S1.1 tables: %s/3', CASE WHEN v_n = 3 THEN 'PASS' ELSE 'FAIL' END, v_n);

  SELECT count(DISTINCT p.proname) INTO v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = ANY (ARRAY['partner_live_portfolio_statuses', 'partner_rates_for', 'partner_rate_for',
       'partner_new_contract_rate', 'partner_note_rate_for', 'partner_return_policy_guard', 'partner_return_cohort_guard',
       'stamp_promissory_note_return_rate', 'guard_promissory_note_return_rate', 'enforce_partner_return_rate_policy',
       '_partner_return_alert', '_partner_return_policy_caller_ok', 'get_partner_return_policy', 'set_partner_return_policy',
       'list_portfolio_rate_requests', 'cfo_decide_portfolio_rate_requests', 'apply_due_portfolio_rate_changes',
       'set_portfolio_renewal_rate', 'partner_rate_conformance', 'assert_partner_return_policy_intact',
       'record_partner_return_policy_drift']);
  o := o || format(E'\n%s S1.2 functions: %s/21', CASE WHEN v_n = 21 THEN 'PASS' ELSE 'FAIL' END, v_n);

  SELECT count(*) INTO v_n FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND ((c.table_name = 'investor_portfolios' AND c.column_name IN ('entitled_rate', 'rate_basis', 'rate_decided_at'))
       OR (c.table_name = 'promissory_notes' AND c.column_name IN ('return_rate', 'return_rate_basis') AND c.is_nullable = 'NO'));
  o := o || format(E'\n%s S1.3 columns (3 stamps + 2 NOT NULL note columns): %s/5', CASE WHEN v_n = 5 THEN 'PASS' ELSE 'FAIL' END, v_n);

  SELECT count(*) INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'D'
     AND c.relname || '.' || t.tgname IN (
       'investor_portfolios.trg_partner_return_rate_policy', 'promissory_notes.trg_zz_stamp_note_return_rate',
       'promissory_notes.trg_zz_guard_note_return_rate', 'partner_return_policy.trg_partner_return_policy_guard',
       'partner_return_cohort.trg_partner_return_cohort_guard', 'partner_return_cohort.trg_partner_return_cohort_no_truncate');
  o := o || format(E'\n%s S1.4 triggers enabled: %s/6', CASE WHEN v_n = 6 THEN 'PASS' ELSE 'FAIL' END, v_n);

  -- The gate must fire after every existing BEFORE INSERT guard and before trg_zz_portfolio_return_hold on UPDATE.
  SELECT string_agg(t.tgname::text, ',' ORDER BY t.tgname::text COLLATE "C") INTO v_t FROM pg_trigger t
   WHERE t.tgrelid = 'public.investor_portfolios'::regclass AND NOT t.tgisinternal
     AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4;
  SELECT string_agg(t.tgname::text, ',' ORDER BY t.tgname::text COLLATE "C") INTO v_err FROM pg_trigger t
   WHERE t.tgrelid = 'public.investor_portfolios'::regclass AND NOT t.tgisinternal
     AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16;
  o := o || format(E'\n%s S1.5 gate order: BEFORE INSERT [%s]; UPDATE gate before trg_zz_portfolio_return_hold=%s',
    CASE WHEN v_t LIKE '%trg_hash_portfolio_pin,trg_partner_return_carry_guard,trg_partner_return_rate_policy'
          AND position('trg_partner_return_rate_policy,trg_zz_portfolio_return_hold' IN v_err) > 0 THEN 'PASS' ELSE 'FAIL' END,
    v_t, position('trg_partner_return_rate_policy,trg_zz_portfolio_return_hold' IN v_err) > 0);
  v_err := NULL;

  SELECT count(*) INTO v_n FROM cron.job j
   WHERE j.jobname IN ('apply-portfolio-rate-changes-705pm', 'partner-rate-drift-check') AND j.active;
  o := o || format(E'\n%s S1.6 cron jobs scheduled: %s/2', CASE WHEN v_n = 2 THEN 'PASS' ELSE 'FAIL' END, v_n);

  SELECT c.column_default IS NULL AND c.is_nullable = 'NO' INTO v_b FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios' AND c.column_name = 'roi_percentage';
  o := o || format(E'\n%s S1.7 roi_percentage NOT NULL with no default', CASE WHEN v_b THEN 'PASS' ELSE 'FAIL' END);

  SELECT count(*), bool_and(NOT p.enabled AND p.cutoff_at IS NULL AND p.enabled_at IS NULL
                            AND p.existing_partner_mode = 'own' AND p.existing_partner_cap IS NULL
                            AND p.new_contract_rate = 10 AND p.legacy_rate = 15 AND p.employee_rate = 20
                            AND p.note_grace_days = 30)
    INTO v_n, v_b FROM public.partner_return_policy p;
  o := o || format(E'\n%s S1.8 policy row ships OFF, no cut-off, mode own, NO cap, rates 10/15/20, grace 30: rows=%s',
                   CASE WHEN v_n = 1 AND v_b THEN 'PASS' ELSE 'FAIL' END, v_n);

  v_b := NOT has_function_privilege('authenticated', 'public.partner_rates_for(uuid[],boolean)', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'public.partner_return_note_windows', 'SELECT')
     AND NOT has_table_privilege('service_role', 'public.portfolio_rate_approvals', 'INSERT')
     AND NOT has_function_privilege('authenticated', 'public.partner_rate_for(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.set_partner_return_policy(boolean,numeric,text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.set_partner_return_policy(boolean,numeric,text)', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'public.partner_return_policy', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.partner_return_cohort', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.portfolio_rate_approvals', 'SELECT')
     AND to_regclass('public.idx_pwo_investor_portfolio_source') IS NOT NULL;
  o := o || format(E'\n%s S1.9 grants (rule closed to browsers, switch callable by authenticated only) + pwo index',
                   CASE WHEN v_b THEN 'PASS' ELSE 'FAIL' END);

  -- =====================================================================================
  -- S2. Existing promissory notes read 15 / legacy and no note row was written
  -- =====================================================================================
  SELECT count(*),
         count(*) FILTER (WHERE n.return_rate IS DISTINCT FROM 15 OR n.return_rate_basis IS DISTINCT FROM 'legacy'),
         count(*) FILTER (WHERE n.updated_at >= now())
    INTO v_n, v_m, v_k FROM public.promissory_notes n;
  o := o || format(E'\n%s S2.1 existing notes read 15/legacy: %s notes, %s otherwise',
                   CASE WHEN v_n > 0 AND v_m = 0 THEN 'PASS' ELSE 'FAIL' END, v_n, v_m);
  SELECT COALESCE(sum(s.n_tup_ins + s.n_tup_upd + s.n_tup_del), 0) INTO v_m
    FROM pg_stat_xact_user_tables s WHERE s.relid = 'public.promissory_notes'::regclass;
  -- (updated_at >= transaction start would also catch a concurrent production edit in the same second; the
  --  pg_stat_xact counter is this transaction only.)
  o := o || format(E'\n%s S2.2 no note row written by the migration (updated_at unchanged): rows touched this txn=%s, updated_at>=txn start=%s',
                   CASE WHEN v_m = 0 AND v_k = 0 THEN 'PASS' ELSE 'FAIL' END, v_m, v_k);
  SELECT count(*) FILTER (WHERE a.atthasmissing) INTO v_n FROM pg_attribute a
   WHERE a.attrelid = 'public.promissory_notes'::regclass AND a.attname IN ('return_rate', 'return_rate_basis');
  o := o || format(E'\n%s S2.3 note columns added as stored defaults (no table rewrite): %s/2',
                   CASE WHEN v_n = 2 THEN 'PASS' ELSE 'FAIL' END, v_n);

  -- =====================================================================================
  -- S3. Switch OFF: exactly today's behaviour
  -- =====================================================================================
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  v_rate := public.partner_new_contract_rate();
  o := o || format(E'\n%s S3.1 off: public new-partner rate=%s (want 15)', CASE WHEN v_rate = 15 THEN 'PASS' ELSE 'FAIL' END, v_rate);
  IF v_new IS NOT NULL THEN
    SELECT x.rate, x.basis INTO v_rate, v_basis FROM public.partner_rate_for(v_new) x;
    SELECT x.rate, x.basis INTO v_rate2, v_rb FROM public.partner_note_rate_for(v_new) x;
    o := o || format(E'\n%s S3.2 off: new user rate=%s/%s (want 15/switch_off), note stamp=%s/%s (want 15/legacy)',
                     CASE WHEN v_rate = 15 AND v_basis = 'switch_off' AND v_rate2 = 15 AND v_rb = 'legacy' THEN 'PASS' ELSE 'FAIL' END,
                     v_rate, v_basis, v_rate2, v_rb);
  END IF;

  v_inv_off := COALESCE(v_h15, v_new);
  IF v_inv_off IS NULL THEN
    o := o || E'\nFAIL S3.3 off inserts skipped: fixture missing (15% holder and new user)';
  ELSE
    v_id := gen_random_uuid();
    INSERT INTO public.investor_portfolios (id, investor_id, agent_id, portfolio_code, portfolio_pin,
                                            duration_months, investment_amount, status)
    VALUES (v_id, v_inv_off, v_inv_off, 'DRYRUN-' || left(v_id::text, 13), c_pin, 12, 100000, 'pending_ops_approval');
    SELECT ip.roi_percentage, ip.entitled_rate, ip.rate_basis INTO v_rate, v_ent, v_rb
      FROM public.investor_portfolios ip WHERE ip.id = v_id;
    o := o || format(E'\n%s S3.3 off: insert with no rate -> %s (entitled %s, basis %s; want 15/15/switch_off)',
                     CASE WHEN v_rate = 15 AND v_ent = 15 AND v_rb = 'switch_off' THEN 'PASS' ELSE 'FAIL' END, v_rate, v_ent, v_rb);

    v_id := gen_random_uuid();
    INSERT INTO public.investor_portfolios (id, investor_id, agent_id, portfolio_code, portfolio_pin,
                                            duration_months, investment_amount, status, roi_percentage)
    VALUES (v_id, v_inv_off, v_inv_off, 'DRYRUN-' || left(v_id::text, 13), c_pin, 12, 100000, 'pending_ops_approval', 20);
    SELECT ip.roi_percentage, ip.entitled_rate, ip.rate_basis INTO v_rate, v_ent, v_rb
      FROM public.investor_portfolios ip WHERE ip.id = v_id;
    SELECT count(*) INTO v_n FROM public.portfolio_rate_approvals;
    o := o || format(E'\n%s S3.4 off: typed 20 -> %s (entitled %s, basis %s), CFO requests=%s (want 20/20/typed_switch_off, 0)',
                     CASE WHEN v_rate = 20 AND v_ent = 20 AND v_rb = 'typed_switch_off' AND v_n = 0 THEN 'PASS' ELSE 'FAIL' END,
                     v_rate, v_ent, v_rb, v_n);
  END IF;

  -- =====================================================================================
  -- S4. Only the CEO may turn it on: CFO, super_admin (browser sessions) and the service role are refused
  -- =====================================================================================
  FOR r IN SELECT * FROM (VALUES ('CFO', v_cfo), ('super_admin', v_sa)) f(k, v) LOOP
    IF r.v IS NULL THEN
      o := o || format(E'\nFAIL S4 %s refusal skipped: fixture missing', r.k);
      CONTINUE;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', r.v, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    PERFORM set_config('request.jwt.claim.sub', r.v::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.set_partner_return_policy(true, NULL, 'DRYRUN_P1V2 refusal');
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    RESET ROLE;
    o := o || format(E'\n%s S4 %s cannot turn the switch on: %s',
                     CASE WHEN v_err ILIKE '%only the ceo%' THEN 'PASS' ELSE 'FAIL' END, r.k, COALESCE(v_err, 'ACCEPTED (BAD)'));
  END LOOP;

  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.set_partner_return_policy(true, NULL, 'DRYRUN_P1V2 refusal');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  RESET ROLE;
  o := o || format(E'\n%s S4 service_role cannot turn the switch on: %s',
                   CASE WHEN v_err IS NOT NULL THEN 'PASS' ELSE 'FAIL' END, COALESCE(v_err, 'ACCEPTED (BAD)'));

  SELECT p.enabled, p.cutoff_at INTO v_enabled, v_cutoff FROM public.partner_return_policy p WHERE p.id;
  SELECT count(*) INTO v_n FROM public.partner_return_cohort;
  o := o || format(E'\n%s S4 after refusals: enabled=%s cutoff=%s cohort=%s',
                   CASE WHEN NOT v_enabled AND v_cutoff IS NULL AND v_n = 0 THEN 'PASS' ELSE 'FAIL' END, v_enabled, v_cutoff, v_n);

  -- =====================================================================================
  -- S5. The CEO turns it ON (database-owner session carrying the CEO's MFA claims)
  -- =====================================================================================
  IF v_ceo IS NULL THEN
    o := o || E'\nFAIL S5 cannot continue: fixture missing: ceo';
    EXIT main;
  END IF;

  SELECT (SELECT count(DISTINCT ip.investor_id) FROM public.investor_portfolios ip
           WHERE ip.investor_id IS NOT NULL AND ip.status IN ('active', 'locked')),
         (SELECT count(*) FROM public.partner_agreements pa
           WHERE pa.partner_signature_data_url IS NOT NULL AND pa.countersigned_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip
                              WHERE ip.investor_id = pa.partner_id AND ip.status IN ('active', 'locked')))
    INTO v_n, v_m;
  v_cohort_expected := v_n + v_m;
  SELECT md5(string_agg(ip.id::text || ':' || ip.roi_percentage::text, ',' ORDER BY ip.id)), count(*)
    INTO v_hash_before, v_k FROM public.investor_portfolios ip WHERE ip.status IN ('active', 'locked');

  -- S5.0 The switch refuses until the Phase 2 migration marks every creation path ready.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ceo, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_ceo::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  BEGIN
    PERFORM public.set_partner_return_policy(true, NULL, 'DRYRUN_P1V2 before Phase 2');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  o := o || format(E'\n%s S5.0 CEO cannot turn it on before the release is marked ready: %s',
                   CASE WHEN v_err ILIKE '%release%is not complete%' THEN 'PASS' ELSE 'FAIL' END, COALESCE(v_err, 'ACCEPTED (BAD)'));
  -- Rehearsal only: mark the release ready from the owner session, as the release migration (Phase 7) will
  -- (audited; the email is queued and rolled back).
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  UPDATE public.partner_return_policy SET release_ready = true WHERE id;
  -- (v_ms, not v_n/v_m/v_k: those hold the S5.2 expected split and the S10.2 before-count.)
  SELECT count(*) INTO v_ms FROM public.audit_logs
   WHERE action_type = 'partner_return_policy_settings_changed' AND created_at >= now();
  o := o || format(E'\n%s S5.0 readiness change audited: %s row(s)', CASE WHEN v_ms = 1 THEN 'PASS' ELSE 'FAIL' END, v_ms);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ceo, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_ceo::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_j := public.set_partner_return_policy(true, NULL, 'DRYRUN_P1V2 rehearsal');
  SELECT count(*) INTO v_ms FROM public.partner_return_note_windows;
  SELECT v_ms = (SELECT count(*) FROM public.promissory_notes n WHERE n.status IN ('pending', 'activated', 'fulfilled'))
         AND v_ms > 0 INTO v_b;
  o := o || format(E'\n%s S5.0 note windows frozen at the cut-off: %s windows, one per open note=%s',
                   CASE WHEN v_b THEN 'PASS' ELSE 'FAIL' END, v_ms, v_b);
  SELECT count(*) INTO v_ms FROM public.partner_return_legacy_portfolios;
  SELECT v_ms = (SELECT count(*) FROM public.investor_portfolios ip WHERE ip.rate_decided_at IS NULL) AND v_ms > 0 INTO v_b;
  o := o || format(E'\n%s S5.0 portfolios that predate the gate frozen at the cut-off: %s, all unstamped portfolios=%s',
                   CASE WHEN v_b THEN 'PASS' ELSE 'FAIL' END, v_ms, v_b);
  SELECT p.enabled, p.cutoff_at INTO v_enabled, v_cutoff FROM public.partner_return_policy p WHERE p.id;
  SELECT count(*) INTO v_cohort FROM public.partner_return_cohort;
  o := o || format(E'\n%s S5.1 CEO switch-on: enabled=%s changed=%s cutoff=%s enabled_at=%s',
                   CASE WHEN v_enabled AND (v_j ->> 'changed')::boolean AND v_cutoff IS NOT NULL
                             AND (v_j ->> 'enabled_at') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END,
                   v_enabled, v_j ->> 'changed', v_cutoff, v_j ->> 'enabled_at');
  o := o || format(E'\n%s S5.2 existing-partner list = %s (want %s = %s live holders + %s signed-agreement; switch reported %s)',
                   CASE WHEN v_cohort = v_cohort_expected AND (v_j ->> 'existing_partners')::int = v_cohort_expected
                        THEN 'PASS' ELSE 'FAIL' END,
                   v_cohort, v_cohort_expected, v_n, v_m, v_j ->> 'existing_partners');

  SELECT string_agg(format('%s:%s/%s-%s', f.k, COALESCE(co.basis, 'none'), COALESCE(co.min_rate::text, '-'),
                           COALESCE(co.max_rate::text, '-')), ' ' ORDER BY f.ord),
         bool_and(CASE f.k
                    WHEN 'h20'    THEN co.basis = 'live_portfolio' AND co.max_rate = 20 AND co.min_rate = 20
                    WHEN 'mixed'  THEN co.basis = 'live_portfolio' AND co.min_rate = 15 AND co.max_rate = 20
                    WHEN 'signed' THEN co.basis = 'signed_agreement'
                    ELSE co.partner_id IS NULL END)
    INTO v_t, v_b
    FROM (VALUES (1, 'h20', v_h20), (2, 'mixed', v_mixed), (3, 'signed', v_signed),
                 (4, 'staff', v_staff), (5, 'note_only', v_note), (6, 'new_user', v_new)) f(ord, k, v)
    LEFT JOIN public.partner_return_cohort co ON co.partner_id = f.v
   WHERE f.v IS NOT NULL;
  o := o || format(E'\n%s S5.3 list rows: %s', CASE WHEN v_b THEN 'PASS' ELSE 'FAIL' END, v_t);

  BEGIN
    UPDATE public.partner_return_policy SET cutoff_at = v_cutoff - interval '1 day' WHERE id;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  o := o || format(E'\n%s S5.4 cut-off cannot be moved: %s',
                   CASE WHEN v_err ILIKE '%cut-off%' THEN 'PASS' ELSE 'FAIL' END, COALESCE(v_err, 'MOVED (BAD)'));

  BEGIN
    DELETE FROM public.partner_return_cohort
     WHERE partner_id = (SELECT c.partner_id FROM public.partner_return_cohort c ORDER BY c.partner_id LIMIT 1);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  BEGIN
    INSERT INTO public.partner_return_cohort (partner_id, basis, snapshot_at) VALUES (gen_random_uuid(), 'live_portfolio', now());
    v_t := NULL;
  EXCEPTION WHEN OTHERS THEN v_t := SQLERRM;
  END;
  o := o || format(E'\n%s S5.5 existing-partner list is append-only: delete=%s | insert=%s',
                   CASE WHEN v_err ILIKE '%fixed at the Partner Returns cut-off%' AND v_t ILIKE '%fixed at the Partner Returns cut-off%' THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_err, 'DELETED (BAD)'), COALESCE(v_t, 'INSERTED (BAD)'));

  -- =====================================================================================
  -- S6. The rule, per person (switch ON). No cap: a 20% partner's new portfolio is 20%.
  -- =====================================================================================
  FOR r IN SELECT * FROM (VALUES
      ('existing 15% holder',                 v_h15,    15::numeric, 'existing_partner'),
      ('existing 20% holder (no cap)',        v_h20,    20::numeric, 'existing_partner'),
      ('15+20 mixed holder (highest)',        v_mixed,  20::numeric, 'existing_partner'),
      ('active staff',                        v_staff,  20::numeric, 'employee'),
      ('signed agreement, no live portfolio', v_signed, 15::numeric, 'signed_agreement'),
      ('pre-cut-off note, no portfolio',      v_note,   15::numeric, 'promissory_note'),
      ('brand-new user',                      v_new,    10::numeric, 'new')) f(k, pid, want_rate, want_basis)
  LOOP
    IF r.pid IS NULL THEN
      o := o || format(E'\nFAIL S6 rate_for %s: fixture missing', r.k);
      CONTINUE;
    END IF;
    SELECT x.rate, x.basis INTO v_rate, v_basis FROM public.partner_rate_for(r.pid) x;
    o := o || format(E'\n%s S6 rate_for %s: %s/%s (want %s/%s)',
                     CASE WHEN v_rate = r.want_rate AND v_basis = r.want_basis THEN 'PASS' ELSE 'FAIL' END,
                     r.k, v_rate, v_basis, r.want_rate, r.want_basis);
  END LOOP;

  SELECT count(*) INTO v_n FROM public.partner_rates_for(ARRAY[v_h15, v_h20, v_mixed, v_staff, v_signed, v_note, v_new]) x;
  SELECT count(DISTINCT u) INTO v_m FROM unnest(ARRAY[v_h15, v_h20, v_mixed, v_staff, v_signed, v_note, v_new]) u WHERE u IS NOT NULL;
  v_rate := public.partner_new_contract_rate();
  v_j := public.get_partner_return_policy();
  o := o || format(E'\n%s S6.b batch rows=%s/%s; public new-partner rate=%s (want 10); mode=%s cap=%s (want own, none)',
                   CASE WHEN v_n = v_m AND v_rate = 10 AND v_j ->> 'existing_partner_mode' = 'own'
                             AND (v_j ->> 'existing_partner_cap') IS NULL THEN 'PASS' ELSE 'FAIL' END,
                   v_n, v_m, v_rate, v_j ->> 'existing_partner_mode', COALESCE(v_j ->> 'existing_partner_cap', 'none'));

  -- A note written now is stamped with the linked person's rate, or the new-partner rate when nobody is linked.
  SELECT x.rate, x.basis INTO v_rate2, v_rb FROM public.partner_note_rate_for(NULL) x;
  IF v_h20 IS NOT NULL THEN
    SELECT x.rate, x.basis INTO v_rate, v_basis FROM public.partner_note_rate_for(v_h20) x;
  END IF;
  o := o || format(E'\n%s S6.c note stamp after cut-off: 20%% holder=%s/%s (want 20/existing_partner), nobody linked=%s/%s (want 10/new)',
                   CASE WHEN (v_h20 IS NULL OR (v_rate = 20 AND v_basis = 'existing_partner')) AND v_rate2 = 10 AND v_rb = 'new'
                        THEN 'PASS' ELSE 'FAIL' END,
                   CASE WHEN v_h20 IS NULL THEN 'fixture missing' ELSE v_rate::text END, v_basis, v_rate2, v_rb);

  -- =====================================================================================
  -- S7. New portfolios (switch ON): rate and stamps from the rule; typed rates wait for the CFO
  -- =====================================================================================
  FOR r IN SELECT * FROM (VALUES
      ('existing 20% holder', v_h20,   20::numeric, 'existing_partner'),
      ('active staff',        v_staff, 20::numeric, 'employee'),
      ('brand-new user',      v_new,   10::numeric, 'new')) f(k, pid, want_rate, want_basis)
  LOOP
    IF r.pid IS NULL THEN
      o := o || format(E'\nFAIL S7 insert %s: fixture missing', r.k);
      CONTINUE;
    END IF;
    v_id := gen_random_uuid();
    BEGIN
      INSERT INTO public.investor_portfolios (id, investor_id, agent_id, portfolio_code, portfolio_pin,
                                              duration_months, investment_amount, status)
      VALUES (v_id, r.pid, r.pid, 'DRYRUN-' || left(v_id::text, 13), c_pin, 12, 100000, 'pending_ops_approval');
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    SELECT ip.roi_percentage, ip.entitled_rate, ip.rate_basis, ip.rate_decided_at INTO v_rate, v_ent, v_rb, v_dec
      FROM public.investor_portfolios ip WHERE ip.id = v_id;
    SELECT count(*) INTO v_n FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = v_id;
    o := o || format(E'\n%s S7 new portfolio for %s: rate=%s entitled=%s basis=%s decided>=cutoff=%s requests=%s (want %s/%s/%s, true, 0)%s',
                     CASE WHEN v_err IS NULL AND v_rate = r.want_rate AND v_ent = r.want_rate AND v_rb = r.want_basis
                               AND v_dec >= v_cutoff AND v_n = 0 THEN 'PASS' ELSE 'FAIL' END,
                     r.k, v_rate, v_ent, v_rb, v_dec >= v_cutoff, v_n, r.want_rate, r.want_rate, r.want_basis,
                     CASE WHEN v_err IS NOT NULL THEN ' insert refused: ' || v_err ELSE '' END);
    IF r.pid = v_h20 AND v_err IS NULL THEN v_p_h20 := v_id; END IF;
  END LOOP;

  -- The decision stamps never change after insert.
  IF v_p_h20 IS NOT NULL THEN
    BEGIN
      UPDATE public.investor_portfolios
         SET entitled_rate = 99, rate_basis = 'tampered', rate_decided_at = v_cutoff - interval '1 year'
       WHERE id = v_p_h20;
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    SELECT ip.entitled_rate, ip.rate_basis, ip.rate_decided_at INTO v_ent, v_rb, v_dec
      FROM public.investor_portfolios ip WHERE ip.id = v_p_h20;
    o := o || format(E'\n%s S7.4 stamps immutable: entitled=%s basis=%s decided>=cutoff=%s%s',
                     CASE WHEN v_ent = 20 AND v_rb = 'existing_partner' AND v_dec >= v_cutoff THEN 'PASS' ELSE 'FAIL' END,
                     v_ent, v_rb, v_dec >= v_cutoff, CASE WHEN v_err IS NOT NULL THEN ' (update refused: ' || v_err || ')' ELSE '' END);
  END IF;

  -- A new user's own browser session types 20%: stored at their 10%, and the 20% waits for the CFO.
  IF v_new IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_new, 'role', 'authenticated', 'aal', 'aal1')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_new::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    v_p_browser := gen_random_uuid();
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO public.investor_portfolios (id, investor_id, agent_id, portfolio_code, portfolio_pin,
                                              duration_months, investment_amount, status, roi_percentage)
      VALUES (v_p_browser, v_new, v_new, 'DRYRUN-' || left(v_p_browser::text, 13), c_pin, 12, 100000,
              'pending_ops_approval', 20);
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    RESET ROLE;
    SELECT ip.roi_percentage, ip.entitled_rate, ip.rate_basis INTO v_rate, v_ent, v_rb
      FROM public.investor_portfolios ip WHERE ip.id = v_p_browser;
    SELECT a.requested_rate, a.status || '/' || a.source || '/' || a.rate_in_force || '/' || (a.requested_by = v_new)
      INTO v_rate2, v_t FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = v_p_browser;
    o := o || format(E'\n%s S7.5 browser typed 20 for a new partner: stored=%s entitled=%s basis=%s; request %s %s (want 10/10/new; 20 pending/new_portfolio/10/true)%s',
                     CASE WHEN v_err IS NULL AND v_rate = 10 AND v_ent = 10 AND v_rb = 'new' AND v_rate2 = 20
                               AND v_t = 'pending/new_portfolio/10.00/true' THEN 'PASS' ELSE 'FAIL' END,
                     v_rate, v_ent, v_rb, v_rate2, v_t,
                     CASE WHEN v_err IS NOT NULL THEN ' insert refused: ' || v_err ELSE '' END);
  END IF;

  -- An existing 20% portfolio keeps 20%: a change to 15 is queued for the CFO and the old rate stays.
  IF v_h20_pf IS NOT NULL AND v_cfo IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_cfo::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    BEGIN
      UPDATE public.investor_portfolios SET roi_percentage = 15 WHERE id = v_h20_pf;
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    SELECT ip.roi_percentage INTO v_rate FROM public.investor_portfolios ip WHERE ip.id = v_h20_pf;
    SELECT count(*) INTO v_n FROM public.portfolio_rate_approvals a
     WHERE a.portfolio_id = v_h20_pf AND a.status = 'pending' AND a.source = 'rate_change'
       AND a.requested_rate = 15 AND a.rate_in_force = 20 AND a.requested_by = v_cfo;
    o := o || format(E'\n%s S7.6 existing 20%% portfolio edited to 15: stored=%s, CFO request=%s (want 20, 1)%s',
                     CASE WHEN v_err IS NULL AND v_rate = 20 AND v_n = 1 THEN 'PASS' ELSE 'FAIL' END, v_rate, v_n,
                     CASE WHEN v_err IS NOT NULL THEN ' (blocked by another guard: ' || left(v_err, 120) || ')' ELSE '' END);
  END IF;

  -- =====================================================================================
  -- S8. Browser refusals (SET LOCAL ROLE authenticated, CFO claims)
  -- =====================================================================================
  IF v_cfo IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_cfo::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM * FROM public.partner_rate_for(COALESCE(v_h20, v_new, v_cfo));
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    v_t := NULL; v_ctx := NULL; v_n := NULL; v_m := NULL;
    IF v_note_id IS NOT NULL THEN
      BEGIN
        UPDATE public.promissory_notes SET return_rate = 20 WHERE id = v_note_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_t := NULL;
      EXCEPTION WHEN OTHERS THEN v_t := SQLERRM;
      END;
      BEGIN
        UPDATE public.promissory_notes SET partner_user_id = COALESCE(v_new, v_h15, v_cfo) WHERE id = v_note_id;
        GET DIAGNOSTICS v_m = ROW_COUNT;
        v_ctx := NULL;
      EXCEPTION WHEN OTHERS THEN v_ctx := SQLERRM;
      END;
    END IF;
    RESET ROLE;
    o := o || format(E'\n%s S8.1 browser cannot call partner_rate_for: %s',
                     CASE WHEN v_err ILIKE '%permission denied%' THEN 'PASS' ELSE 'FAIL' END, COALESCE(v_err, 'ALLOWED (BAD)'));
    IF v_note_id IS NULL THEN
      o := o || E'\nFAIL S8.2 note checks skipped: fixture missing (pending note)';
    ELSE
      o := o || format(E'\n%s S8.2 browser cannot change a note''s rate: %s',
                       CASE WHEN v_t ILIKE '%fixed when the note is written%' THEN 'PASS' ELSE 'FAIL' END,
                       COALESCE(v_t, format('NOT REFUSED, rows=%s (BAD)', v_n)));
      o := o || format(E'\n%s S8.3 browser cannot move a note to another person: %s',
                       CASE WHEN v_ctx ILIKE '%cannot be moved%' THEN 'PASS' ELSE 'FAIL' END,
                       COALESCE(v_ctx, format('NOT REFUSED, rows=%s (BAD)', v_m)));
      SELECT n.return_rate INTO v_rate FROM public.promissory_notes n WHERE n.id = v_note_id;
      o := o || format(E'\n%s S8.4 note still reads %s', CASE WHEN v_rate = 15 THEN 'PASS' ELSE 'FAIL' END, v_rate);
    END IF;
    v_ctx := NULL;
  ELSE
    o := o || E'\nFAIL S8 browser refusals skipped: fixture missing (cfo)';
  END IF;

  -- =====================================================================================
  -- S9. Off and on again (CEO): the cut-off and the list never move
  -- =====================================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ceo, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_ceo::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;               -- the CEO's own browser session turns it off
  BEGIN
    v_j := public.set_partner_return_policy(false, NULL, 'DRYRUN_P1V2 off');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  RESET ROLE;
  SELECT p.enabled, p.cutoff_at INTO v_enabled, v_cutoff2 FROM public.partner_return_policy p WHERE p.id;
  IF v_h20 IS NOT NULL THEN
    SELECT x.rate, x.basis INTO v_rate, v_basis FROM public.partner_rate_for(v_h20) x;
  END IF;
  v_rate2 := public.partner_new_contract_rate();
  o := o || format(E'\n%s S9.1 CEO off (browser): enabled=%s cutoff kept=%s; 20%% holder=%s/%s; public rate=%s (want false, true, 15/switch_off, 15)%s',
                   CASE WHEN v_err IS NULL AND NOT v_enabled AND v_cutoff2 = v_cutoff AND v_rate2 = 15
                             AND (v_h20 IS NULL OR (v_rate = 15 AND v_basis = 'switch_off')) THEN 'PASS' ELSE 'FAIL' END,
                   v_enabled, v_cutoff2 = v_cutoff, v_rate, v_basis, v_rate2,
                   CASE WHEN v_err IS NOT NULL THEN ' refused: ' || v_err ELSE '' END);

  v_j := public.set_partner_return_policy(true, NULL, 'DRYRUN_P1V2 on again');
  SELECT p.enabled, p.cutoff_at INTO v_enabled, v_cutoff2 FROM public.partner_return_policy p WHERE p.id;
  SELECT count(*) INTO v_n FROM public.partner_return_cohort;
  IF v_h20 IS NOT NULL THEN
    SELECT x.rate INTO v_rate FROM public.partner_rate_for(v_h20) x;
  END IF;
  o := o || format(E'\n%s S9.2 on again: enabled=%s cutoff kept=%s list=%s (want %s), 20%% holder=%s',
                   CASE WHEN v_enabled AND v_cutoff2 = v_cutoff AND v_n = v_cohort AND (v_h20 IS NULL OR v_rate = 20)
                        THEN 'PASS' ELSE 'FAIL' END,
                   v_enabled, v_cutoff2 = v_cutoff, v_n, v_cohort, v_rate);

  -- =====================================================================================
  -- S10. Integrity and monitoring
  -- =====================================================================================
  BEGIN
    SET CONSTRAINTS ALL IMMEDIATE;          -- the deferred portfolio_rate_approvals FK is checked now
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  o := o || format(E'\n%s S10.1 deferred constraints hold: %s', CASE WHEN v_err IS NULL THEN 'PASS' ELSE 'FAIL' END,
                   COALESCE(v_err, 'ok'));

  SELECT md5(string_agg(ip.id::text || ':' || ip.roi_percentage::text, ',' ORDER BY ip.id)), count(*)
    INTO v_hash_after, v_n FROM public.investor_portfolios ip WHERE ip.status IN ('active', 'locked');
  o := o || format(E'\n%s S10.2 every existing live portfolio kept its stored rate (20 stays 20): %s live, unchanged=%s',
                   CASE WHEN v_hash_after = v_hash_before AND v_n = v_k THEN 'PASS' ELSE 'FAIL' END,
                   v_n, v_hash_after = v_hash_before);

  SELECT count(*) FILTER (WHERE c.ok), count(*), string_agg(c.check_name || ': ' || COALESCE(c.detail, ''), ' | ') FILTER (WHERE NOT c.ok)
    INTO v_n, v_m, v_t FROM public.assert_partner_return_policy_intact() c;
  o := o || format(E'\n%s S10.3 assert_partner_return_policy_intact: %s/%s ok%s',
                   CASE WHEN v_m = 12 AND v_n = v_m THEN 'PASS' ELSE 'FAIL' END, v_n, v_m,
                   CASE WHEN v_t IS NOT NULL THEN ' failing: ' || v_t ELSE '' END);

  SELECT count(*), string_agg(c.issue || ':' || c.portfolio_id, ', ') INTO v_n, v_t
    FROM public.partner_rate_conformance(NULL) c;
  o := o || format(E'\n%s S10.4 partner_rate_conformance() rows=%s%s',
                   CASE WHEN v_n = 0 THEN 'PASS' ELSE 'FAIL' END, v_n, CASE WHEN v_t IS NOT NULL THEN ' ' || left(v_t, 300) ELSE '' END);

  v_n := public.record_partner_return_policy_drift();
  SELECT count(*) INTO v_m FROM public.money_path_drift_events e
   WHERE e.check_name LIKE 'partner\_rate.%' AND e.resolved_at IS NULL;
  o := o || format(E'\n%s S10.5 record_partner_return_policy_drift()=%s, open partner_rate events=%s (want 0, 0)',
                   CASE WHEN v_n = 0 AND v_m = 0 THEN 'PASS' ELSE 'FAIL' END, v_n, v_m);

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_ctx = PG_EXCEPTION_CONTEXT;
  o := o || format(E'\nFAIL ABORTED (everything after this point did not run): %s | at: %s', v_err, left(v_ctx, 400));
END main;

  v_ms := round(extract(epoch FROM clock_timestamp() - now()) * 1000);
  o := o || format(E'\n%s T elapsed since BEGIN (migration + rehearsal): %s ms (target < 5000)',
                   CASE WHEN v_ms < 5000 THEN 'PASS' ELSE 'FAIL' END, v_ms);

  v_n := (length(o) - length(replace(o, E'\nPASS ', ''))) / length(E'\nPASS ');
  v_m := (length(o) - length(replace(o, E'\nFAIL ', ''))) / length(E'\nFAIL ');
  RAISE EXCEPTION 'DRYRUN_P1V2 %', format('pass=%s fail=%s', v_n, v_m) || o;
END $t$;
ROLLBACK;
