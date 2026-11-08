-- Phase 1 (per-person Partner Returns) persona and behaviour tests. LOCAL THROWAWAY CLUSTER ONLY.
-- Prerequisite: race_stub.sql, then the Phase 1 migration (applied twice), on port 55432.
-- Run by run_phase1_tests.sh; prints one PASS/FAIL line per assertion and a SUMMARY line.
-- Identities are pid('<name>') (md5 uuids, defined in race_stub.sql).
\pset tuples_only on
\pset format unaligned
\pset pager off
SET client_min_messages = warning;

-- ===========================================================================
-- Helpers
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public._t_results (n bigserial PRIMARY KEY, name text, ok boolean, got text, want text);
CREATE TABLE IF NOT EXISTS public._t_ids (k text PRIMARY KEY, id uuid);
CREATE TABLE IF NOT EXISTS public._t_vars (k text PRIMARY KEY, v text);
GRANT SELECT, INSERT ON public._t_ids, public._t_vars TO PUBLIC;

CREATE OR REPLACE FUNCTION public.t_check(p_name text, p_got text, p_want text) RETURNS text
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ok boolean := p_got IS NOT DISTINCT FROM p_want;
BEGIN
  INSERT INTO public._t_results (name, ok, got, want) VALUES (p_name, v_ok, p_got, p_want);
  RETURN CASE WHEN v_ok THEN 'PASS  ' || p_name
              ELSE 'FAIL  ' || p_name || '  got [' || COALESCE(p_got, '<null>') || '] want [' || COALESCE(p_want, '<null>') || ']' END;
END $$;

-- Runs p_sql as the CURRENT role; passes when it raises (SQLSTATE or message ILIKE p_like).
-- A statement that unexpectedly succeeds is rolled back and reported as FAIL.
CREATE OR REPLACE FUNCTION public.t_raises(p_name text, p_sql text, p_like text DEFAULT NULL) RETURNS text
 LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'T_NO_ERROR';
  EXCEPTION WHEN others THEN
    IF SQLERRM = 'T_NO_ERROR' THEN
      RETURN public.t_check(p_name, 'no error (statement succeeded; rolled back)', 'error' || COALESCE(' ' || p_like, ''));
    ELSIF p_like IS NULL OR SQLSTATE = p_like OR SQLERRM ILIKE p_like THEN
      RETURN public.t_check(p_name, 'error', 'error');
    ELSE
      RETURN public.t_check(p_name, SQLSTATE || ': ' || SQLERRM, 'error ' || p_like);
    END IF;
  END;
END $$;

-- Insert a portfolio for a person (NULL person = no investor). Runs as the current role.
CREATE OR REPLACE FUNCTION public.t_new(p_person text, p_rate numeric DEFAULT NULL, p_status text DEFAULT 'active',
                                        p_parent uuid DEFAULT NULL, p_agent text DEFAULT 'agent1') RETURNS uuid
 LANGUAGE sql VOLATILE AS $$
  INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, roi_percentage, locked_from_portfolio_id)
  VALUES (CASE WHEN p_person IS NULL THEN NULL ELSE public.pid(p_person) END, public.pid(p_agent),
          'T-' || COALESCE(p_person, 'none') || '-' || substr(md5(random()::text), 1, 6), 100000, p_status, p_rate, p_parent)
  RETURNING id $$;

-- rate|basis|entitled|pending-request-rate(s)
CREATE OR REPLACE FUNCTION public.t_desc(p_id uuid) RETURNS text
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(trim_scale(ip.roi_percentage)::text, '-') || '|' || COALESCE(ip.rate_basis, '-') || '|'
      || COALESCE(trim_scale(ip.entitled_rate)::text, '-') || '|'
      || COALESCE((SELECT string_agg(trim_scale(a.requested_rate)::text, ',' ORDER BY a.requested_at)
                     FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = ip.id AND a.status = 'pending'), '-')
    FROM public.investor_portfolios ip WHERE ip.id = p_id $$;

-- What the decider says for a person: rate|basis
CREATE OR REPLACE FUNCTION public.t_rate(p_person text) RETURNS text
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT trim_scale(r.rate)::text || '|' || r.basis FROM public.partner_rates_for(ARRAY[public.pid(p_person)]) r $$;

