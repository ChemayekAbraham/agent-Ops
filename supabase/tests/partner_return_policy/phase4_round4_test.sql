-- Phase 4 round 4 (T1-T4) functional tests, against the REAL promissory note link security migration (20261106200000,
-- 5e2ad5e930, verbatim via sec_link_security_load.sql), production's link functions, profile triggers and trust impl
-- (verbatim, loaded by run_phase4_tests.sh), and production's promissory_confirm_arrival_match, staff_mfa_ok and
-- system_events INSERT policy (verbatim below, md5-checked).
-- LOCAL THROWAWAY CLUSTER ONLY. Prerequisite: a FRESH Phase 4 load (switch off, no cut-off). Runs as postgres; browser
-- requests are SET ROLE authenticated with the JWT claims set (t_as). One PASS/FAIL line per check + SUMMARY.
--
--   T1  a pre-cut-off note linked while closed (defaulted / cancelled) by an unproven person is HELD, whatever its status:
--       operations sets defaulted + arrival match, then reopens; agent_ops sets cancelled + profile phone, then reopens.
--       Reopening gives no window: the person stays 10|new, the token path still asks for proof, the frozen window is
--       unchanged, and a note closed at the cut-off (no window) gets none when reopened.
--       Controls: partner_ops links a defaulted pre-cut-off note; a post-cut-off note links (no window, no hold).
--   T2  after the cut-off no browser (COO) or service_role session moves a portfolio from one partner to another;
--       before the cut-off the same moves go through (production today); NULL -> X, X -> NULL, X -> X and owner-run
--       moves stay allowed; carry_link_immutable fails when the trigger misses investor_id or the body misses the check.
--   T3  activation_contact_match fails for every weakened system_events policy and for RLS off on system_events.
--   T4  a held event says how it arose (metadata.source: arrival_match / profile_phone / profile_email / other) and that
--       it is not proof of ownership.
\pset tuples_only on
\pset format unaligned
\pset pager off
SET client_min_messages = warning;
\ir phase2_helpers.sql
SELECT public.t_as(NULL) IS NULL AS x \gset

-- ---------------------------------------------------------------------------
-- Production pieces (verbatim, md5-checked against production on 2026-11-07, read-only SELECT)
-- ---------------------------------------------------------------------------
\ir sec_link_security_load.sql
SELECT public.t_check('setup the real security guard is installed and enabled; the browser INSERT policy is gone',
  (SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'trg_guard_note_direct_edit') || '/'
  || (SELECT count(*) FROM pg_policies WHERE tablename = 'promissory_notes' AND policyname = 'Agents can create promissory notes'), 'O/0');

-- production's promissory_confirm_arrival_match (md5(prosrc) efe0a81a07ea86e375e7a196d3cb28e7) + a no-op catch-up stand-in
CREATE OR REPLACE FUNCTION public.promissory_catch_up_partner_commission(p uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.promissory_confirm_arrival_match(p_note_id uuid, p_user_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_note public.promissory_notes;
  v_name text;
  v_catch_up jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'ceo') OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'partner_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: give a written reason of at least 10 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = p_user_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_ACCOUNT: that account no longer exists.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.promissory_notes
     SET partner_user_id = p_user_id
   WHERE id = p_note_id
     AND (
       partner_user_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = promissory_notes.partner_user_id)
     )
  RETURNING * INTO v_note;

  IF v_note.id IS NULL THEN
    RAISE EXCEPTION 'NOTE_ALREADY_LINKED: this note is already linked to an account.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  VALUES ('promissory_arrival_match_confirmed', 'promissory_notes', v_note.id::text, v_uid,
          btrim(p_reason),
          jsonb_build_object('partner_user_id', p_user_id, 'matched_name', v_name,
                             'note_partner_name', v_note.partner_name, 'basis', 'fuzzy_name_confirmed'));

  -- money already recorded before the link: pay the commission now (idempotent)
  v_catch_up := public.promissory_catch_up_partner_commission(p_user_id);

  RETURN jsonb_build_object('note_id', v_note.id, 'partner_user_id', p_user_id,
                            'matched_name', v_name, 'commission_catch_up', v_catch_up);
END;
$function$;
-- production's staff_mfa_ok (md5(prosrc) faf13a32385adbb45377f46a4969ad55) over production's staff_mfa_config shape;
-- production's mode is 'shadow' (= no-op, the ELSE branch).
CREATE TABLE IF NOT EXISTS public.staff_mfa_config (id boolean PRIMARY KEY DEFAULT true, mode text NOT NULL DEFAULT 'shadow',
  updated_at timestamptz DEFAULT now(), updated_by uuid, force_enrol_from timestamptz);