CREATE OR REPLACE FUNCTION public.t_roi(p_id uuid) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT trim_scale(roi_percentage)::text FROM public.investor_portfolios WHERE id = p_id $$;
CREATE OR REPLACE FUNCTION public.tid(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM public._t_ids WHERE k = p_k $$;
CREATE OR REPLACE FUNCTION public.t_emails() RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT count(*)::int FROM public._email_outbox $$;
CREATE OR REPLACE FUNCTION public.t_as(p_user text) RETURNS void LANGUAGE sql VOLATILE AS $$
  SELECT set_config('request.jwt.claim.sub', COALESCE(public.pid(p_user)::text, ''), false),
         set_config('request.jwt.claim.role', CASE WHEN p_user IS NULL THEN '' ELSE 'authenticated' END, false),
         set_config('request.jwt.claims', '', false) $$;
CREATE OR REPLACE FUNCTION public.t_vset(p_k text, p_v text) RETURNS void LANGUAGE sql VOLATILE AS $$
  INSERT INTO public._t_vars VALUES (p_k, p_v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v $$;
CREATE OR REPLACE FUNCTION public.t_v(p_k text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT v FROM public._t_vars WHERE k = p_k $$;
-- Test helpers keep the default PUBLIC EXECUTE; the migration's own REVOKE/GRANTs are untouched.
SELECT public.t_as(NULL) IS NULL AS x \gset

-- ===========================================================================
-- M0. Right after the migration (applied twice)
-- ===========================================================================
SELECT public.t_check('M0 existing notes read 15 / legacy',
  (SELECT string_agg(DISTINCT trim_scale(return_rate)::text || '/' || return_rate_basis, ',') FROM public.promissory_notes), '15/legacy');
SELECT public.t_check('M0 existing notes not rewritten (updated_at, xmin, ctid unchanged; no trigger fired)',
  (SELECT count(*) FROM public.promissory_notes n JOIN public._t_note_before b ON b.id = n.id
    WHERE n.updated_at = b.updated_at AND n.xmin::text = b.xmin_before AND n.ctid::text = b.ctid_before)::text,
  (SELECT count(*) FROM public._t_note_before)::text);
SELECT public.t_check('M0 return_rate has no default left (new notes must be stamped)',
  (SELECT COALESCE(column_default, 'none') || '/' || is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'promissory_notes' AND column_name = 'return_rate'), 'none/NO');
SELECT public.t_check('M0 roi_percentage NOT NULL with no default',
  (SELECT COALESCE(column_default, 'none') || '/' || is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'investor_portfolios' AND column_name = 'roi_percentage'), 'none/NO');
SELECT public.t_check('M0 switch ships OFF with no cut-off',
  (SELECT enabled::text || '/' || COALESCE(cutoff_at::text, 'no cutoff') FROM public.partner_return_policy), 'false/no cutoff');
SELECT public.t_check('M0 cron jobs scheduled once each after two applies',
  (SELECT string_agg(jobname || '@' || schedule, ',' ORDER BY jobname) FROM cron.job),
  'apply-portfolio-rate-changes-705pm@15 16 * * *,partner-rate-drift-check@1-59/10 * * * *');   -- Phase 6 F5: off the payout windows (16:15; minutes 1,11,...,51)
SELECT public.t_check('M0 legacy portfolios untouched (no stamps)',
  (SELECT string_agg(portfolio_code || ':' || trim_scale(roi_percentage) || ':' || COALESCE(rate_basis, '-'), ',' ORDER BY portfolio_code)
     FROM public.investor_portfolios), 'LEG-15:15:-,LEG-20:20:-');
SELECT public.t_check('M0 assert_partner_return_policy_intact all ok (switch off)',
  (SELECT COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()), 'all ok');
SELECT public.t_check('M0 grants: browsers cannot read the policy/cohort tables or call the decider; service_role cannot flip',
  has_table_privilege('authenticated', 'public.partner_return_policy', 'SELECT')::text || '/'
  || has_table_privilege('authenticated', 'public.partner_return_cohort', 'SELECT')::text || '/'
  || has_function_privilege('authenticated', 'public.partner_rates_for(uuid[],boolean)', 'EXECUTE')::text || '/'
  || has_function_privilege('service_role', 'public.set_partner_return_policy(boolean,numeric,text)', 'EXECUTE')::text || '/'
  || has_function_privilege('authenticated', 'public.set_partner_return_policy(boolean,numeric,text)', 'EXECUTE')::text || '/'
  || has_function_privilege('anon', 'public.get_partner_return_policy()', 'EXECUTE')::text,
  'false/false/false/false/true/true');
SELECT public.t_check('M0 service_role: SELECT only on policy and cohort',
  has_table_privilege('service_role', 'public.partner_return_policy', 'UPDATE')::text || '/'
  || has_table_privilege('service_role', 'public.partner_return_cohort', 'INSERT')::text || '/'
  || has_table_privilege('service_role', 'public.partner_return_cohort', 'SELECT')::text, 'false/false/true');
SELECT public.t_check('M0 partner_rate_lock(uuid[]) (round 3): owner only, closed to PUBLIC, anon, authenticated, service_role; SECURITY INVOKER',
  (SELECT COALESCE(proacl::text, 'default') || '/' || prosecdef FROM pg_proc WHERE oid = 'public.partner_rate_lock(uuid[])'::regprocedure) || '/'
  || has_function_privilege('anon', 'public.partner_rate_lock(uuid[])', 'EXECUTE')::text || '/'
  || has_function_privilege('authenticated', 'public.partner_rate_lock(uuid[])', 'EXECUTE')::text || '/'
  || has_function_privilege('service_role', 'public.partner_rate_lock(uuid[])', 'EXECUTE')::text,
  '{postgres=X/postgres}/false/false/false/false');
SELECT public.t_check('M0 the gate takes the rate lock through partner_rate_lock (three places: invite claim, insert while on, insert while off after the cut-off (G2)), not the old per-person key',
  (SELECT (length(d) - length(replace(d, 'public.partner_rate_lock(ARRAY[NEW.investor_id])', ''))) / length('public.partner_rate_lock(ARRAY[NEW.investor_id])')
          || '/' || (position('partner-rate:' in d) = 0)
     FROM (SELECT pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure) d) x), '3/true');
-- Bucketed rate lock: pg_advisory_xact_lock(hashtext('partner-rate'), hashtext(id) & 255). pg_locks: classid = key 1, objid = key 2, objsubid = 2.
CREATE OR REPLACE FUNCTION public.t_rate_buckets_held() RETURNS integer[] LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(array_agg(l.objid::bigint::int ORDER BY l.objid), '{}'::integer[]) FROM pg_locks l
   WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted AND l.objsubid = 2
     AND l.classid = hashtext('partner-rate')::oid $$;
BEGIN;
SELECT public.t_new('lock_off') IS NOT NULL AS x \gset
SELECT cardinality(public.t_rate_buckets_held()) AS lock_off_n \gset
ROLLBACK;
SELECT public.t_check('M0 switch off: a portfolio insert takes no partner-rate lock (today''s path is untouched)', :'lock_off_n', '0');

-- ===========================================================================
-- OFF. Switch off: exactly today's behaviour. People set up here become the cut-off population.
-- ===========================================================================
INSERT INTO public.hr_staff (user_id, active, ended_on) VALUES
  (public.pid('emp'), true, NULL), (public.pid('emp_co'), true, NULL), (public.pid('exemp'), false, current_date - 30);
INSERT INTO public.partner_agreements (partner_id, partner_signature_data_url, countersigned_at, status) VALUES
  (public.pid('signed'),           'data:image/png;base64,AAAA', NULL, 'signed'),
  (public.pid('signed_oldredeem'), 'data:image/png;base64,AAAA', NULL, 'signed'),
  (public.pid('signed_counter'),   'data:image/png;base64,AAAA', now() - interval '10 days', 'countersigned'),
  (public.pid('signed_live'),      'data:image/png;base64,AAAA', NULL, 'signed'),
  (public.pid('unsigned'),         NULL, NULL, 'draft');
INSERT INTO public.supporter_agreement_acceptance (user_id) VALUES (public.pid('clickthru'));

SELECT public.t_check('OFF null rate -> 15 switch_off', public.t_desc(public.t_new('offnull')), '15|switch_off|15|-');
INSERT INTO public._t_ids SELECT 'offtyped', public.t_new('offtyped', 20);
SELECT public.t_check('OFF typed 20 -> 20 typed_switch_off', public.t_desc(public.tid('offtyped')), '20|typed_switch_off|20|-');
SELECT public.t_check('OFF typed rate queues nothing', (SELECT count(*) FROM public.portfolio_rate_approvals)::text, '0');
UPDATE public.investor_portfolios SET roi_percentage = 18 WHERE id = public.tid('offtyped');
SELECT public.t_check('OFF UPDATE applies directly, no request, stamps kept',
  public.t_desc(public.tid('offtyped')) || '/' || (SELECT count(*) FROM public.portfolio_rate_approvals), '18|typed_switch_off|20|-/0');
BEGIN;
SELECT set_config('app.partner_rate_context', 'salary_reinvestment', true) IS NOT NULL AS ctx \gset
SELECT public.t_check('OFF salary-reinvestment context, 20 -> 20', public.t_desc(public.t_new('offsal', 20)), '20|typed_switch_off|20|-');
COMMIT;
SELECT public.t_check('OFF decider says legacy 15 for anyone', public.t_rate('whoever'), '15|switch_off');
SELECT public.t_check('OFF partner_new_contract_rate() = 15', trim_scale(public.partner_new_contract_rate())::text, '15');
WITH n AS (INSERT INTO public.promissory_notes (agent_id, partner_user_id, amount, return_rate, return_rate_basis)
           VALUES (public.pid('agent1'), public.pid('offnote'), 1000, 99, 'client') RETURNING return_rate, return_rate_basis)
SELECT public.t_check('OFF new note -> 15 legacy (client-supplied 99 ignored)',
  (SELECT trim_scale(return_rate) || '/' || return_rate_basis FROM n), '15/legacy');

-- Existing partners and other people as they stand at the cut-off (typed rates while off).
DO $$ BEGIN
  INSERT INTO public._t_ids VALUES
    ('ex15_p',  public.t_new('ex15', 15)),
    ('ex20_p',  public.t_new('ex20', 20)),
    ('mix15_p', public.t_new('mix', 15)),
    ('mix20_p', public.t_new('mix', 20)),
    ('ex10_p',  public.t_new('ex10', 10)),
    ('ex14_p',  public.t_new('ex14', 14)),
    ('locked_p', public.t_new('lockedonly', 20, 'locked')),
    ('empco_p', public.t_new('emp_co', 15)),
    ('exemp_p', public.t_new('exemp', 15)),
    ('redeem_p', public.t_new('redeem', 20)),
    ('signedlive_p', public.t_new('signed_live', 20)),
    ('pendingonly_p', public.t_new('pending_only', 15, 'pending_ops_approval')),
    ('redeemedbefore_p', public.t_new('redeemed_before', 20, 'redeemed')),
    ('signedold_p', public.t_new('signed_oldredeem', 15, 'redeemed')),
    ('upd_a', public.t_new('upd', 20)),
    ('upd_b', public.t_new('upd', 20)),
    ('renew', public.t_new('renew', 15)),
    ('cfo1', public.t_new('cfo1', 15)),
    ('cfo2', public.t_new('cfo2', 15)),
    ('cfo3', public.t_new('cfo3', 15)),
    ('selfp', public.t_new('selfp', 15)),
    ('selfp2', public.t_new('selfp2', 15));
END $$;
SELECT public.t_check('OFF still nothing queued after 22 typed inserts', (SELECT count(*) FROM public.portfolio_rate_approvals)::text, '0');

-- ===========================================================================
-- SW. Switch authority (all before the first switch-on)
-- ===========================================================================
SELECT public.t_as('cfo') IS NULL AS x \gset
SELECT public.t_raises('SW CFO cannot flip the switch', 'SELECT public.set_partner_return_policy(true)', '42501');
SELECT public.t_as('superadmin') IS NULL AS x \gset
SELECT public.t_raises('SW super_admin cannot flip the switch', 'SELECT public.set_partner_return_policy(true)', '42501');
SELECT public.t_as('ceo_disabled') IS NULL AS x \gset
SELECT public.t_raises('SW a disabled CEO role cannot flip the switch', 'SELECT public.set_partner_return_policy(true)', '42501');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT set_config('request.jwt.claim.role', 'service_role', false) IS NULL AS x \gset
SELECT public.t_raises('SW service_role claim with no sub (backend context) is refused', 'SELECT public.set_partner_return_policy(true)', '42501');
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false) IS NULL AS x \gset
SELECT set_config('request.jwt.claim.role', '', false) IS NULL AS x \gset
SELECT public.t_raises('SW service_role in request.jwt.claims JSON is refused', 'SELECT public.set_partner_return_policy(true)', '42501');
SELECT public.t_as(NULL) IS NULL AS x \gset
SET ROLE service_role;
SELECT public.t_raises('SW the service_role database role has no EXECUTE on the switch', 'SELECT public.set_partner_return_policy(true)', '42501');
RESET ROLE;
SELECT public.t_check('SW still off, no cut-off, nothing emailed after refusals',
  (SELECT enabled::text || '/' || COALESCE(cutoff_at::text, 'none') FROM public.partner_return_policy) || '/' || public.t_emails(), 'false/none/0');

-- The CEO turns it on from a browser session (authenticated + JWT sub).
SELECT public.t_as('ceo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('SW CEO (browser session) turns it ON', (public.set_partner_return_policy(true, NULL, 'go live') ->> 'changed'), 'true');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_vset('cutoff', (SELECT cutoff_at::text FROM public.partner_return_policy));
SELECT public.t_vset('cohort_n', (SELECT count(*)::text FROM public.partner_return_cohort));
SELECT public.t_check('CUT first ON sets cutoff_at and enabled_at',
  (SELECT enabled::text || '/' || (cutoff_at IS NOT NULL)::text || '/' || (enabled_at IS NOT NULL)::text || '/' || (updated_by = public.pid('ceo'))::text
     FROM public.partner_return_policy), 'true/true/true/true');
SELECT public.t_check('CUT one alert email per CEO/CFO address (not the disabled CEO, not super_admin)',
  (SELECT string_agg(payload ->> 'to' || ':' || (payload ->> 'subject'), ',' ORDER BY payload ->> 'to') FROM public._email_outbox),
  'ceo@welile.test:Partner Returns switched ON,cfo@welile.test:Partner Returns switched ON');
SELECT public.t_check('CUT alert goes to the transactional Mailgun queue with a label',
  (SELECT string_agg(DISTINCT queue_name || '/' || (payload ->> 'label'), ',') FROM public._email_outbox), 'transactional_emails/partner-returns-alert');
SELECT public.t_check('CUT audit log + system event written once',
  (SELECT count(*) FROM public.audit_logs WHERE action_type = 'set_partner_return_policy' AND user_id = public.pid('ceo'))::text || '/'
  || (SELECT count(*) FROM public.system_events WHERE event_type = 'partner_return_policy_switched'), '1/1');
SELECT public.t_check('CUT cohort = live holders at the cut-off (active+locked, exact counts and rates) + signed agreements with no live portfolio',
  (SELECT count(*) FROM (
     (SELECT partner_id, basis, live_portfolios, min_rate, max_rate FROM public.partner_return_cohort
      EXCEPT
      (SELECT investor_id, 'live_portfolio', count(*)::int, min(roi_percentage), max(roi_percentage) FROM public.investor_portfolios
        WHERE status IN ('active', 'locked') AND investor_id IS NOT NULL GROUP BY investor_id
       UNION ALL SELECT public.pid('signed'), 'signed_agreement', 0, NULL, NULL
       UNION ALL SELECT public.pid('signed_oldredeem'), 'signed_agreement', 0, NULL, NULL))
     UNION ALL
     ((SELECT investor_id, 'live_portfolio', count(*)::int, min(roi_percentage), max(roi_percentage) FROM public.investor_portfolios
        WHERE status IN ('active', 'locked') AND investor_id IS NOT NULL GROUP BY investor_id
       UNION ALL SELECT public.pid('signed'), 'signed_agreement', 0, NULL, NULL
       UNION ALL SELECT public.pid('signed_oldredeem'), 'signed_agreement', 0, NULL, NULL)
      EXCEPT
      SELECT partner_id, basis, live_portfolios, min_rate, max_rate FROM public.partner_return_cohort)) d)::text, '0');
SELECT public.t_check('CUT cohort membership spot checks',
  (SELECT string_agg(x.k || '=' || COALESCE(c.basis || ':' || COALESCE(trim_scale(c.max_rate)::text, '-'), 'out'), ' ' ORDER BY x.k)
     FROM unnest(ARRAY['lockedonly','pending_only','redeemed_before','signed_counter','clickthru','unsigned','signed_live',
                       'offtyped','legacy20','legacy15','emp','signed']) x(k)
     LEFT JOIN public.partner_return_cohort c ON c.partner_id = public.pid(x.k)),
  'clickthru=out emp=out legacy15=live_portfolio:15 legacy20=live_portfolio:20 lockedonly=live_portfolio:20 offtyped=live_portfolio:18 pending_only=out redeemed_before=out signed=signed_agreement:- signed_counter=out signed_live=live_portfolio:20 unsigned=out');
SELECT public.t_check('CUT snapshot_at = cutoff_at for every cohort row',
  (SELECT count(*) FROM public.partner_return_cohort c, public.partner_return_policy p WHERE c.snapshot_at <> p.cutoff_at)::text, '0');

-- OFF then ON again: the cut-off and the list never move. (OFF via the JSON claims path.)
SELECT set_config('request.jwt.claims', json_build_object('sub', public.pid('ceo'), 'role', 'authenticated')::text, false) IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('CUT CEO turns it OFF (JWT claims JSON)', (public.set_partner_return_policy(false) ->> 'changed'), 'true');
RESET ROLE;
SELECT public.t_check('CUT OFF keeps the cut-off, clears enabled_at, behaves as today',
  (SELECT enabled::text || '/' || (cutoff_at::text = public.t_v('cutoff'))::text || '/' || COALESCE(enabled_at::text, 'none') FROM public.partner_return_policy)
  || '/' || public.t_rate('ex20'), 'false/true/none/15|switch_off');
SELECT public.t_as('ceo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('CUT CEO turns it ON again', (public.set_partner_return_policy(true) ->> 'changed'), 'true');
SELECT public.t_check('CUT ON when already ON: no change', (public.set_partner_return_policy(true) ->> 'changed'), 'false');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('CUT OFF->ON keeps cutoff_at and does not duplicate the cohort',
  (SELECT (cutoff_at::text = public.t_v('cutoff'))::text FROM public.partner_return_policy) || '/'
  || ((SELECT count(*) FROM public.partner_return_cohort)::text = public.t_v('cohort_n'))::text, 'true/true');
SELECT public.t_check('CUT one email pair per real flip (3 flips = 6), none for the no-op', public.t_emails()::text, '6');
SELECT public.t_raises('CUT direct UPDATE of cutoff_at errors (even as postgres)',
  $q$UPDATE public.partner_return_policy SET cutoff_at = now() - interval '1 day'$q$, '42501');
SELECT public.t_raises('CUT clearing cutoff_at errors', $q$UPDATE public.partner_return_policy SET cutoff_at = NULL$q$, '42501');
SELECT public.t_raises('CUT the policy row cannot be deleted', $q$DELETE FROM public.partner_return_policy$q$, '42501');
SELECT public.t_raises('CUT cohort INSERT errors', $q$INSERT INTO public.partner_return_cohort VALUES (gen_random_uuid(), 'live_portfolio', 1, 20, 20, now())$q$, '42501');
SELECT public.t_raises('CUT cohort UPDATE errors', $q$UPDATE public.partner_return_cohort SET max_rate = 30$q$, '42501');
SELECT public.t_raises('CUT cohort DELETE errors', $q$DELETE FROM public.partner_return_cohort$q$, '42501');
SELECT public.t_raises('CUT cohort TRUNCATE errors', $q$TRUNCATE public.partner_return_cohort$q$, '42501');
SET ROLE service_role;
SELECT set_config('app.partner_cohort_snapshot', 'on', false) IS NULL AS x \gset
SELECT public.t_raises('CUT service_role cannot append to the cohort even with the snapshot flag set',
  $q$INSERT INTO public.partner_return_cohort VALUES (gen_random_uuid(), 'live_portfolio', 1, 20, 20, now())$q$, '42501');
SELECT set_config('app.partner_cohort_snapshot', '', false) IS NULL AS x \gset
RESET ROLE;

-- ===========================================================================
-- ON. Personas (null rate unless stated)
-- ===========================================================================
BEGIN;
SELECT public.t_new('lock_on_a') IS NOT NULL AS x \gset
SELECT public.t_new('lock_on_a') IS NOT NULL AS x \gset
SELECT (public.t_rate_buckets_held() = ARRAY[hashtext(public.pid('lock_on_a')::text) & 255]) AS lock_on_one \gset
SELECT public.t_new('lock_on_b') IS NOT NULL AS x \gset
SELECT (public.t_rate_buckets_held() = ARRAY(SELECT DISTINCT hashtext(public.pid(x)::text) & 255 FROM unnest(ARRAY['lock_on_a', 'lock_on_b']) x ORDER BY 1)) AS lock_on_two,
       ((hashtext(public.pid('lock_on_a')::text) & 255) <> (hashtext(public.pid('lock_on_b')::text) & 255)) AS lock_on_differ \gset
ROLLBACK;
SELECT public.t_check('ON the gate holds the person''s rate-lock bucket until commit (two inserts for one person: one bucket; a second person adds theirs, in a different bucket)',
  :'lock_on_one' || '/' || :'lock_on_two' || '/' || :'lock_on_differ', 't/t/t');
BEGIN;
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status)
SELECT public.pid('lk1k_' || i), public.pid('agent1'), 'LK1K-' || i, 100000, 'active' FROM generate_series(1, 1000) i;
SELECT cardinality(public.t_rate_buckets_held()) AS lk1k_held,
       (SELECT count(DISTINCT hashtext(public.pid('lk1k_' || i)::text) & 255) FROM generate_series(1, 1000) i) AS lk1k_buckets,
       (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()) AS lk1k_adv \gset
ROLLBACK;
SELECT public.t_check('ON 1,000 people''s portfolios in one transaction: at most 256 partner-rate locks (one per bucket), no other advisory lock',
  (:lk1k_held <= 256) || '/' || (:lk1k_held = :lk1k_buckets) || '/' || (:lk1k_adv = :lk1k_held), 'true/true/true');
INSERT INTO public._t_ids SELECT 'new1_p', public.t_new('new1');
SELECT public.t_check('ON new partner -> 10 new', public.t_desc(public.tid('new1_p')), '10|new|10|-');
SELECT public.t_check('ON new partner, 2nd portfolio -> still 10 new', public.t_desc(public.t_new('new1')), '10|new|10|-');
INSERT INTO public._t_ids SELECT 'newtyped15_p', public.t_new('newtyped15', 15);
SELECT public.t_check('ON typed 15 for a new partner -> stored 10 + pending CFO request(15)', public.t_desc(public.tid('newtyped15_p')), '10|new|10|15');
SELECT public.t_check('ON ... request shape: new_portfolio, standard 10, in force 10',
  (SELECT source || '/' || trim_scale(standard_rate) || '/' || trim_scale(rate_in_force) FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('newtyped15_p')),
  'new_portfolio/10/10');
SELECT public.t_check('ON existing 15 -> 15 existing_partner', public.t_desc(public.t_new('ex15')), '15|existing_partner|15|-');
SELECT public.t_check('ON existing 20 -> 20 (no cap)', public.t_desc(public.t_new('ex20')), '20|existing_partner|20|-');
SELECT public.t_check('ON mixed 15+20 -> 20 (highest)', public.t_desc(public.t_new('mix')), '20|existing_partner|20|-');
SELECT public.t_check('ON existing at 10 -> 10 existing_partner', public.t_desc(public.t_new('ex10')), '10|existing_partner|10|-');
SELECT public.t_check('ON existing at 14 -> 14', public.t_desc(public.t_new('ex14')), '14|existing_partner|14|-');
SELECT public.t_check('ON existing whose only live portfolio is locked -> 20', public.t_desc(public.t_new('lockedonly')), '20|existing_partner|20|-');
SELECT public.t_check('ON pre-migration legacy 20 holder -> 20', public.t_desc(public.t_new('legacy20')), '20|existing_partner|20|-');
SELECT public.t_check('ON existing edited to 18 while off -> 18', public.t_desc(public.t_new('offtyped')), '18|existing_partner|18|-');
SELECT public.t_check('ON typed 20 by an existing 20 partner -> accepted, no request', public.t_desc(public.t_new('ex20', 20)), '20|existing_partner|20|-');
SELECT public.t_check('ON typed 25 by an existing 20 partner -> 20 + request(25)', public.t_desc(public.t_new('ex20', 25)), '20|existing_partner|20|25');
SELECT public.t_check('ON active employee -> 20 employee', public.t_desc(public.t_new('emp')), '20|employee|20|-');
SELECT public.t_check('ON employee who is also cohort 15 -> 20 employee', public.t_desc(public.t_new('emp_co')), '20|employee|20|-');
SELECT public.t_check('ON inactive ex-employee in cohort at 15 -> 15 existing_partner', public.t_desc(public.t_new('exemp')), '15|existing_partner|15|-');
SELECT public.t_check('ON signed agreement + live 20 at cut-off -> 20 existing_partner', public.t_desc(public.t_new('signed_live')), '20|existing_partner|20|-');
SELECT public.t_check('ON signed but countersigned (not cohort) -> 10 new', public.t_desc(public.t_new('signed_counter')), '10|new|10|-');
SELECT public.t_check('ON click-through acceptance only -> 10 new', public.t_desc(public.t_new('clickthru')), '10|new|10|-');
SELECT public.t_check('ON unsigned agreement draft -> 10 new', public.t_desc(public.t_new('unsigned')), '10|new|10|-');
SELECT public.t_check('ON only a pending_ops_approval portfolio at cut-off (not live) -> 10 new', public.t_desc(public.t_new('pending_only')), '10|new|10|-');
SELECT public.t_check('ON redeemed everything before the cut-off -> 10 new', public.t_desc(public.t_new('redeemed_before')), '10|new|10|-');

-- Cohort member who redeems everything after the cut-off, then comes back.
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE investor_id = public.pid('redeem');
SELECT public.t_check('ON cohort 20 member who redeemed everything -> 10 new', public.t_desc(public.t_new('redeem')), '10|new|10|-');
SELECT public.t_check('ON ... the same returning partner''s NEXT portfolio -> still 10 (a returner is NEW)', public.t_desc(public.t_new('redeem')), '10|new|10|-');

-- Signed written agreement, no live portfolio at the cut-off.
SELECT public.t_check('ON signed agreement (no portfolio) -> 15 signed_agreement', public.t_desc(public.t_new('signed')), '15|signed_agreement|15|-');
SELECT public.t_check('ON signed agreement, still 15 after funding one', public.t_desc(public.t_new('signed')), '15|signed_agreement|15|-');
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE investor_id = public.pid('signed');
SELECT public.t_check('ON signed agreement, 10 after redeeming all', public.t_rate('signed'), '10|new');
SELECT public.t_check('ON signed agreement, returns after redeeming all -> 10 new', public.t_desc(public.t_new('signed')), '10|new|10|-');
SELECT public.t_check('ON ... and their NEXT portfolio -> still 10 (a returner is NEW)', public.t_desc(public.t_new('signed')), '10|new|10|-');
SELECT public.t_check('ON signed agreement whose only portfolio was redeemed BEFORE the cut-off -> 15 signed_agreement',
  public.t_desc(public.t_new('signed_oldredeem')), '15|signed_agreement|15|-');

-- Promissory notes written before the cut-off (return_rate 15).
SELECT public.t_check('ON person linked to a pre-cut-off note, inside the window -> 15 promissory_note', public.t_rate('note1'), '15|promissory_note');
INSERT INTO public._t_ids SELECT 'note2_p', public.t_new('note2');
SELECT public.t_check('ON note person''s portfolio -> 15 promissory_note', public.t_desc(public.tid('note2_p')), '15|promissory_note|15|-');

-- Salary reinvestment (payroll sets a transaction-local context).
BEGIN;
SELECT set_config('app.partner_rate_context', 'salary_reinvestment', true) IS NULL AS x \gset
INSERT INTO public._t_ids SELECT 'sal_p', public.t_new('salp', 20);
SELECT public.t_check('ON salary context + 20 for a non-staff person -> 20 salary_reinvestment, no request', public.t_desc(public.tid('sal_p')), '20|salary_reinvestment|20|-');
SELECT public.t_check('ON salary context + 15 (not the employee rate) -> person''s rate + request', public.t_desc(public.t_new('salp2', 15)), '10|new|10|15');
COMMIT;
SELECT public.t_check('ON salary context is transaction-local (next insert at 20 is queued)', public.t_desc(public.t_new('salp3', 20)), '10|new|10|20');
SELECT public.t_check('ON typed 20 for a new partner without context -> 10 + request(20)', public.t_desc(public.t_new('newtyped20', 20)), '10|new|10|20');

-- Split / lock children.
SELECT public.t_check('ON split child of the mix 15 parent -> 15 carried (not the person''s 20)',
  public.t_desc(public.t_new('mix', NULL, 'locked', public.tid('mix15_p'))), '15|carried|15|-');
SELECT public.t_check('ON split child typed at the parent''s rate -> carried',
  public.t_desc(public.t_new('ex14', 14, 'locked', public.tid('ex14_p'))), '14|carried|14|-');
SELECT public.t_check('ON child pointing at a random parent -> treated as new',
  public.t_desc(public.t_new('splitrand', NULL, 'locked', gen_random_uuid())), '10|new|10|-');
SELECT public.t_check('ON child pointing at another investor''s 20 parent -> new, no carry',
  public.t_desc(public.t_new('splitforeign', NULL, 'locked', public.tid('ex20_p'))), '10|new|10|-');
SELECT public.t_check('ON child typed 20 pointing at another investor''s 20 parent -> 10 + request(20)',
  public.t_desc(public.t_new('splitforeign2', 20, 'locked', public.tid('ex20_p'))), '10|new|10|20');
SELECT public.t_check('ON investor_id NULL -> 10 new_no_investor', public.t_desc(public.t_new(NULL)), '10|new_no_investor|10|-');

-- A browser (agent) insert through RLS.
SELECT public.t_as('agent2') IS NULL AS x \gset
SET ROLE authenticated;
INSERT INTO public._t_ids SELECT 'agentins_p', public.t_new('agentnew', 20, 'active', NULL, 'agent2');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('ON agent (authenticated, RLS) typed 20 for a new partner -> 10 + request by the agent',
  public.t_desc(public.tid('agentins_p')) || '/' || (SELECT (requested_by = public.pid('agent2'))::text FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('agentins_p')),
  '10|new|10|20/true');

SELECT public.t_check('ON partner_new_contract_rate() = 10', trim_scale(public.partner_new_contract_rate())::text, '10');
SET ROLE anon;
SELECT public.t_check('ON anon reads the public policy (enabled, 10; no trailing zeros)',
  (SELECT (j ->> 'enabled') || '/' || (j ->> 'new_contract_rate') FROM (SELECT public.get_partner_return_policy() j) s), 'true/10');
RESET ROLE;
SELECT public.t_check('ON decider batch: distinct ids, NULLs dropped, one row each',
  (SELECT string_agg(trim_scale(r.rate)::text || ':' || r.basis, ',' ORDER BY r.basis, r.rate)
     FROM public.partner_rates_for(ARRAY[public.pid('new1'), public.pid('ex20'), public.pid('emp'), public.pid('exemp'),
                                         NULL, public.pid('ex20'), public.pid('ex14')]) r),
  '20:employee,14:existing_partner,15:existing_partner,20:existing_partner,10:new');

-- Mode and cap are settings.
UPDATE public.partner_return_policy SET existing_partner_cap = 15;
SELECT public.t_check('SET cap 15: 20 -> 15, 14 stays 14, employee still 20',
  public.t_rate('ex20') || ' ' || public.t_rate('ex14') || ' ' || public.t_rate('emp'), '15|existing_partner 14|existing_partner 20|employee');
UPDATE public.partner_return_policy SET existing_partner_cap = NULL, existing_partner_mode = 'fixed';
SELECT public.t_check('SET mode fixed (15): 20 -> 15, 10 -> 15',
  public.t_rate('ex20') || ' ' || public.t_rate('ex10'), '15|existing_partner 15|existing_partner');
UPDATE public.partner_return_policy SET existing_partner_mode = 'own';
SELECT public.t_check('SET back to own, no cap: 20 -> 20', public.t_rate('ex20'), '20|existing_partner');

-- ===========================================================================
-- NOTE. Promissory notes after the cut-off
-- ===========================================================================
WITH n AS (INSERT INTO public.promissory_notes (agent_id, partner_user_id, amount, return_rate, return_rate_basis)
           VALUES (public.pid('agent2'), NULL, 1000, 99, 'client') RETURNING id, return_rate, return_rate_basis),
     k AS (INSERT INTO public._t_ids SELECT 'note_unlinked', id FROM n RETURNING 1)
SELECT public.t_check('NOTE after the cut-off, no person -> 10 new (client 99 ignored)',
  (SELECT trim_scale(return_rate) || '/' || return_rate_basis FROM n), '10/new');
WITH n AS (INSERT INTO public.promissory_notes (agent_id, partner_user_id, amount, return_rate)
           VALUES (public.pid('agent2'), public.pid('ex20'), 1000, 5) RETURNING id, return_rate, return_rate_basis),
     k AS (INSERT INTO public._t_ids SELECT 'note_ex20', id FROM n RETURNING 1)
SELECT public.t_check('NOTE for an existing 20% partner -> 20 existing_partner (client 5 ignored)',
  (SELECT trim_scale(return_rate) || '/' || return_rate_basis FROM n), '20/existing_partner');
WITH n AS (INSERT INTO public.promissory_notes (agent_id, partner_user_id, amount)
           VALUES (public.pid('agent2'), public.pid('emp'), 1000) RETURNING return_rate, return_rate_basis)
SELECT public.t_check('NOTE for an employee -> 20 employee', (SELECT trim_scale(return_rate) || '/' || return_rate_basis FROM n), '20/employee');
WITH n AS (INSERT INTO public.promissory_notes (agent_id, partner_user_id, amount)
           VALUES (public.pid('agent2'), public.pid('notenew'), 1000) RETURNING return_rate, return_rate_basis)
SELECT public.t_check('NOTE for a brand-new person -> 10 new', (SELECT trim_scale(return_rate) || '/' || return_rate_basis FROM n), '10/new');
SELECT public.t_check('NOTE pre-cut-off notes still 15 legacy',
  (SELECT string_agg(DISTINCT trim_scale(n.return_rate)::text || '/' || n.return_rate_basis, ',') FROM public.promissory_notes n JOIN public._t_note_before b ON b.id = n.id), '15/legacy');

-- Browser (authenticated) updates. Production RLS (mirrored in race_stub.sql, round 4): only admin roles can read and update
-- any note; an agent has no read policy, so its UPDATE ... WHERE reaches none of its notes. The guard is tested as the COO.
SELECT public.t_as('agent1') IS NULL AS x \gset
SET ROLE authenticated;
WITH u AS (UPDATE public.promissory_notes SET amount = amount + 1 WHERE partner_user_id = public.pid('notemove') RETURNING 1)
SELECT public.t_check('NOTE an agent''s browser UPDATE of its own pending note reaches no row (production RLS: no agent read policy)',
  (SELECT count(*) FROM u)::text, '0');
RESET ROLE;
SELECT public.t_as('coo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_raises('NOTE browser cannot change return_rate',
  $q$UPDATE public.promissory_notes SET return_rate = 20 WHERE partner_user_id = public.pid('notemove')$q$, '42501');
SELECT public.t_raises('NOTE browser cannot change return_rate_basis',
  $q$UPDATE public.promissory_notes SET return_rate_basis = 'employee' WHERE partner_user_id = public.pid('notemove')$q$, '42501');
SELECT public.t_raises('NOTE browser cannot move a note from one person to another',
  $q$UPDATE public.promissory_notes SET partner_user_id = public.pid('ex20') WHERE partner_user_id = public.pid('notemove')$q$, '42501');
SELECT public.t_raises('NOTE browser cannot unlink a note (person -> NULL)',
  $q$UPDATE public.promissory_notes SET partner_user_id = NULL WHERE partner_user_id = public.pid('notemove')$q$, '42501');
SELECT public.t_raises('NOTE after the cut-off a browser cannot link a note that had no person',
  $q$UPDATE public.promissory_notes SET partner_user_id = public.pid('notelinked')
      WHERE partner_user_id IS NULL AND agent_id = public.pid('agent1') AND recorded_on < current_date - 50$q$, '42501');
WITH u AS (UPDATE public.promissory_notes SET amount = amount + 1 WHERE partner_user_id = public.pid('notemove') RETURNING 1)
SELECT public.t_check('NOTE browser (COO, admin policy) can still edit other fields of a pending note', (SELECT count(*) FROM u)::text, '1');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
-- The owner's linking tools (SECURITY DEFINER) still link it, and the note keeps its 15.
WITH u AS (UPDATE public.promissory_notes SET partner_user_id = public.pid('notelinked')
            WHERE id = (SELECT id FROM public.promissory_notes
                         WHERE partner_user_id IS NULL AND agent_id = public.pid('agent1') AND recorded_on < current_date - 50
                         ORDER BY id LIMIT 1)
            RETURNING return_rate, return_rate_basis)
SELECT public.t_check('NOTE the owner links a note that had no person (keeps its 15 legacy)',
  (SELECT count(*) || ':' || COALESCE(string_agg(trim_scale(return_rate) || '/' || return_rate_basis, ','), '') FROM u), '1:15/legacy');
SELECT public.t_check('NOTE the linked person now earns the note''s 15 (inside the window)', public.t_rate('notelinked'), '15|promissory_note');
WITH u AS (UPDATE public.promissory_notes SET return_rate = 12 WHERE partner_user_id = public.pid('notemove') RETURNING return_rate)
SELECT public.t_check('NOTE database owner can change return_rate', (SELECT trim_scale(return_rate)::text FROM u), '12');
WITH u AS (UPDATE public.promissory_notes SET partner_user_id = public.pid('notemove2') WHERE partner_user_id = public.pid('notemove') RETURNING 1)
SELECT public.t_check('NOTE database owner can move a note', (SELECT count(*) FROM u)::text, '1');

-- ===========================================================================
-- WIN. Note window expiry (frozen windows moved into the past with their guard disabled, as postgres)
-- ===========================================================================
CREATE TABLE public._t_windows AS SELECT * FROM public.partner_return_note_windows;
ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER trg_partner_return_note_windows_guard;
UPDATE public.partner_return_note_windows SET ends_on = current_date - 1;
ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER trg_partner_return_note_windows_guard;
SELECT public.t_check('WIN window expired, no note-funded live portfolio -> 10 new', public.t_rate('note1'), '10|new');
SELECT public.t_check('WIN window expired, live note-funded portfolio -> keeps 15', public.t_rate('note2'), '15|promissory_note');
SELECT public.t_check('WIN new portfolio for that person -> 15 promissory_note', public.t_desc(public.t_new('note2')), '15|promissory_note|15|-');
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE investor_id = public.pid('note2');
SELECT public.t_check('WIN note-funded portfolios redeemed -> 10 new', public.t_rate('note2'), '10|new');
ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER trg_partner_return_note_windows_guard;
UPDATE public.partner_return_note_windows w SET ends_on = t.ends_on FROM public._t_windows t WHERE t.note_id = w.note_id;
ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER trg_partner_return_note_windows_guard;
SELECT public.t_check('WIN windows restored', (SELECT count(*) FROM public.partner_return_note_windows w
  JOIN public._t_windows t ON t.note_id = w.note_id AND t.ends_on = w.ends_on)::text,
  (SELECT count(*) FROM public._t_windows)::text);
DROP TABLE public._t_windows;

-- ===========================================================================
-- UPD. Changing an existing portfolio's rate with the switch on
-- ===========================================================================
UPDATE public.investor_portfolios SET roi_percentage = 15 WHERE id = public.tid('upd_a');
SELECT public.t_check('UPD 20 -> 15 on an existing portfolio: stays 20, pending request(15)', public.t_desc(public.tid('upd_a')), '20|typed_switch_off|20|15');
SELECT public.t_check('UPD request shape: rate_change, in force 20',
  (SELECT source || '/' || trim_scale(rate_in_force) || '/' || trim_scale(standard_rate) FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('upd_a') AND status = 'pending'),
  'rate_change/20/20');
UPDATE public.investor_portfolios SET roi_percentage = 20 WHERE id = public.tid('upd_b');
SELECT public.t_check('UPD same value is a no-op (no request)', (SELECT count(*) FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('upd_b'))::text, '0');
UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id = public.tid('upd_a');
SELECT public.t_check('UPD a newer change supersedes the open one',
  (SELECT string_agg(status || ':' || trim_scale(requested_rate), ',' ORDER BY requested_at) FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('upd_a')),
  'superseded:15,pending:12');
UPDATE public.investor_portfolios SET entitled_rate = 99, rate_basis = 'hacked', rate_decided_at = '2000-01-01' WHERE id = public.tid('new1_p');
SELECT public.t_check('UPD decision stamps cannot be changed by UPDATE',
  (SELECT trim_scale(entitled_rate) || '/' || rate_basis || '/' || (rate_decided_at > '2001-01-01')::text FROM public.investor_portfolios WHERE id = public.tid('new1_p')),
  '10/new/true');
UPDATE public.investor_portfolios SET status = 'active', investment_amount = investment_amount + 1000 WHERE id = public.tid('ex15_p');
SELECT public.t_check('UPD a top-up (amount) leaves the rate and queues nothing',
  public.t_desc(public.tid('ex15_p')), '15|typed_switch_off|15|-');
SELECT public.t_as('cfo') IS NULL AS x \gset
WITH r AS (SELECT public.set_portfolio_renewal_rate(public.tid('renew'), 15) j)
SELECT public.t_check('RENEW same rate -> no request',
  (SELECT (j ->> 'awaits_cfo') || '/' || (j ->> 'rate_in_force') FROM r) || '/' || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('renew')),
  'false/15/0');
WITH r AS (SELECT public.set_portfolio_renewal_rate(public.tid('renew'), 20) j)
SELECT public.t_check('RENEW different rate -> awaits CFO, rate in force kept', (SELECT (j ->> 'awaits_cfo') || '/' || (j ->> 'rate_in_force') FROM r), 'true/15');
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_raises('RENEW plain agent refused', $q$SELECT public.set_portfolio_renewal_rate(public.tid('renew'), 18)$q$, '42501');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('RENEW apply_portfolio_renewal keeps the stored rate',
  (public.apply_portfolio_renewal(public.tid('ex20_p'), public.pid('cfo')) ->> 'roi_percentage'), '20');

-- ===========================================================================
-- CFO. Decide, then apply from the next cycle
-- ===========================================================================
UPDATE public.investor_portfolios SET roi_percentage = 18 WHERE id = public.tid('cfo1');
SELECT public.t_vset('req_cfo1', (SELECT id::text FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('cfo1') AND status = 'pending'));
SELECT public.t_as('superadmin') IS NULL AS x \gset
SELECT public.t_raises('CFO super_admin cannot decide', $q$SELECT public.cfo_decide_portfolio_rate_requests(ARRAY[public.t_v('req_cfo1')::uuid], 'approve', 'x')$q$, '42501');
SELECT public.t_as('ceo') IS NULL AS x \gset
SELECT public.t_raises('CFO the CEO cannot decide', $q$SELECT public.cfo_decide_portfolio_rate_requests(ARRAY[public.t_v('req_cfo1')::uuid], 'approve', 'x')$q$, '42501');
SELECT public.t_as('cfo') IS NULL AS x \gset
SELECT public.t_raises('CFO reject needs a reason', $q$SELECT public.cfo_decide_portfolio_rate_requests(ARRAY[public.t_v('req_cfo1')::uuid], 'reject', NULL)$q$, 'A reason is required%');
SELECT public.t_check('CFO approves (decided 1, applies next_cycle)',
  (SELECT (j ->> 'decided') || '/' || (j ->> 'applies') FROM (SELECT public.cfo_decide_portfolio_rate_requests(ARRAY[public.t_v('req_cfo1')::uuid, public.t_v('req_cfo1')::uuid], 'approve', 'ok') j) s),
  '1/next_cycle');
SELECT public.t_check('CFO approving again is idempotent (skipped)',
  (SELECT (j ->> 'decided') || '/' || (j ->> 'skipped') FROM (SELECT public.cfo_decide_portfolio_rate_requests(ARRAY[public.t_v('req_cfo1')::uuid], 'approve', 'again') j) s), '0/1');
SELECT public.t_check('CFO queue shows approved_next_cycle and the rate is unchanged',
  (SELECT stage || '/' || trim_scale(current_rate) FROM public.list_portfolio_rate_requests(NULL, 500) WHERE request_id = public.t_v('req_cfo1')::uuid), 'approved_next_cycle/15');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('JOB no Returns event yet -> waits',
  (public.apply_due_portfolio_rate_changes() ->> 'applied') || '/' || public.t_roi(public.tid('cfo1')), '0/15');
INSERT INTO public.pending_wallet_operations (source_id, source_table, category, status, reviewed_at)
VALUES (public.tid('cfo1'), 'investor_portfolios', 'roi_payout', 'approved', now() - interval '20 days');
SELECT public.t_check('JOB last payout 20 days before the approval (outside grace) -> waits',
  (public.apply_due_portfolio_rate_changes() ->> 'applied') || '/' || public.t_roi(public.tid('cfo1')), '0/15');
INSERT INTO public.pending_wallet_operations (source_id, source_table, category, status, reviewed_at)
VALUES (public.tid('cfo1'), 'investor_portfolios', 'roi_payout', 'completed', now());
SELECT public.t_check('JOB payout reviewed after the approval -> applied (18)',
  (public.apply_due_portfolio_rate_changes() ->> 'applied') || '/' || public.t_roi(public.tid('cfo1')), '1/18');
SELECT public.t_check('JOB request marked applied; second run applies nothing',
  (SELECT (applied_at IS NOT NULL)::text FROM public.portfolio_rate_approvals WHERE id = public.t_v('req_cfo1')::uuid) || '/'
  || (public.apply_due_portfolio_rate_changes() ->> 'applied'), 'true/0');
SELECT public.t_check('JOB audit row written', (SELECT count(*) FROM public.audit_logs WHERE action_type = 'portfolio_rate_applied_next_cycle' AND record_id = public.tid('cfo1')::text)::text, '1');
-- Grace: payout 3 days ago, approval now -> joins this cycle.
INSERT INTO public.pending_wallet_operations (source_id, source_table, category, status, reviewed_at)
VALUES (public.tid('cfo2'), 'investor_portfolios', 'roi_payout', 'approved', now() - interval '3 days');
UPDATE public.investor_portfolios SET roi_percentage = 17 WHERE id = public.tid('cfo2');
SELECT public.t_as('cfo') IS NULL AS x \gset
SELECT (public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('cfo2') AND status = 'pending'), 'approve', 'ok') ->> 'decided') AS d \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('JOB approval within 10 days after a payout -> applies now',
  (public.apply_due_portfolio_rate_changes() ->> 'applied') || '/' || public.t_roi(public.tid('cfo2')), '1/17');
-- Compounding: the next compounding after the approval is the cycle event.
UPDATE public.investor_portfolios SET roi_mode = 'monthly_compounding' WHERE id = public.tid('cfo3');
UPDATE public.investor_portfolios SET roi_percentage = 16 WHERE id = public.tid('cfo3');
SELECT public.t_as('cfo') IS NULL AS x \gset
SELECT (public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('cfo3') AND status = 'pending'), 'approve', 'ok') ->> 'decided') AS d \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('JOB compounding portfolio, no compounding since approval -> waits', (public.apply_due_portfolio_rate_changes() ->> 'applied'), '0');
INSERT INTO public.audit_logs (action_type, table_name, record_id) VALUES ('roi_compounded', 'investor_portfolios', public.tid('cfo3')::text);
SELECT public.t_check('JOB compounding after the approval -> applies',
  (public.apply_due_portfolio_rate_changes() ->> 'applied') || '/' || public.t_roi(public.tid('cfo3')), '1/16');

-- Self-managed money: commitment, funding lines and supported houses move with the portfolio.
DO $$
DECLARE c1 uuid; c2 uuid;
BEGIN
  INSERT INTO public.partner_self_commitments (partner_id, monthly_rate) VALUES (public.pid('selfp'), 15) RETURNING id INTO c1;
  INSERT INTO public.partner_self_commitments (partner_id, monthly_rate) VALUES (public.pid('selfp2'), 15) RETURNING id INTO c2;
  INSERT INTO public._t_ids VALUES ('c1', c1), ('c2', c2);
  INSERT INTO public.funder_pending_portfolios (portfolio_id, commitment_id) VALUES (public.tid('selfp'), c1);
  WITH x AS (INSERT INTO public.partner_self_funding_lines (commitment_id, monthly_rate) VALUES (c1, 15) RETURNING id) INSERT INTO public._t_ids SELECT 'l1', id FROM x;
  WITH x AS (INSERT INTO public.partner_self_funding_lines (commitment_id, monthly_rate, completed_at) VALUES (c1, 15, now()) RETURNING id) INSERT INTO public._t_ids SELECT 'l2', id FROM x;
  WITH x AS (INSERT INTO public.partner_self_funding_lines (commitment_id, monthly_rate, status) VALUES (c1, 15, 'cancelled') RETURNING id) INSERT INTO public._t_ids SELECT 'l3', id FROM x;
  WITH x AS (INSERT INTO public.partner_self_funding_lines (commitment_id, monthly_rate) VALUES (c2, 15) RETURNING id) INSERT INTO public._t_ids SELECT 'l4', id FROM x;
  WITH x AS (INSERT INTO public.partner_supported_houses (portfolio_id, commitment_id, monthly_rate) VALUES (public.tid('selfp'), c1, 15) RETURNING id) INSERT INTO public._t_ids SELECT 'h1', id FROM x;
  WITH x AS (INSERT INTO public.partner_supported_houses (portfolio_id, commitment_id, monthly_rate, cancelled_at) VALUES (public.tid('selfp'), c1, 15, now()) RETURNING id) INSERT INTO public._t_ids SELECT 'h2', id FROM x;
  WITH x AS (INSERT INTO public.partner_supported_houses (portfolio_id, commitment_id, monthly_rate) VALUES (public.tid('selfp2'), c2, 15) RETURNING id) INSERT INTO public._t_ids SELECT 'h3', id FROM x;