INSERT INTO public.staff_mfa_config (id, mode) VALUES (true, 'shadow') ON CONFLICT (id) DO UPDATE SET mode = 'shadow';
CREATE OR REPLACE FUNCTION public.staff_mfa_ok()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case (select c.mode from public.staff_mfa_config c where c.id)
    when 'all' then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' or not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin','admin'))
    when 'admin' then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' or not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('super_admin','ceo','cto','cfo','coo','access_admin','admin'))
    else true end $function$;
-- production's system_events RLS (pg_policies 2026-11-07): the INSERT policy for signed-in users, staff read.
ALTER TABLE public.system_events ADD COLUMN IF NOT EXISTS actor_id uuid, ADD COLUMN IF NOT EXISTS triggered_by uuid;
ALTER TABLE public.system_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.system_events TO authenticated;
GRANT USAGE ON SEQUENCE public.system_events_id_seq TO authenticated;
DROP POLICY IF EXISTS system_events_insert_authenticated ON public.system_events;
CREATE POLICY system_events_insert_authenticated ON public.system_events FOR INSERT TO authenticated
  WITH CHECK (((user_id IS NULL) OR (user_id = (SELECT auth.uid()))) AND ((actor_id IS NULL) OR (actor_id = (SELECT auth.uid())))
              AND ((triggered_by IS NULL) OR (triggered_by = (SELECT auth.uid()))));
SELECT public.t_check('setup production''s promissory_confirm_arrival_match and staff_mfa_ok are byte for byte production''s (md5 of prosrc)',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.promissory_confirm_arrival_match(uuid,uuid,text)'::regprocedure) || '/'
  || (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.staff_mfa_ok()'::regprocedure),
  'efe0a81a07ea86e375e7a196d3cb28e7/faf13a32385adbb45377f46a4969ad55');
-- A service_role request bypasses RLS in production; the stub's service_role does not, so give it a permissive policy
-- (R1 must reach the row to show that the TRIGGER refuses it).
CREATE POLICY t3_service_role_all ON public.investor_portfolios FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- helpers (same contract as phase4_round3_test.sql)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.t3_user(p text, p_roles text[] DEFAULT '{}', p_profile boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES (public.pid(p), p || '@t3.test') ON CONFLICT DO NOTHING;
  INSERT INTO public.user_roles (user_id, role, enabled) SELECT public.pid(p), r, true FROM unnest(p_roles) r ON CONFLICT DO NOTHING;
  IF p_profile THEN INSERT INTO public.profiles (id, full_name) VALUES (public.pid(p), 'T3 ' || p) ON CONFLICT DO NOTHING; END IF;
  RETURN public.pid(p);
END $$;
CREATE FUNCTION public.t3_tok(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'tok-' || md5('t3:' || k) $$;
CREATE FUNCTION public.t3_note(k text, ph text, ag text, em text DEFAULT NULL, st text DEFAULT 'activated') RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.promissory_notes (agent_id, partner_name, whatsapp_number, email, amount, status, fulfilment_due_on, activation_token)
  VALUES (public.pid(ag), 'T3 ' || k, ph, em, 500000, st, current_date + 10, public.t3_tok(k)) RETURNING id $$;
CREATE FUNCTION public.t3_nid(k text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM public.promissory_notes WHERE activation_token = public.t3_tok(k) $$;
-- who the note is linked to: the test name, 'nobody', or 'other'
CREATE FUNCTION public.t3_owner(k text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(split_part(u.email, '@', 1), CASE WHEN n.partner_user_id IS NULL THEN 'nobody' ELSE 'other' END)
    FROM public.promissory_notes n LEFT JOIN auth.users u ON u.id = n.partner_user_id WHERE n.activation_token = public.t3_tok(k) $$;
CREATE FUNCTION public.t3_agent(k text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT split_part(u.email, '@', 1) FROM public.promissory_notes n JOIN auth.users u ON u.id = n.agent_id
   WHERE n.activation_token = public.t3_tok(k) $$;
CREATE FUNCTION public.t3_held(k text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM public.system_events e WHERE e.event_type = 'promissory_note_link_held' AND e.related_entity_id = public.t3_nid(k) $$;
-- browser JWT with an explicit aal (request.jwt.claims JSON, as PostgREST sets it)
CREATE FUNCTION public.t3_aal(p text, aal text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false),
         set_config('request.jwt.claims', json_build_object('sub', public.pid(p), 'role', 'authenticated', 'aal', aal)::text, false) $$;
-- Runs a statement and KEEPS its effect: 'ok', 'ok(0 rows)' for an UPDATE that reached nothing, or 'SQLSTATE: message'.
CREATE FUNCTION public.t3_do(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  EXECUTE p_sql; GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n = 0 AND p_sql ~* '^\s*update' THEN 'ok(0 rows)' ELSE 'ok' END;
EXCEPTION WHEN others THEN RETURN SQLSTATE || ': ' || SQLERRM;
END $$;
CREATE FUNCTION public.t3_like(p_name text, p_got text, p_like text) RETURNS text LANGUAGE sql AS $$
  SELECT public.t_check(p_name, CASE WHEN p_got LIKE p_like THEN p_like ELSE p_got END, p_like) $$;
GRANT EXECUTE ON FUNCTION public.t3_do(text), public.t3_tok(text), public.t3_nid(text), public.pid(text), public.t_err(text) TO authenticated, anon, service_role;

-- the COO's portfolio edit screen (UPDATE investor_portfolios from the browser), present before and after the cut-off
GRANT SELECT, UPDATE ON public.investor_portfolios TO authenticated;
CREATE POLICY t4_coo_update ON public.investor_portfolios FOR UPDATE TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'coo'))) WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'coo')));
CREATE POLICY t4_coo_read ON public.investor_portfolios FOR SELECT TO authenticated USING ((SELECT public.has_role((SELECT auth.uid()), 'coo')));
-- production: a signed-in user updates their own profile row
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
CREATE POLICY t4_profiles_self_update ON public.profiles FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY t4_profiles_self_read ON public.profiles FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));