END $$;
UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id IN (public.tid('selfp'), public.tid('selfp2'));
SELECT public.t_as('cfo') IS NULL AS x \gset
SELECT (public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id IN (public.tid('selfp'), public.tid('selfp2')) AND status = 'pending'), 'approve', 'ok') ->> 'decided') AS d \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_vset('notices_before', (SELECT count(*)::text FROM public._house_notice_log));
SELECT public.t_check('SELF no paid self-support cycle yet -> waits', (public.apply_due_portfolio_rate_changes() ->> 'applied'), '0');
INSERT INTO public.partner_self_payout_cycles (commitment_id, paid_at) VALUES (public.tid('c1'), now() - interval '40 days');
SELECT public.t_check('SELF cycle paid 40 days before the approval -> waits', (public.apply_due_portfolio_rate_changes() ->> 'applied'), '0');
INSERT INTO public.partner_self_payout_cycles (commitment_id, paid_at) VALUES (public.tid('c1'), now()), (public.tid('c2'), now());
SELECT public.t_check('SELF cycles paid after the approval -> both applied (via funder_pending_portfolios and via houses)',
  (public.apply_due_portfolio_rate_changes() ->> 'applied'), '2');
SELECT public.t_check('SELF portfolio, commitment, open line, live house moved; completed/cancelled rows untouched',
  (SELECT string_agg(k || '=' || v, ' ' ORDER BY k) FROM (
     SELECT 'p1' k, trim_scale(roi_percentage)::text v FROM public.investor_portfolios WHERE id = public.tid('selfp')
     UNION ALL SELECT 'p2', trim_scale(roi_percentage)::text FROM public.investor_portfolios WHERE id = public.tid('selfp2')
     UNION ALL SELECT 'c1', trim_scale(monthly_rate)::text FROM public.partner_self_commitments WHERE id = public.tid('c1')
     UNION ALL SELECT 'c2', trim_scale(monthly_rate)::text FROM public.partner_self_commitments WHERE id = public.tid('c2')
     UNION ALL SELECT t.k, trim_scale(l.monthly_rate)::text FROM public.partner_self_funding_lines l JOIN public._t_ids t ON t.id = l.id
     UNION ALL SELECT t.k, trim_scale(h.monthly_rate)::text FROM public.partner_supported_houses h JOIN public._t_ids t ON t.id = h.id) s),
  'c1=12 c2=12 h1=12 h2=15 h3=12 l1=12 l2=15 l3=15 l4=12 p1=12 p2=12');
SELECT 'INFO  SELF the job''s house rate update fired trg_funder_house_progress_notices ' ||
       ((SELECT count(*) FROM public._house_notice_log) - public.t_v('notices_before')::int) || ' time(s) (production trigger: check it sends nothing on a rate-only change)';

-- ===========================================================================
-- MON. Conformance, assert, drift recorder, alert emails
-- ===========================================================================
SELECT public.t_check('MON conformance empty after normal operations', (SELECT count(*) FROM public.partner_rate_conformance())::text, '0');
SELECT public.t_check('MON assert all ok on a healthy setup (cron stub)',
  (SELECT COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') || '/' || count(*) FROM public.assert_partner_return_policy_intact()), 'all ok/12');
SELECT public.t_check('MON drift recorder on a healthy setup opens nothing', public.record_partner_return_policy_drift()::text, '0');
SELECT public.t_vset('emails', public.t_emails()::text);
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;
UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id = public.tid('new1_p');
ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy;
SELECT public.t_check('MON conformance returns the forced mismatch',
  (SELECT string_agg(portfolio_id::text || ':' || issue || ':' || trim_scale(stored_rate) || '/' || trim_scale(entitled_rate), ',') FROM public.partner_rate_conformance()),
  public.tid('new1_p')::text || ':rate_differs_without_cfo_request:12/10');
SELECT public.t_check('MON drift recorder opens one event', public.record_partner_return_policy_drift()::text, '1');
SELECT public.t_check('MON open event is partner_rate.rates_conform; FAILED email to CEO+CFO; system event',
  (SELECT string_agg(check_name, ',') FROM public.money_path_drift_events WHERE resolved_at IS NULL) || '/'
  || (public.t_emails() - public.t_v('emails')::int) || '/'
  || (SELECT string_agg(DISTINCT payload ->> 'subject', ',') FROM public._email_outbox WHERE id > public.t_v('emails')::int) || '/'
  || (SELECT count(*) FROM public.system_events WHERE event_type = 'partner_rate_drift_detected'),
  'partner_rate.rates_conform/2/Partner Returns check FAILED/1');
SELECT public.t_vset('emails', public.t_emails()::text);
SELECT public.t_check('MON second run: nothing opened, no new email',
  public.record_partner_return_policy_drift()::text || '/' || (public.t_emails() - public.t_v('emails')::int), '0/0');
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;
UPDATE public.investor_portfolios SET roi_percentage = 10 WHERE id = public.tid('new1_p');
ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy;
SELECT public.t_vset('rec', public.record_partner_return_policy_drift()::text);
SELECT public.t_check('MON after the fix: recorder resolves the event and sends one recovered email pair',
  public.t_v('rec') || '/'
  || (SELECT count(*) FROM public.money_path_drift_events WHERE resolved_at IS NULL) || '/'
  || (SELECT count(*) FROM public.money_path_drift_events WHERE check_name = 'partner_rate.rates_conform' AND resolved_at IS NOT NULL) || '/'
  || (public.t_emails() - public.t_v('emails')::int) || '/'
  || COALESCE((SELECT string_agg(DISTINCT payload ->> 'subject', ',') FROM public._email_outbox WHERE id > public.t_v('emails')::int), 'no email'),
  '0/0/1/2/Partner Returns check recovered');
SELECT public.t_vset('emails', public.t_emails()::text);
SELECT public.t_check('MON third run quiet', public.record_partner_return_policy_drift()::text || '/' || (public.t_emails() - public.t_v('emails')::int), '0/0');
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;
SELECT public.t_check('MON assert reports a disabled gate trigger',
  (SELECT string_agg(check_name, ',') FILTER (WHERE NOT ok) FROM public.assert_partner_return_policy_intact()), 'gate_trigger_enabled');
ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy;
SELECT public.t_check('MON assert all ok again', (SELECT COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()), 'all ok');

-- ===========================================================================
-- OFF2. Switch turned off AFTER the cut-off (CEO), staff edit a post-cut-off portfolio directly
--       (allowed while off: "everything behaves exactly as today"), then switched back on.
-- ===========================================================================
SELECT public.t_as('ceo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT (public.set_partner_return_policy(false) ->> 'changed') AS c \gset
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
INSERT INTO public._t_ids SELECT 'off2_new', public.t_new('off2person');
SELECT public.t_check('OFF2 new portfolio after the cut-off while off -> 15 switch_off', public.t_desc(public.tid('off2_new')), '15|switch_off|15|-');
INSERT INTO public._t_ids SELECT 'off2_edit', public.t_new('off2edit', 13);
UPDATE public.investor_portfolios SET roi_percentage = 14 WHERE id = public.tid('off2_edit');
SELECT public.t_check('OFF2 direct edit while off applies (14)', public.t_desc(public.tid('off2_edit')), '14|typed_switch_off|13|-');
SELECT public.t_as('ceo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT (public.set_partner_return_policy(true) ->> 'changed') AS c \gset
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('OFF2 a legitimate edit made while the switch was off is not reported as drift',
  (SELECT COALESCE(string_agg(issue, ','), 'none') FROM public.partner_rate_conformance()), 'none');
SELECT public.t_check('OFF2 the cohort did not grow on the second ON', ((SELECT count(*) FROM public.partner_return_cohort)::text = public.t_v('cohort_n'))::text, 'true');
-- put the off2 edit back so later checks are not affected
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;
UPDATE public.investor_portfolios SET roi_percentage = 13 WHERE id = public.tid('off2_edit');
ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy;

-- ===========================================================================
-- N+1. One decider call per insert; one call for 1000 people
-- ===========================================================================
SELECT pg_stat_reset() IS NULL AS x \gset
SELECT pg_stat_force_next_flush() IS NULL AS x \gset
SELECT 1 AS x \gset
BEGIN;
SET LOCAL track_functions = 'all';
DO $$ BEGIN PERFORM public.t_new('nplus1'); END $$;
SELECT public.t_check('N+1 one portfolio insert calls partner_rates_for exactly once',
  (SELECT COALESCE(sum(calls), 0) FROM pg_stat_xact_user_functions WHERE schemaname = 'public' AND funcname = 'partner_rates_for')::text, '1');
SELECT public.t_check('N+1 ... and the gate exactly once',
  (SELECT COALESCE(sum(calls), 0) FROM pg_stat_xact_user_functions WHERE schemaname = 'public' AND funcname = 'enforce_partner_return_rate_policy')::text, '1');
SELECT 'INFO  N+1 functions called by one insert: ' || string_agg(funcname || 'x' || calls, ', ' ORDER BY funcname)
  FROM pg_stat_xact_user_functions WHERE schemaname = 'public' AND funcname NOT LIKE 't\_%';
COMMIT;
SELECT pg_stat_force_next_flush() IS NULL AS x \gset
SELECT 1 AS x \gset
BEGIN;
SET LOCAL track_functions = 'all';
CREATE TEMP TABLE _t_n1k ON COMMIT DROP AS
  SELECT * FROM public.partner_rates_for(
    ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 990))
    || ARRAY(SELECT public.pid(x) FROM unnest(ARRAY['ex20','emp','signed','note2','new1','mix','ex14','ex10','lockedonly','legacy20']) x));
SELECT public.t_check('N+1 partner_rates_for over 1000 ids returns 1000 rows', (SELECT count(*) FROM _t_n1k)::text, '1000');
SELECT public.t_check('N+1 ... in one call',
  (SELECT COALESCE(sum(calls), 0) FROM pg_stat_xact_user_functions WHERE schemaname = 'public' AND funcname = 'partner_rates_for')::text, '1');
SELECT 'INFO  N+1 1000-id call: ' || (SELECT string_agg(basis || '=' || n, ' ' ORDER BY basis) FROM (SELECT basis, count(*) n FROM _t_n1k GROUP BY basis) s)
       || '; time ' || round((SELECT total_time FROM pg_stat_xact_user_functions WHERE funcname = 'partner_rates_for')::numeric, 1) || ' ms';
COMMIT;


-- ===========================================================================
-- V2. Review fixes (2026-11-06)
-- ===========================================================================
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT set_config('request.jwt.claim.role', '', false) IS NULL AS x \gset
SELECT public.set_partner_return_policy(true) IS NULL AS x \gset

SELECT public.t_check('V2 every SECURITY DEFINER function of the build puts pg_temp last',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND p.proname IN ('partner_rates_for','partner_rate_for','partner_note_rate_for','partner_new_contract_rate',
                        'partner_return_cutoff_at','partner_return_policy_guard','stamp_promissory_note_return_rate',
                        'enforce_partner_return_rate_policy','_partner_return_alert','set_partner_return_policy',
                        'cfo_decide_portfolio_rate_requests','apply_due_portfolio_rate_changes','set_portfolio_renewal_rate',
                        'partner_rate_conformance','assert_partner_return_policy_intact','record_partner_return_policy_drift')
      AND array_to_string(p.proconfig, ',') NOT LIKE '%search_path=public, pg_temp%')::text, '0');
SELECT public.t_check('V2 service_role: SELECT only on CFO requests and note windows; browsers none',
  has_table_privilege('service_role', 'public.portfolio_rate_approvals', 'INSERT')::text || '/'
  || has_table_privilege('service_role', 'public.portfolio_rate_approvals', 'UPDATE')::text || '/'
  || has_table_privilege('service_role', 'public.partner_return_note_windows', 'SELECT')::text || '/'
  || has_table_privilege('authenticated', 'public.partner_return_note_windows', 'SELECT')::text, 'false/false/true/false');

-- Readiness and audited settings
SELECT public.set_partner_return_policy(false) IS NULL AS x \gset
SELECT public.t_vset('aud0', (SELECT count(*) FROM public.audit_logs WHERE action_type = 'partner_return_policy_settings_changed')::text) IS NULL AS x \gset
SELECT public.t_vset('em0', public.t_emails()::text) IS NULL AS x \gset
UPDATE public.partner_return_policy SET release_ready = false;
SELECT public.t_check('V2 a settings change is audited once',
  ((SELECT count(*) FROM public.audit_logs WHERE action_type = 'partner_return_policy_settings_changed') - public.t_v('aud0')::int)::text, '1');
SELECT public.t_check('V2 ... and emailed to the CEO and CFO', (public.t_emails() - public.t_v('em0')::int)::text, '2');
SELECT public.t_as('ceo') IS NULL AS x \gset
SELECT public.t_raises('V2 the CEO cannot turn it on before the release is marked ready (release_ready)',
  'SELECT public.set_partner_return_policy(true)',
  'Partner Returns cannot be turned on yet: the release (creation paths, agreements, edge functions and screens using each person''s rate) is not complete');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_raises('V2 nor can a database-owner session', 'UPDATE public.partner_return_policy SET enabled = true', '55000');
UPDATE public.partner_return_policy SET release_ready = true;
-- Ready, but a check the rule depends on fails: switch-on refused, naming the failing checks (sorted).
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;
SELECT public.t_as('ceo') IS NULL AS x \gset
SELECT public.t_raises('V2 ready, but the portfolio gate is disabled: the CEO''s switch-on is refused naming gate_trigger_enabled',
  'SELECT public.set_partner_return_policy(true)',
  'Partner Returns cannot be turned on: these checks fail: gate_trigger_enabled (see assert_partner_return_policy_intact())');
SELECT public.t_as(NULL) IS NULL AS x \gset
UPDATE cron.job SET active = false WHERE jobname = 'apply-portfolio-rate-changes-705pm';
SELECT public.t_raises('V2 ... gate disabled AND the next-cycle job paused: a database-owner switch-on is refused naming both',
  'UPDATE public.partner_return_policy SET enabled = true',
  'Partner Returns cannot be turned on: these checks fail: cron_jobs_scheduled, gate_trigger_enabled (see assert_partner_return_policy_intact())');
ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy;
ALTER TABLE public.promissory_notes DISABLE TRIGGER trg_zz_guard_note_return_rate;
SELECT public.t_raises('V2 ... job paused and the note guard disabled: refused naming cron_jobs_scheduled, note_triggers_enabled',
  'UPDATE public.partner_return_policy SET enabled = true',
  'Partner Returns cannot be turned on: these checks fail: cron_jobs_scheduled, note_triggers_enabled (see assert_partner_return_policy_intact())');
ALTER TABLE public.promissory_notes ENABLE TRIGGER trg_zz_guard_note_return_rate;
UPDATE cron.job SET active = true WHERE jobname = 'apply-portfolio-rate-changes-705pm';
SELECT public.t_check('V2 ... the refused switch-ons changed nothing (still off)', (SELECT enabled::text FROM public.partner_return_policy), 'false');

-- While OFF: only the COO/manager may set a renewal rate (as today); an edit after the cut-off is recorded
SELECT public.t_vset('v2renew', public.t_new('v2renew')::text) IS NULL AS x \gset
SELECT public.t_as('cfo') IS NULL AS x \gset
SELECT public.t_raises('V2 switch off: the CFO cannot set a Returns rate directly',
  format('SELECT public.set_portfolio_renewal_rate(%L, 18)', public.t_v('v2renew')), '42501');
SELECT public.t_as('coo') IS NULL AS x \gset
SELECT public.t_check('V2 switch off: the COO can, as today',
  (public.set_portfolio_renewal_rate(public.t_v('v2renew')::uuid, 18) ->> 'rate_in_force'), '18');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('V2 ... and after a cut-off the edit is recorded as an applied request',
  (SELECT count(*) FROM public.portfolio_rate_approvals WHERE portfolio_id = public.t_v('v2renew')::uuid
      AND status = 'approved' AND applied_at IS NOT NULL AND requested_rate = 18)::text, '1');
SELECT public.set_partner_return_policy(true) IS NULL AS x \gset
SELECT public.t_check('V2 ON again once Phase 2 is ready', (SELECT enabled::text FROM public.partner_return_policy), 'true');
SELECT public.t_check('V2 conformance stays empty', (SELECT COALESCE(string_agg(issue, ','), 'none') FROM public.partner_rate_conformance()), 'none');

-- The service role cannot decide CFO requests
SELECT set_config('request.jwt.claim.role', 'service_role', false) IS NULL AS x \gset
SELECT public.t_raises('V2 the service role cannot decide CFO requests',
  $q$SELECT public.cfo_decide_portfolio_rate_requests(ARRAY[gen_random_uuid()], 'approve', 'x')$q$, '42501');
SELECT set_config('request.jwt.claim.role', '', false) IS NULL AS x \gset

-- Carved-off portfolios
SELECT public.t_vset('ex20_parent', (SELECT id::text FROM public.investor_portfolios
  WHERE investor_id = public.pid('ex20') AND status = 'active' ORDER BY id LIMIT 1)) IS NULL AS x \gset
SELECT public.t_as('agent1') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_raises('V2 a browser cannot create a carved-off portfolio',
  format($q$INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, locked_from_portfolio_id)
            VALUES (%L, %L, 'V2-X', 1, 'active', %L)$q$, public.pid('ex20'), public.pid('agent1'), public.t_v('ex20_parent')), '42501');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;