SELECT count(*) FROM (SELECT public.t3_user(x, r) FROM (VALUES
  ('a1', ARRAY['agent']), ('ops', ARRAY['operations']), ('agops', ARRAY['agent_ops']), ('pops', ARRAY['partner_ops']),
  ('coo', ARRAY['coo']), ('k1', '{}'::text[]), ('k2', '{}'::text[]), ('k3', '{}'::text[]), ('nb', '{}'::text[]),
  ('qq', '{}'::text[]), ('rd', '{}'::text[]), ('lp', '{}'::text[]), ('m1', '{}'::text[]), ('m2', '{}'::text[]),
  ('m3', '{}'::text[]), ('n2', '{}'::text[])) t(x, r)) s \gset

-- Notes written BEFORE the cut-off.
SELECT count(*) FROM (SELECT public.t3_note(k, ph, ag, em, st) FROM (VALUES
  ('st1',    '0771400001', 'a1', NULL, 'activated'),         -- T1 defaulted + arrival match (operations), reopened
  ('st2',    '0771400002', 'a1', NULL, 'pending'),           -- T1 cancelled + profile phone, reopened
  ('st3',    '0771400003', 'a1', NULL, 'activated'),         -- T4 'other'; T1 partner_ops control
  ('em1',    '0771400004', 'a1', 'victim@t3.test', 'pending'), -- T4 profile_email
  ('lapsed', '0771400005', 'a1', NULL, 'cancelled')) v(k, ph, ag, em, st)) s \gset
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin, status, roi_percentage)
VALUES (public.pid('k3'), public.pid('a1'), 'T4-K3-A', 2000000, 12, '1111', 'active', 20),
       (public.pid('m1'), public.pid('a1'), 'T4-M1-A', 1000000, 12, '1111', 'active', 20),
       (public.pid('m3'), public.pid('a1'), 'T4-M3-A', 1000000, 12, '1111', 'active', 20);