WITH i AS (INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, roi_percentage)
           VALUES (public.pid('v2ret'), public.pid('agent1'), 'V2-RET', 100, 'redeemed', 20) RETURNING id)
SELECT public.t_vset('v2ret_parent', (SELECT id::text FROM i)) IS NULL AS x \gset
ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy;
SELECT public.t_check('V2 a child of a REDEEMED parent is not carried',
  public.t_desc(public.t_new('v2ret', NULL, 'active', public.t_v('v2ret_parent')::uuid)), '10|new|10|-');
SELECT public.t_check('V2 a portfolio created after the cut-off without passing the gate is flagged',
  (SELECT string_agg(issue, ',') FROM public.partner_rate_conformance() WHERE portfolio_id = public.t_v('v2ret_parent')::uuid), 'missing_decision_stamp');
SELECT public.set_partner_return_policy(false) IS NULL AS x \gset
SELECT public.t_check('V2 with that conformance problem open, only rates_conform fails ...',
  (SELECT string_agg(check_name, ',' ORDER BY check_name) FILTER (WHERE NOT ok) FROM public.assert_partner_return_policy_intact()), 'rates_conform');
SELECT public.t_check('V2 ... and it does not block a switch-on (history, not a precondition)', (public.set_partner_return_policy(true) ->> 'changed'), 'true');
DELETE FROM public.investor_portfolios WHERE id = public.t_v('v2ret_parent')::uuid;

-- Salary reinvestment with no rate typed
BEGIN;
SELECT set_config('app.partner_rate_context', 'salary_reinvestment', true) IS NULL AS x \gset
SELECT public.t_check('V2 salary context with no rate -> 20 salary_reinvestment (a leaver too)',
  public.t_desc(public.t_new('v2leaver')), '20|salary_reinvestment|20|-');
COMMIT;

-- Invite portfolio decided again when its investor arrives
SELECT public.t_vset('inv', public.t_new(NULL)::text) IS NULL AS x \gset
SELECT public.t_check('V2 invite portfolio (no investor yet) -> 10 new_no_investor', public.t_desc(public.t_v('inv')::uuid), '10|new_no_investor|10|-');
UPDATE public.investor_portfolios SET investor_id = public.pid('ex20') WHERE id = public.t_v('inv')::uuid;
SELECT public.t_check('V2 ... an existing 20% partner activates it -> 20 existing_partner', public.t_desc(public.t_v('inv')::uuid), '20|existing_partner|20|-');

-- Note windows are frozen; notes written after the cut-off add nothing; closed notes count for nothing
SELECT public.t_vset('w0', (SELECT max(w.ends_on)::text FROM public.partner_return_note_windows w
  JOIN public.promissory_notes n ON n.id = w.note_id WHERE n.partner_user_id = public.pid('notelinked'))) IS NULL AS x \gset