-- ===========================================================================
-- T2 before the cut-off: production behaviour (a COO or service_role moves a portfolio to another partner)
-- ===========================================================================
SELECT public.t_as('coo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('T2 pre: before the cut-off a COO browser moves a portfolio to another partner (production today)',
  public.t3_do(format('UPDATE public.investor_portfolios SET investor_id = %L WHERE portfolio_code = %L', public.pid('m2'), 'T4-M1-A')), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SET ROLE service_role;
SELECT public.t_check('T2 pre: before the cut-off service_role moves it back',
  public.t3_do(format('UPDATE public.investor_portfolios SET investor_id = %L WHERE portfolio_code = %L', public.pid('m1'), 'T4-M1-A')), 'ok');
RESET ROLE;
SELECT public.t_check('T2 pre: the portfolio is back with m1',
  (SELECT (investor_id = public.pid('m1'))::text FROM public.investor_portfolios WHERE portfolio_code = 'T4-M1-A'), 'true');

-- ===========================================================================
-- Switch on (one owner UPDATE; every release check passes, including the strengthened T2 / T3 checks)
-- ===========================================================================
SELECT public.t_check('ON every release check passes (activation_contact_match needs system_events RLS on, as in production)',
  (SELECT COALESCE(string_agg(check_name, ','), 'none') FROM public._partner_return_phase4_checks(true) WHERE NOT ok), 'none');
UPDATE public.partner_return_policy SET release_ready = true, enabled = true;
SELECT public.t_check('ON switched on, cut-off set', (SELECT enabled || '/' || (cutoff_at IS NOT NULL) FROM public.partner_return_policy), 'true/true');
SELECT public.t_check('ON windows: the four open notes have one, the cancelled one none',
  (SELECT count(*) FILTER (WHERE note_id IN (public.t3_nid('st1'), public.t3_nid('st2'), public.t3_nid('st3'), public.t3_nid('em1')))
          || '/' || count(*) FILTER (WHERE note_id = public.t3_nid('lapsed'))
     FROM public.partner_return_note_windows), '4/0');
CREATE TABLE public._t4_win AS SELECT * FROM public.partner_return_note_windows;

-- ===========================================================================
-- T1: a note linked while closed is held; reopening gives no window
-- ===========================================================================
-- S1: operations sets st1 defaulted, confirms an arrival match to unproven k1, sets it back to activated
SELECT public.t_as('ops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('T1 S1 operations sets the pre-cut-off note defaulted',
  public.t3_do($q$UPDATE public.promissory_notes SET status = 'defaulted' WHERE activation_token = public.t3_tok('st1')$q$), 'ok');
RESET ROLE;
SELECT public.t_check('T1 S1 operations arrival match of the DEFAULTED note to unproven k1 returns (production contract)',
  COALESCE(public.promissory_confirm_arrival_match(public.t3_nid('st1'), public.pid('k1'), 'round four status round trip') ->> 'partner_user_id', 'null'),
  public.pid('k1')::text);
SET ROLE authenticated;
SELECT public.t_check('T1 S1 operations reopens the note (activated)',
  public.t3_do($q$UPDATE public.promissory_notes SET status = 'activated' WHERE activation_token = public.t3_tok('st1')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('T1 S1 the link was HELD: owner nobody, one held event, k1 stays 10|new',
  public.t3_owner('st1') || '|' || public.t3_held('st1') || '|' || public.t_rate('k1'), 'nobody|1|10|new');
SELECT public.t_as('k1') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_like('T1 S1 after the reopen k1''s token activation still asks for proof (NOTE_CONTACT_MISMATCH)',
  public.t3_do(format('SELECT public.activate_promissory_note(%L)', public.t3_tok('st1'))), '42501: NOTE_CONTACT_MISMATCH%');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('T1 S1 k1 is still 10|new and the note unlinked', public.t3_owner('st1') || '|' || public.t_rate('k1'), 'nobody|10|new');

-- S2: agent_ops sets st2 cancelled; k2 saves the note's phone on their profile (no proof); agent_ops reopens it
SELECT public.t_as('agops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('T1 S2 agent_ops sets the pre-cut-off note cancelled',
  public.t3_do($q$UPDATE public.promissory_notes SET status = 'cancelled' WHERE activation_token = public.t3_tok('st2')$q$), 'ok');
RESET ROLE;
SELECT public.t_as('k2') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('T1 S2 k2''s profile save with the CANCELLED note''s phone succeeds',
  public.t3_do($q$UPDATE public.profiles SET phone = '0771400002' WHERE id = public.pid('k2')$q$), 'ok');
RESET ROLE;
SELECT public.t_check('T1 S2 the link was HELD while cancelled: owner nobody, one held event',
  public.t3_owner('st2') || '|' || public.t3_held('st2'), 'nobody|1');
SELECT public.t_as('agops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('T1 S2 agent_ops reopens the note (pending)',
  public.t3_do($q$UPDATE public.promissory_notes SET status = 'pending' WHERE activation_token = public.t3_tok('st2')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('T1 S2 after the reopen: owner nobody, still one event, k2 stays 10|new',
  public.t3_owner('st2') || '|' || public.t3_held('st2') || '|' || public.t_rate('k2'), 'nobody|1|10|new');
-- a second owner-run profile save (same phone) re-runs the link functions on the reopened note: held again
UPDATE public.profiles SET phone = '0771400002', full_name = full_name WHERE id = public.pid('k2');
SELECT public.t_check('T1 S2 a later owner-run profile save on the reopened note is held again (nobody, k2 10|new)',
  public.t3_owner('st2') || '|' || public.t_rate('k2'), 'nobody|10|new');

SELECT public.t_check('T1 the frozen windows (every note of the load) are unchanged by the status round trips and held links',
  (SELECT count(*)::text FROM public.partner_return_note_windows w JOIN public._t4_win o USING (note_id)
    WHERE w.ends_on = o.ends_on AND w.return_rate = o.return_rate AND w.partner_user_id IS NOT DISTINCT FROM o.partner_user_id
      AND w.agent_id IS NOT DISTINCT FROM o.agent_id AND w.contact_phones IS NOT DISTINCT FROM o.contact_phones)
  || '/' || (SELECT count(*) FROM public.partner_return_note_windows), (SELECT count(*) || '/' || count(*) FROM public._t4_win));

-- A note closed at the cut-off has no window; reopened after it, an unproven profile link goes through and gives no window.
SELECT public.t_as('ops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('T1 reopen: operations reopens the note that was cancelled at the cut-off',
  public.t3_do($q$UPDATE public.promissory_notes SET status = 'activated' WHERE activation_token = public.t3_tok('lapsed')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
UPDATE public.profiles SET phone = '0771400005' WHERE id = public.pid('lp');
SELECT public.t_check('T1 reopen: the reopened note links to lp (no window, no hold); lp stays 10|new; still no window',
  public.t3_owner('lapsed') || '|' || public.t3_held('lapsed') || '|' || public.t_rate('lp') || '|'
  || (SELECT count(*) FROM public.partner_return_note_windows WHERE note_id = public.t3_nid('lapsed')), 'lp|0|10|new|0');

-- ===========================================================================
-- T4: how a held event arose, and that it is not proof of ownership
-- ===========================================================================
SELECT public.t_as('qq') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('T4 qq saves a profile email equal to a stranger''s note email (succeeds)',
  public.t3_do($q$UPDATE public.profiles SET email = 'victim@t3.test' WHERE id = public.pid('qq')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('T4 the email link was held: owner nobody, one event for qq',
  public.t3_owner('em1') || '|' || (SELECT count(*) FROM public.system_events WHERE event_type = 'promissory_note_link_held' AND user_id = public.pid('qq')), 'nobody|1');
SELECT public.t_check('T4 source arrival_match (the operations arrival match)',
  (SELECT string_agg(metadata ->> 'source', ',') FROM public.system_events WHERE event_type = 'promissory_note_link_held' AND related_entity_id = public.t3_nid('st1')), 'arrival_match');
SELECT public.t_check('T4 source profile_phone (both profile saves on st2, one event per transaction)',
  (SELECT string_agg(DISTINCT metadata ->> 'source', ',') FROM public.system_events WHERE event_type = 'promissory_note_link_held' AND related_entity_id = public.t3_nid('st2')), 'profile_phone');
SELECT public.t_check('T4 source profile_email', (SELECT string_agg(metadata ->> 'source', ',') FROM public.system_events
  WHERE event_type = 'promissory_note_link_held' AND related_entity_id = public.t3_nid('em1')), 'profile_email');
-- 'other': an owner UPDATE outside the link functions (no JWT) on a pre-cut-off note
UPDATE public.promissory_notes SET partner_user_id = public.pid('k3') WHERE id = public.t3_nid('st3');
SELECT public.t_check('T4 source other (a direct owner update is held too)',
  public.t3_owner('st3') || '|' || (SELECT string_agg(metadata ->> 'source', ',') FROM public.system_events
    WHERE event_type = 'promissory_note_link_held' AND related_entity_id = public.t3_nid('st3')), 'nobody|other');
SELECT public.t_check('T4 every held event: not_proof_of_ownership = true, held_user_id = user_id, description says not a claim of ownership and links only after proof',
  (SELECT count(*) FILTER (WHERE (metadata ->> 'not_proof_of_ownership')::boolean IS TRUE
                             AND metadata ->> 'held_user_id' = user_id::text
                             AND description LIKE '%not a claim of ownership%' AND description LIKE '%only after proof%')
          || '/' || count(*) FROM public.system_events WHERE event_type = 'promissory_note_link_held'),
  (SELECT count(*) || '/' || count(*) FROM public.system_events WHERE event_type = 'promissory_note_link_held'));
SELECT public.t_check('T4 the held events (st1, st2, em1, st3) are all there', (SELECT count(DISTINCT related_entity_id)::text
  FROM public.system_events WHERE event_type = 'promissory_note_link_held'), '4');
SELECT public.t_as('qq') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_like('T4 forged held event from a browser refused',
  public.t3_do(format($q$INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, description, metadata)
                         VALUES ('promissory_note_link_held', %L, 'promissory_notes', %L, 'x', '{"source":"arrival_match","not_proof_of_ownership":true}')$q$,
                      public.pid('qq'), public.t3_nid('em1'))), '42501:%');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset

-- T1 controls
UPDATE public.promissory_notes SET status = 'defaulted' WHERE id = public.t3_nid('st3');
SELECT public.t_as('pops') IS NULL AS x \gset
SELECT public.t_check('T1 ctrl partner_ops confirms an arrival match of a DEFAULTED pre-cut-off note for k3',
  COALESCE(public.promissory_confirm_arrival_match(public.t3_nid('st3'), public.pid('k3'), 'partner ops proof checked by phone') ->> 'partner_user_id', 'null'),
  public.pid('k3')::text);
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('T1 ctrl the partner_ops link went through (owner k3, no new event)',
  public.t3_owner('st3') || '|' || public.t3_held('st3'), 'k3|1');
SELECT public.t3_note('post', '0771400019', 'a1', NULL, 'defaulted') IS NULL AS x \gset
UPDATE public.profiles SET phone = '0771400019' WHERE id = public.pid('rd');
SELECT public.t_check('T1 ctrl a defaulted note written after the cut-off links by profile phone (no window, no hold)',
  public.t3_owner('post') || '|' || public.t3_held('post'), 'rd|0');

-- ===========================================================================
-- T2 after the cut-off
-- ===========================================================================
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin, status)
VALUES (NULL, public.pid('a1'), 'T4-NULL', 1000000, 12, '1111', 'pending_approval');
SELECT public.t_as('coo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_like('T2 a COO browser move of a pre-cut-off 20% portfolio k3 -> nb is refused (42501)',
  public.t3_do(format('UPDATE public.investor_portfolios SET investor_id = %L WHERE portfolio_code = %L', public.pid('nb'), 'T4-K3-A')),
  '42501: A portfolio cannot be moved to another partner%');
SELECT public.t_check('T2 ctrl COO sets an investor on a portfolio that has none (NULL -> nb)',
  public.t3_do(format('UPDATE public.investor_portfolios SET investor_id = %L WHERE portfolio_code = %L', public.pid('nb'), 'T4-NULL')), 'ok');
SELECT public.t3_like('T2 (final) COO clears the partner without cancelling (nb -> NULL) is refused: first step of the two-step move',
  public.t3_do($q$UPDATE public.investor_portfolios SET investor_id = NULL WHERE portfolio_code = 'T4-NULL'$q$),
  '42501: After the Partner Returns cut-off a portfolio can lose its partner only by being cancelled%');
SELECT public.t_check('T2 (final) ctrl COO cancels and clears the partner in one update (as delete-user does)',
  public.t3_do($q$UPDATE public.investor_portfolios SET investor_id = NULL, status = 'cancelled' WHERE portfolio_code = 'T4-NULL'$q$), 'ok');
SELECT public.t3_like('T2 (final) the cancelled portfolio with no partner cannot be reopened',
  public.t3_do($q$UPDATE public.investor_portfolios SET status = 'pending_approval' WHERE portfolio_code = 'T4-NULL'$q$),
  '42501: After the Partner Returns cut-off a closed portfolio with no partner cannot be reopened%');
SELECT public.t3_like('T2 (final) nor handed to a partner',
  public.t3_do(format('UPDATE public.investor_portfolios SET investor_id = %L WHERE portfolio_code = %L', public.pid('nb'), 'T4-NULL')),
  '42501: A portfolio cannot be given to a partner after the Partner Returns cut-off%');
SELECT public.t_check('T2 ctrl COO UPDATE OF investor_id to the same investor passes',
  public.t3_do(format('UPDATE public.investor_portfolios SET investor_id = %L WHERE portfolio_code = %L', public.pid('k3'), 'T4-K3-A')), 'ok');
SELECT public.t_check('T2 ctrl COO changes another column of the portfolio (no move)',
  public.t3_do($q$UPDATE public.investor_portfolios SET duration_months = 12 WHERE portfolio_code = 'T4-K3-A'$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SET ROLE service_role;
SELECT public.t3_like('T2 a service_role (edge function) move k3 -> nb is refused (42501)',
  public.t3_do(format('UPDATE public.investor_portfolios SET investor_id = %L WHERE portfolio_code = %L', public.pid('nb'), 'T4-K3-A')),
  '42501: A portfolio cannot be moved to another partner%');
RESET ROLE;
SET ROLE anon;
SELECT public.t_check('T2 anon reaches no portfolio (no grant / no policy): nothing moves',
  (public.t3_do(format('UPDATE public.investor_portfolios SET investor_id = %L WHERE portfolio_code = %L', public.pid('nb'), 'T4-K3-A')) NOT LIKE 'ok')::text, 'true');
RESET ROLE;
SELECT public.t_check('T2 k3 still holds the portfolio; nb holds nothing at 20%',
  (SELECT (investor_id = public.pid('k3'))::text FROM public.investor_portfolios WHERE portfolio_code = 'T4-K3-A')
  || '/' || (SELECT count(*) FROM public.investor_portfolios WHERE investor_id = public.pid('nb') AND roi_percentage = 20), 'true/0');
BEGIN;
UPDATE public.investor_portfolios SET investor_id = public.pid('nb') WHERE portfolio_code = 'T4-K3-A';
SELECT (investor_id = public.pid('nb'))::text AS t4_owner_mv FROM public.investor_portfolios WHERE portfolio_code = 'T4-K3-A' \gset
ROLLBACK;
SELECT public.t_check('T2 ctrl an owner-run move (the split / transfer tools run as the owner) is allowed (rolled back)', :'t4_owner_mv', 'true');
-- A two-step move through NULL (X -> NULL, then NULL -> Y): each step is allowed on its own. Y must not end up holding
-- the old partner's 20% as an existing partner.
SELECT public.t_as('coo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_do($q$UPDATE public.investor_portfolios SET investor_id = NULL WHERE portfolio_code = 'T4-M3-A'$q$) AS t2_null_1 \gset
SELECT public.t3_do(format('UPDATE public.investor_portfolios SET investor_id = %L WHERE portfolio_code = %L', public.pid('n2'), 'T4-M3-A')) AS t2_null_2 \gset
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT 'INFO  T2 two-step move through NULL by a COO browser: step1 ' || :'t2_null_1' || ', step2 ' || :'t2_null_2'
  || '; n2 holds ' || COALESCE((SELECT string_agg(trim_scale(roi_percentage)::text || '%/' || COALESCE(rate_basis, 'unstamped'), ',')
                                  FROM public.investor_portfolios WHERE investor_id = public.pid('n2')), 'nothing')
  || '; n2 rate ' || public.t_rate('n2');
SELECT public.t_check('T2 a two-step move through NULL does not hand a new partner a pre-cut-off rate (n2 is 10|new, holds no 20%)',
  public.t_rate('n2') || '/' || (SELECT count(*) FROM public.investor_portfolios WHERE investor_id = public.pid('n2') AND roi_percentage = 20),
  '10|new/0');

-- ===========================================================================
-- T2 / T3 release checks: positive, then each weakening fails (each inside a rolled-back transaction)
-- ===========================================================================
SELECT public.t_check('T3 activation_contact_match ok; T2 carry_link_immutable ok',
  (SELECT string_agg(ok::text, '/' ORDER BY check_name) FROM public._partner_return_phase4_checks(true)
    WHERE check_name IN ('activation_contact_match', 'carry_link_immutable')), 'true/true');
CREATE FUNCTION pg_temp.acm() RETURNS text LANGUAGE sql AS
  $$ SELECT ok::text FROM public._partner_return_phase4_checks(true) WHERE check_name = 'activation_contact_match' $$;
CREATE FUNCTION pg_temp.cli() RETURNS text LANGUAGE sql AS
  $$ SELECT ok::text FROM public._partner_return_phase4_checks(true) WHERE check_name = 'carry_link_immutable' $$;
BEGIN;
ALTER POLICY system_events_no_browser_link_held ON public.system_events TO anon;
SELECT pg_temp.acm() AS t4_v1 \gset
ROLLBACK;
SELECT public.t_check('T3 policy for anon only (authenticated dropped) fails', :'t4_v1', 'false');
BEGIN;
ALTER POLICY system_events_no_browser_link_held ON public.system_events TO authenticated;
SELECT pg_temp.acm() AS t4_v2 \gset
ROLLBACK;
SELECT public.t_check('T3 policy for authenticated only (anon dropped) fails', :'t4_v2', 'false');
BEGIN;
ALTER POLICY system_events_no_browser_link_held ON public.system_events TO public;
SELECT pg_temp.acm() AS t4_v3 \gset
ROLLBACK;
SELECT public.t_check('T3 policy TO public fails (roles must name authenticated and anon)', :'t4_v3', 'false');
BEGIN;
ALTER POLICY system_events_no_browser_link_held ON public.system_events WITH CHECK (true);
SELECT pg_temp.acm() AS t4_v4 \gset
ROLLBACK;
SELECT public.t_check('T3 policy WITH CHECK (true) fails', :'t4_v4', 'false');
BEGIN;
ALTER POLICY system_events_no_browser_link_held ON public.system_events WITH CHECK (event_type IS DISTINCT FROM 'promissory_note_activated');
SELECT pg_temp.acm() AS t4_v5 \gset
ROLLBACK;
SELECT public.t_check('T3 policy WITH CHECK on another event type fails', :'t4_v5', 'false');
BEGIN;
DROP POLICY system_events_no_browser_link_held ON public.system_events;
CREATE POLICY system_events_no_browser_link_held ON public.system_events AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (true) WITH CHECK (event_type IS DISTINCT FROM 'promissory_note_link_held');
SELECT pg_temp.acm() AS t4_v6 \gset
ROLLBACK;
SELECT public.t_check('T3 policy cmd ALL (not INSERT) fails', :'t4_v6', 'false');
BEGIN;
DROP POLICY system_events_no_browser_link_held ON public.system_events;
CREATE POLICY system_events_no_browser_link_held ON public.system_events AS PERMISSIVE FOR INSERT TO authenticated, anon
  WITH CHECK (event_type IS DISTINCT FROM 'promissory_note_link_held');
SELECT pg_temp.acm() AS t4_v7 \gset
ROLLBACK;
SELECT public.t_check('T3 policy PERMISSIVE (ORed with the other INSERT policies) fails', :'t4_v7', 'false');
BEGIN;
DROP POLICY system_events_no_browser_link_held ON public.system_events;
SELECT pg_temp.acm() AS t4_v8 \gset
ROLLBACK;
SELECT public.t_check('T3 policy dropped fails', :'t4_v8', 'false');
BEGIN;
ALTER TABLE public.system_events DISABLE ROW LEVEL SECURITY;
SELECT pg_temp.acm() AS t4_v9 \gset
ROLLBACK;
SELECT public.t_check('T3 RLS off on system_events fails', :'t4_v9', 'false');
BEGIN;
ALTER POLICY system_events_no_browser_link_held ON public.system_events
  WITH CHECK (event_type IS DISTINCT FROM 'promissory_note_link_held' OR true);
SELECT 'INFO  T3 a WITH CHECK that names the event but is always true (... OR true): activation_contact_match = ' || pg_temp.acm()
       || ' (the check matches the policy text; it cannot prove the expression)';
ROLLBACK;
SELECT public.t_check('T3 after the rolled-back weakenings the check is ok again', pg_temp.acm(), 'true');
BEGIN;
CREATE OR REPLACE TRIGGER trg_partner_return_carry_guard
  BEFORE INSERT OR UPDATE OF locked_from_portfolio_id ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.guard_partner_return_carry();
SELECT pg_temp.cli() AS t4_v10 \gset
ROLLBACK;
SELECT public.t_check('T2 carry trigger without investor_id fails carry_link_immutable', :'t4_v10', 'false');
BEGIN;
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_carry_guard;
SELECT pg_temp.cli() AS t4_v11 \gset
ROLLBACK;
SELECT public.t_check('T2 carry trigger disabled fails carry_link_immutable', :'t4_v11', 'false');
BEGIN;
DO $x$ BEGIN EXECUTE replace(pg_get_functiondef('public.guard_partner_return_carry()'::regprocedure),
  'OLD.investor_id', 'NEW.investor_id'); END $x$;
SELECT pg_temp.cli() AS t4_v12 \gset
ROLLBACK;
SELECT public.t_check('T2 carry guard body without the OLD.investor_id move check fails carry_link_immutable', :'t4_v12', 'false');
SELECT public.t_check('T2 assert_partner_return_policy_intact: carry_link_immutable and activation_contact_match ok',
  (SELECT string_agg(ok::text, '/' ORDER BY check_name) FROM public.assert_partner_return_policy_intact()
    WHERE check_name IN ('activation_contact_match', 'carry_link_immutable')), 'true/true');

SELECT 'SUMMARY ' || count(*) FILTER (WHERE ok) || '/' || count(*) || ' passed'
       || COALESCE(' -- FAILED: ' || string_agg(name, '; ' ORDER BY n) FILTER (WHERE NOT ok), '')
  FROM public._t_results;