UPDATE public.promissory_notes SET fulfilment_due_on = DATE '2099-01-01' WHERE partner_user_id = public.pid('notelinked');
SELECT public.t_check('V2 editing a note''s due date after the cut-off does not stretch its window',
  ((SELECT max(w.ends_on)::text FROM public.partner_return_note_windows w
     JOIN public.promissory_notes n ON n.id = w.note_id WHERE n.partner_user_id = public.pid('notelinked')) = public.t_v('w0'))::text, 'true');
SELECT public.t_check('V2 the linked person is still on the note''s 15', public.t_rate('notelinked'), '15|promissory_note');
SELECT public.t_vset('wn', (SELECT count(*) FROM public.partner_return_note_windows)::text) IS NULL AS x \gset
WITH i AS (INSERT INTO public.promissory_notes (agent_id, partner_user_id, amount, status, fulfilment_due_on)
           VALUES (public.pid('agent1'), public.pid('notelinked'), 1000, 'pending', current_date + 400)
           RETURNING return_rate, return_rate_basis)
SELECT public.t_check('V2 a note written now for someone inside a 15% note window carries their base rate (10)',
  (SELECT trim_scale(return_rate) || '/' || return_rate_basis FROM i), '10/new');
SELECT public.t_check('V2 ... and opens no new window', ((SELECT count(*) FROM public.partner_return_note_windows)::text = public.t_v('wn'))::text, 'true');
UPDATE public.promissory_notes SET status = 'cancelled' WHERE partner_user_id = public.pid('notelinked') AND return_rate = 15;
SELECT public.t_check('V2 a cancelled note grants nothing', public.t_rate('notelinked'), '10|new');
UPDATE public.promissory_notes SET status = 'pending' WHERE partner_user_id = public.pid('notelinked') AND return_rate = 15;
SELECT public.t_check('V2 assert still all ok after the review fixes',
  (SELECT COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()), 'all ok');

-- ===========================================================================
SELECT 'SUMMARY ' || count(*) FILTER (WHERE ok) || ' passed, ' || count(*) FILTER (WHERE NOT ok) || ' failed' FROM public._t_results;
