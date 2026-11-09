-- Phase 4 round 3 (Q1-Q8) functional tests: the reviewers' attacks with positive controls, against the REAL promissory
-- note link security migration (20261106200000, 5e2ad5e930, verbatim via sec_link_security_load.sql), production's link
-- functions, profile triggers and trust impl (verbatim, loaded by run_phase4_tests.sh), and production's
-- promissory_confirm_arrival_match, staff_mfa_ok and system_events INSERT policy (verbatim below, md5-checked).
-- LOCAL THROWAWAY CLUSTER ONLY. Prerequisite: a FRESH Phase 4 load (switch off, no cut-off). Runs as postgres; browser
-- requests are SET ROLE authenticated with the JWT claims set (t_as / t3_aal). One PASS/FAIL line per check + SUMMARY.
--
--   R0       before the cut-off everything behaves as production does today (agent moves, self links, unproven
--            profile links, operations arrival match; no events, no windows)
--   FROZEN   the switch-on snapshot fills contact_phones / contact_email for every window (Q2)
--   PRIV-A1  an edited contact after the cut-off (operations browser edit) proves nothing: token and profile paths (Q2)
--   PRIV-A2  the agent_id round trip (move to X, X self-links, move back) is refused for operations / agent_ops (Q3)
--   PRIV-C   a forged 'promissory_note_link_held' event from a browser is refused (Q5); other self events still go in
--   R1       locked_from_portfolio_id re-parent refused for a browser COO and for service_role (Q1)
--   R3       a move away from a profile-less account (arrival match by operations) is held (Q4)
--   R6       the book-transfer laundering (agent_ops moves the note to X, X's profile links it, move back) is refused
--   +ctrl    partner staff transfer allowed; OTP-proven link allowed; a real hold still records its event
--   Q6       Google / Apple proof needs email_verified not 'false'
--   Q7       staff MFA on the partner-staff checks: mode 'all' with aal1 / aal2, and mode 'off'
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
-- helpers
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

SELECT count(*) FROM (SELECT public.t3_user(x, r) FROM (VALUES
  ('a1', ARRAY['agent']), ('a2', ARRAY['agent']), ('ops', ARRAY['operations']), ('agops', ARRAY['agent_ops']),
  ('pops', ARRAY['partner_ops']), ('coo', ARRAY['coo']), ('x', ARRAY['agent']), ('rx', ARRAY['agent']),
  ('y', '{}'::text[]), ('z', '{}'::text[]), ('w', '{}'::text[]), ('s', '{}'::text[]), ('v', '{}'::text[]), ('p', '{}'::text[]),
  ('rd', '{}'::text[]), ('ry', '{}'::text[]), ('rz', '{}'::text[]), ('rp', '{}'::text[])) t(x, r)) s \gset
-- These people have no profile yet (signup inserts it later): g, e, h, q
SELECT count(*) FROM (SELECT public.t3_user(x, '{}', false) FROM unnest(ARRAY['g', 'e', 'h', 'q']) x) s \gset
-- g and f proved THEIR OWN numbers by OTP login (never a note's number)
INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome, stage) VALUES
  ('0772666001', public.pid('g'), 'success', 'magic_link_issued'), ('0772666002', public.pid('w'), 'success', 'magic_link_issued');

-- Notes written BEFORE the cut-off (they get frozen windows).
SELECT count(*) FROM (SELECT public.t3_note(k, ph, ag, em, st) FROM (VALUES
  ('pre_mv',  '0771300090', 'a1', NULL, 'pending'),     -- R0 agent move parity
  ('pre_v',   '0771300091', 'a1', NULL, 'activated'),   -- R0 unproven profile link parity
  ('pre_arr', '0771300092', 'a1', NULL, 'activated'),   -- R0 operations arrival match parity
  ('edit',    '0771300003', 'a1', NULL, 'activated'),   -- PRIV-A1 profile path
  ('edit2',   '0771300013', 'a1', NULL, 'activated'),   -- PRIV-A1 token path
  ('g4',      '0771300004', 'a1', 'n4@t3.test', 'activated'),  -- Q6
  ('rt',      '0771300001', 'a1', NULL, 'activated'),   -- PRIV-A2 round trip (operations)
  ('rt2',     '0771300011', 'a1', NULL, 'pending'),     -- PRIV-A2 round trip (agent_ops)
  ('same',    '0771300002', 'a1', NULL, 'activated'),   -- Q3b same-statement agent + link
  ('mfa',     '0771300005', 'a1', NULL, 'activated'),   -- Q7
  ('mv',      '0771555002', 'a1', NULL, 'activated'),   -- R3
  ('r6',      '0771555004', 'a1', NULL, 'activated'),   -- R6 (agent_ops)
  ('r6p',     '0771555014', 'a1', NULL, 'activated'),   -- R6 control (partner_ops)
  ('otp',     '0771009004', 'a1', NULL, 'pending'),     -- +ctrl OTP-proven link
  ('hold',    '0771009002', 'a1', NULL, 'pending'),     -- +ctrl real hold from a browser-initiated profile save
  ('two',     '0771300020', 'a1', 'two@t3.test', 'activated')) v(k, ph, ag, em, st)) s \gset
UPDATE public.promissory_notes SET phone_number = '+256 772 300 021' WHERE id = public.t3_nid('two');
SELECT public.t3_note('dead', '0771300030', 'a1', '', 'activated') IS NOT NULL AS x \gset
SELECT public.t3_note('gone', '0771300040', 'a1', NULL, 'fulfilled') IS NOT NULL AS x \gset
SELECT public.t3_note('lapsed', '0771300050', 'a1', NULL, 'cancelled') IS NOT NULL AS x \gset

-- ===========================================================================
-- R0. Before the cut-off: production behaviour (switch off, no cut-off)
-- ===========================================================================
SELECT public.t_as('agops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('R0 agent_ops (browser) moves an unlinked note to agent x (real security guard lets admin roles edit agent_id)',
  public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('x') WHERE activation_token = public.t3_tok('pre_mv')$q$), 'ok');
RESET ROLE;
SELECT public.t_as('x') IS NULL AS x \gset
SELECT public.t_check('R0 x activates the note as its own agent (no D3 before the cut-off)',
  public.activate_promissory_note(public.t3_tok('pre_mv')) ->> 'success', 'true');
SELECT public.t_as('agops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('R0 agent_ops moves the now-linked note back (nothing opens a window before the cut-off)',
  public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('a1') WHERE activation_token = public.t3_tok('pre_mv')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
UPDATE public.profiles SET phone = '0771300091' WHERE id = public.pid('v');
SELECT public.t_as('ops') IS NULL AS x \gset
SELECT public.t_check('R0 operations arrival match (production RPC) of an unproven person links',
  public.promissory_confirm_arrival_match(public.t3_nid('pre_arr'), public.pid('rd'), 'R0 parity before the cut-off') ->> 'partner_user_id', public.pid('rd')::text);
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('R0 unproven profile phone links (production); no held events; no windows; x/v/rd at production rates',
  public.t3_owner('pre_v') || '/' || (SELECT count(*) FROM public.system_events WHERE event_type = 'promissory_note_link_held') || '/'
  || (SELECT count(*) FROM public.partner_return_note_windows) || '/' || public.t3_owner('pre_mv') || '/' || public.t3_owner('pre_arr'),
  'v/0/0/x/rd');
SELECT public.t_as('w') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('R0 a browser self event (other type) is allowed by production''s policy',
  public.t3_do($q$INSERT INTO public.system_events (event_type, user_id) VALUES ('ui_ping', public.pid('w'))$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('R0 assert all ok before the cut-off (26 checks, carry_link_immutable and activation_contact_match ok)',
  (SELECT count(*) || '/' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact())
  || '/' || (SELECT string_agg(ok::text, ',' ORDER BY check_name) FROM public.assert_partner_return_policy_intact()
              WHERE check_name IN ('carry_link_immutable', 'activation_contact_match')), '26/all ok/true,true');

-- R1 setup: rp holds an 18% portfolio from before the cut-off.
SELECT public.t_as(NULL) IS NULL AS x \gset
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin, status, roi_percentage)
VALUES (public.pid('rp'), public.pid('a1'), 'T3-RP-A', 1000000, 12, '1111', 'active', 18);
SELECT id AS rp_a FROM public.investor_portfolios WHERE portfolio_code = 'T3-RP-A' \gset

-- ===========================================================================
-- Switch on (one owner UPDATE, release checks pass with the real security migration)
-- ===========================================================================
SELECT public.t_check('ON every release check passes with the real security migration',
  (SELECT COALESCE(string_agg(check_name, ','), 'none') FROM public._partner_return_phase4_checks(true) WHERE NOT ok), 'none');
UPDATE public.partner_return_policy SET release_ready = true, enabled = true;
SELECT public.t_check('ON switched on, cut-off set', (SELECT enabled || '/' || (cutoff_at IS NOT NULL) FROM public.partner_return_policy), 'true/true');

-- ===========================================================================
-- FROZEN. Q2: the switch-on snapshot fills the contacts (last 9 digits of WhatsApp and phone; email lower-cased, '' -> NULL)
-- ===========================================================================
SELECT public.t_check('FROZEN every open note (pending/activated/fulfilled) has a window; a cancelled one has none',
  (SELECT count(*) FILTER (WHERE w.note_id IS NOT NULL) || '/' || count(*) FILTER (WHERE w.note_id IS NULL)
     FROM public.promissory_notes n LEFT JOIN public.partner_return_note_windows w ON w.note_id = n.id
    WHERE n.partner_name LIKE 'T3 %' AND n.status IN ('pending', 'activated', 'fulfilled')) || '/'
  || (SELECT count(*) FROM public.partner_return_note_windows WHERE note_id = public.t3_nid('lapsed')), '18/0/0');
SELECT public.t_check('FROZEN every window''s contact_phones equals the note''s normalised WhatsApp + phone, contact_email its lower-cased email (all windows)',
  (SELECT count(*) FILTER (WHERE w.contact_phones IS DISTINCT FROM array_remove(ARRAY[public.normalize_phone_last9(n.whatsapp_number), public.normalize_phone_last9(n.phone_number)], NULL)
                             OR w.contact_email IS DISTINCT FROM lower(NULLIF(btrim(n.email), '')))::text
     FROM public.partner_return_note_windows w JOIN public.promissory_notes n ON n.id = w.note_id), '0');
SELECT public.t_check('FROZEN examples: g4 (phone + email), two (WhatsApp + phone, email), dead (email '''' -> NULL)',
  (SELECT string_agg(k || '=' || array_to_string(w.contact_phones, ',') || '|' || COALESCE(w.contact_email, '-'), ' ' ORDER BY k)
     FROM unnest(ARRAY['dead', 'g4', 'two']) k JOIN public.partner_return_note_windows w ON w.note_id = public.t3_nid(k)),
  'dead=771300030|- g4=771300004|n4@t3.test two=771300020,772300021|two@t3.test');
SELECT public.t_check('FROZEN browsers hold no write grant on the frozen windows (authenticated / anon UPDATE, INSERT)',
  (has_table_privilege('authenticated', 'public.partner_return_note_windows', 'UPDATE') OR has_table_privilege('authenticated', 'public.partner_return_note_windows', 'INSERT')
   OR has_table_privilege('anon', 'public.partner_return_note_windows', 'UPDATE') OR has_table_privilege('anon', 'public.partner_return_note_windows', 'INSERT'))::text, 'false');

-- ===========================================================================
-- PRIV-A1. Q2: an edited contact after the cut-off proves nothing
-- ===========================================================================
SELECT public.t_as('ops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('PRIV-A1 operations (browser) rewrites two pre-cut-off notes'' WhatsApp to g''s / w''s own OTP-proven numbers (the security guard allows admin roles)',
  public.t3_do($q$UPDATE public.promissory_notes SET whatsapp_number = '0772666001' WHERE activation_token = public.t3_tok('edit')$q$) || '/'
  || public.t3_do($q$UPDATE public.promissory_notes SET whatsapp_number = '0772666002' WHERE activation_token = public.t3_tok('edit2')$q$), 'ok/ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
INSERT INTO public.profiles (id, full_name, phone) VALUES (public.pid('g'), 'T3 g', '0772666001');
SELECT public.t_check('PRIV-A1 profile path: g''s signup profile carries the edited number -> held (one event), rate 10|new',
  public.t3_owner('edit') || '/' || public.t3_held('edit') || '/' || public.t_rate('g'), 'nobody/1/10|new');
SELECT public.t_as('w') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_like('PRIV-A1 token path: w activates the edited note by its token -> NOTE_CONTACT_MISMATCH',
  public.t3_do($q$SELECT public.activate_promissory_note(public.t3_tok('edit2'))$q$), '42501: NOTE_CONTACT_MISMATCH%');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('PRIV-A1 after both attempts: neither note linked, w and g at 10|new',
  public.t3_owner('edit') || '/' || public.t3_owner('edit2') || '/' || public.t_rate('w') || '/' || public.t_rate('g'), 'nobody/nobody/10|new/10|new');
-- control: proving the FROZEN number (not the edited one) still links
INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome, stage) VALUES ('256771300013', public.pid('w'), 'success', 'magic_link_issued');
SELECT public.t_as('w') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('PRIV-A1 control: w proves the note''s FROZEN number by OTP, then activates the edited note -> linked',
  public.t3_do($q$SELECT public.activate_promissory_note(public.t3_tok('edit2'))$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('PRIV-A1 control: w linked at the note rate', public.t3_owner('edit2') || '/' || public.t_rate('w'), 'w/15|promissory_note');

-- ===========================================================================
-- Q6. Google / Apple proof needs identity_data.email_verified not 'false'
-- ===========================================================================
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
VALUES ('g-t3e', public.pid('e'), '{"email":"N4@t3.test","email_verified":false}', 'google'),
       ('a-t3e', public.pid('e'), '{"email":"n4@t3.test","email_verified":"false"}', 'apple');
SELECT public.t_as('e') IS NULL AS x \gset
SELECT public.t3_like('Q6 Google and Apple identities with the note''s email but email_verified false (boolean and string): NOTE_CONTACT_MISMATCH',
  public.t3_do($q$SELECT public.activate_promissory_note(public.t3_tok('g4'))$q$), '42501: NOTE_CONTACT_MISMATCH%');
SELECT public.t_as(NULL) IS NULL AS x \gset
UPDATE auth.identities SET identity_data = '{"email":"N4@t3.test","email_verified":true}' WHERE provider_id = 'g-t3e';
SELECT public.t_as('e') IS NULL AS x \gset
SELECT public.t_check('Q6 the Google identity with email_verified true: linked', public.activate_promissory_note(public.t3_tok('g4')) ->> 'success', 'true');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('Q6 e at the note rate', public.t3_owner('g4') || '/' || public.t_rate('e'), 'e/15|promissory_note');

-- ===========================================================================
-- PRIV-A2. Q3: the agent_id round trip
-- ===========================================================================
-- operations: move to y, y self-links as the agent (no window for the author), move back -> refused
SELECT public.t_as('ops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('PRIV-A2 operations moves unlinked rt to y (opens nothing yet)',
  public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('y') WHERE activation_token = public.t3_tok('rt')$q$), 'ok');
RESET ROLE;
SELECT public.t_as('y') IS NULL AS x \gset
SELECT public.t_check('PRIV-A2 y activates rt as its own agent (no window for the author)',
  public.activate_promissory_note(public.t3_tok('rt')) ->> 'success', 'true');
SELECT public.t_as('ops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_like('PRIV-A2 operations moves rt back to a1: refused (NOTE_AGENT_CHANGE_OPENS_WINDOW, Partner Ops can move it)',
  public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('a1') WHERE activation_token = public.t3_tok('rt')$q$),
  '42501: NOTE_AGENT_CHANGE_OPENS_WINDOW%Partner Ops can move it%');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('PRIV-A2 after the refused move: rt still with agent y, y stays 10|new',
  public.t3_agent('rt') || '/' || public.t3_owner('rt') || '/' || public.t_rate('y'), 'y/y/10|new');
-- agent_ops on a pending note: the same round trip
SELECT public.t_as('agops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('PRIV-A2 agent_ops moves unlinked rt2 to z', public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('z') WHERE activation_token = public.t3_tok('rt2')$q$), 'ok');
RESET ROLE;
SELECT public.t_as('z') IS NULL AS x \gset
SELECT public.t_check('PRIV-A2 z activates rt2 as its agent', public.activate_promissory_note(public.t3_tok('rt2')) ->> 'success', 'true');
SELECT public.t_as('agops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_like('PRIV-A2 agent_ops moves rt2 back: refused',
  public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('a1') WHERE activation_token = public.t3_tok('rt2')$q$), '42501: NOTE_AGENT_CHANGE_OPENS_WINDOW%');
RESET ROLE;
-- an agent change that opens nothing (linked to a PROVEN person who is not the new agent) is allowed
SELECT public.t_as('ops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('PRIV-A2 operations moves g4 (linked to the proven e) to agent a2: allowed (opens nothing)',
  public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('a2') WHERE activation_token = public.t3_tok('g4')$q$), 'ok');
RESET ROLE;
-- +ctrl partner staff transfer: partner_ops may move rt back (by design, Partner Ops is trusted to link)
SELECT public.t_as('pops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('PRIV-A2 +ctrl partner_ops (browser) moves rt back to a1: allowed',
  public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('a1') WHERE activation_token = public.t3_tok('rt')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('PRIV-A2 +ctrl after the partner-staff move y has the note''s window (15)', public.t_rate('y'), '15|promissory_note');
-- Q3b: one statement that moves the agent onto the person AND links them, by a caller who is not partner staff: held
SELECT public.t_as('ops') IS NULL AS x \gset
UPDATE public.promissory_notes SET agent_id = public.pid('s'), partner_user_id = public.pid('s') WHERE activation_token = public.t3_tok('same');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('PRIV-A2 (Q3b) agent + link in ONE owner-run statement by operations: link held (event), agent move kept, s 10|new',
  public.t3_owner('same') || '/' || public.t3_held('same') || '/' || public.t3_agent('same') || '/' || public.t_rate('s'), 'nobody/1/s/10|new');
UPDATE public.promissory_notes SET partner_user_id = public.pid('s') WHERE activation_token = public.t3_tok('same');
SELECT public.t_check('PRIV-A2 (Q3b) a later link by the (now unchanged) own agent: not held, but no window for the author (10|new)',
  public.t3_owner('same') || '/' || public.t3_held('same') || '/' || public.t_rate('s'), 's/1/10|new');

-- ===========================================================================
-- R6. The book-transfer laundering: agent_ops moves an unlinked note to rx, rx's profile phone links it (own agent),
--     the book goes back -> refused; partner_ops doing the same is allowed (control, by design)
-- ===========================================================================
SELECT public.t_as('agops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('R6 agent_ops moves unlinked r6 to rx', public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('rx') WHERE activation_token = public.t3_tok('r6')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
UPDATE public.profiles SET phone = '0771555004' WHERE id = public.pid('rx');
SELECT public.t_check('R6 rx''s profile phone links r6 (rx is its agent: no hold, no window)', public.t3_owner('r6') || '/' || public.t3_held('r6') || '/' || public.t_rate('rx'), 'rx/0/10|new');
SELECT public.t_as('agops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_like('R6 agent_ops moves r6 back to a1: refused', public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('a1') WHERE activation_token = public.t3_tok('r6')$q$), '42501: NOTE_AGENT_CHANGE_OPENS_WINDOW%');
RESET ROLE;
SELECT public.t_as('ops') IS NULL AS x \gset
SELECT public.t3_like('R6 the same move owner-run (an RPC) with an operations JWT: refused too', public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('a1') WHERE activation_token = public.t3_tok('r6')$q$), '42501: NOTE_AGENT_CHANGE_OPENS_WINDOW%');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t3_like('R6 the same move from a backend with no JWT: refused', public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('a1') WHERE activation_token = public.t3_tok('r6')$q$), '42501: NOTE_AGENT_CHANGE_OPENS_WINDOW%');
SELECT public.t_check('R6 rx never gets the window: 10|new, note still with rx', public.t_rate('rx') || '/' || public.t3_agent('r6'), '10|new/rx');
-- control: partner_ops does the same laundering sequence (allowed by design: Partner Ops links notes)
SELECT public.t_as('pops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('R6 +ctrl partner_ops moves r6p to rx', public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('rx') WHERE activation_token = public.t3_tok('r6p')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
UPDATE public.promissory_notes SET partner_user_id = public.pid('rx') WHERE activation_token = public.t3_tok('r6p');
SELECT public.t_as('pops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('R6 +ctrl partner_ops moves r6p back to a1: allowed', public.t3_do($q$UPDATE public.promissory_notes SET agent_id = public.pid('a1') WHERE activation_token = public.t3_tok('r6p')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('R6 +ctrl after the partner-staff move rx has the window (15)', public.t_rate('rx'), '15|promissory_note');

-- ===========================================================================
-- R3. Q4: a move away from an account with no profile counts as a first link
-- ===========================================================================
INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome) VALUES ('256771555002', public.pid('ry'), 'success');
UPDATE public.profiles SET phone = '0771555002' WHERE id = public.pid('ry');
SELECT public.t_check('R3 setup: ry proved mv''s number by OTP; its profile phone links mv (15)', public.t3_owner('mv') || '/' || public.t_rate('ry'), 'ry/15|promissory_note');
DELETE FROM public.profiles WHERE id = public.pid('ry');
SELECT public.t_as('ops') IS NULL AS x \gset
SELECT public.t_check('R3 operations arrival match moves mv from the profile-less ry to the unproven rz: the RPC answers',
  public.t3_do(format('SELECT public.promissory_confirm_arrival_match(%L, %L, %L)', public.t3_nid('mv'), public.pid('rz'), 'moving this note to another account')), 'ok');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('R3 the move is held: mv stays with ry, one event, rz 10|new',
  public.t3_owner('mv') || '/' || public.t3_held('mv') || '/' || public.t_rate('rz'), 'ry/1/10|new');
SELECT public.t_check('R3 the report counts mv as held (its person has no profile)',
  (SELECT (count(DISTINCT e.related_entity_id) FILTER (WHERE e.related_entity_id = public.t3_nid('mv')))::text FROM public.system_events e
    WHERE e.event_type = 'promissory_note_link_held'), '1');
-- control: Partner Ops makes the same move -> goes through
SELECT public.t_as('pops') IS NULL AS x \gset
SELECT public.t_check('R3 +ctrl partner_ops arrival match of the same move: linked',
  public.promissory_confirm_arrival_match(public.t3_nid('mv'), public.pid('rz'), 'partner ops confirms the account') ->> 'partner_user_id', public.pid('rz')::text);
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('R3 +ctrl rz linked at the note rate', public.t3_owner('mv') || '/' || public.t_rate('rz'), 'rz/15|promissory_note');

-- ===========================================================================
-- +ctrl. OTP-proven link allowed; a real hold from a browser-initiated profile save still records its event
-- ===========================================================================
INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome, stage) VALUES ('0771009004', public.pid('q'), 'success', 'magic_link_issued');
SELECT public.t_as('q') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('+ctrl q proved otp''s frozen number by OTP: activation by token links', public.t3_do($q$SELECT public.activate_promissory_note(public.t3_tok('otp'))$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('+ctrl q at the note rate', public.t3_owner('otp') || '/' || public.t_rate('q'), 'q/15|promissory_note');
-- h signs up from the browser: the profile insert (h's JWT) runs production's owner-run link trigger; the hold writes
-- its event as the trigger owner, so the RESTRICTIVE browser policy does not stop the REAL event.
GRANT INSERT, SELECT ON public.profiles TO authenticated;
CREATE POLICY t3_profiles_self_insert ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY t3_profiles_self_read ON public.profiles FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));
SELECT public.t_as('h') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('+ctrl h''s browser profile save carrying hold''s number succeeds',
  public.t3_do($q$INSERT INTO public.profiles (id, full_name, phone) VALUES (public.pid('h'), 'T3 h', '0771009002')$q$), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('+ctrl the real hold is recorded (one event written by the trigger owner), the note stays unlinked, h 10|new',
  public.t3_owner('hold') || '/' || public.t3_held('hold') || '/' || public.t_rate('h'), 'nobody/1/10|new');

-- ===========================================================================
-- PRIV-C. Q5: a forged 'promissory_note_link_held' event from a browser is refused
-- ===========================================================================
SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS today \gset
SELECT public.get_partner_return_report(:'today'::date - 1, :'today'::date + 1) ->> 'note_links_held' AS held_before \gset
SELECT public.t_as('w') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_like('PRIV-C a signed-in user forges a held event for a stranger''s note in the real event''s shape: refused by system_events_no_browser_link_held',
  public.t3_do($q$INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, description, metadata)
                 SELECT 'promissory_note_link_held', public.pid('w'), 'promissory_notes', public.t3_nid('two'),
                        'Promissory note link held: Partner Ops can link it', jsonb_build_object('note_id', public.t3_nid('two'), 'held_user_id', public.pid('w'))$q$),
  '42501:%system_events_no_browser_link_held%');
SELECT public.t3_like('PRIV-C the same forged event with user_id NULL: refused', public.t3_do($q$INSERT INTO public.system_events (event_type, related_entity_id) VALUES ('promissory_note_link_held', gen_random_uuid())$q$),
  '42501:%system_events_no_browser_link_held%');
SELECT public.t_check('PRIV-C another self event from the browser still goes in', public.t3_do($q$INSERT INTO public.system_events (event_type, user_id) VALUES ('ui_ping', public.pid('w'))$q$), 'ok');
RESET ROLE;
SET ROLE anon;
SELECT public.t3_like('PRIV-C anon cannot write it either', public.t3_do($q$INSERT INTO public.system_events (event_type) VALUES ('promissory_note_link_held')$q$), '42501:%');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('PRIV-C the report did not move; no forged event exists',
  (public.get_partner_return_report(:'today'::date - 1, :'today'::date + 1) ->> 'note_links_held') || '/'
  || (SELECT count(*) FROM public.system_events WHERE event_type = 'promissory_note_link_held' AND related_entity_id = public.t3_nid('two')),
  :'held_before' || '/0');
SELECT public.t_check('PRIV-C note_links_held = distinct held notes still without a person (none, or an account with no profile)',
  public.get_partner_return_report(:'today'::date - 1, :'today'::date + 1) ->> 'note_links_held',
  (SELECT count(DISTINCT e.related_entity_id)::text FROM public.system_events e JOIN public.promissory_notes n ON n.id = e.related_entity_id
    WHERE e.event_type = 'promissory_note_link_held'
      AND (n.partner_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = n.partner_user_id))));
SELECT public.t_check('PRIV-C the expected held set today: edit (unlinked) and hold (unlinked); same and mv were linked later and do not count',
  (SELECT string_agg(DISTINCT replace(n.partner_name, 'T3 ', ''), ',' ORDER BY replace(n.partner_name, 'T3 ', ''))
     FROM public.system_events e JOIN public.promissory_notes n ON n.id = e.related_entity_id
    WHERE e.event_type = 'promissory_note_link_held'
      AND (n.partner_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = n.partner_user_id))), 'edit,hold');
BEGIN;
DROP POLICY system_events_no_browser_link_held ON public.system_events;
SELECT ok::text AS pc_nopol FROM public._partner_return_phase4_checks(true) WHERE check_name = 'activation_contact_match' \gset
ROLLBACK;
SELECT public.t_check('PRIV-C without the policy the release check activation_contact_match fails (and so the switch-on guard)', :'pc_nopol', 'false');
-- Not counted (finding): the check looks only for a RESTRICTIVE policy of that name, not its roles, command or
-- WITH CHECK, nor that RLS is on for system_events.
BEGIN;
ALTER POLICY system_events_no_browser_link_held ON public.system_events TO anon;
SELECT ok::text AS pc_anon FROM public._partner_return_phase4_checks(true) WHERE check_name = 'activation_contact_match' \gset
ROLLBACK;
BEGIN;
ALTER POLICY system_events_no_browser_link_held ON public.system_events WITH CHECK (true);
SELECT ok::text AS pc_true FROM public._partner_return_phase4_checks(true) WHERE check_name = 'activation_contact_match' \gset
ROLLBACK;
BEGIN;
ALTER TABLE public.system_events DISABLE ROW LEVEL SECURITY;
SELECT ok::text AS pc_norls FROM public._partner_return_phase4_checks(true) WHERE check_name = 'activation_contact_match' \gset
ROLLBACK;
SELECT 'INFO  PRIV-C (not counted) activation_contact_match with the policy weakened: roles anon only -> ' || :'pc_anon'
    || '; WITH CHECK (true) -> ' || :'pc_true' || '; RLS off on system_events -> ' || :'pc_norls' || ' (true = the check does not notice)';

-- ===========================================================================
-- Q7. Staff MFA on the partner-staff checks (production's staff_mfa_ok; mode 'all' / 'off')
-- ===========================================================================
UPDATE public.staff_mfa_config SET mode = 'all';
SELECT public.t3_aal('pops', 'aal1') IS NULL AS x \gset
SELECT public.t_check('Q7 mode all, partner_ops aal1: not partner staff for the rate view and the Returns helper',
  public.partner_rate_visible_to_caller(public.pid('y'))::text || '/' || public.partner_returns_visible_to_caller(public.pid('y'))::text, 'false/false');
SELECT public.t3_like('Q7 mode all, partner_ops aal1: the Partner Returns report refused', public.t3_do($q$SELECT public.get_partner_return_report(current_date - 1, current_date)$q$), '42501%');
UPDATE public.promissory_notes SET partner_user_id = public.pid('p') WHERE activation_token = public.t3_tok('mfa');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('Q7 mode all, partner_ops aal1 (owner-run) link of an unproven person: held', public.t3_owner('mfa') || '/' || public.t3_held('mfa'), 'nobody/1');
SELECT public.t3_aal('pops', 'aal2') IS NULL AS x \gset
SELECT public.t_check('Q7 mode all, partner_ops aal2: partner staff', public.partner_rate_visible_to_caller(public.pid('y'))::text || '/' || public.partner_returns_visible_to_caller(public.pid('y'))::text, 'true/true');
UPDATE public.promissory_notes SET partner_user_id = public.pid('p') WHERE activation_token = public.t3_tok('mfa');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('Q7 mode all, partner_ops aal2 link: goes through at the note rate', public.t3_owner('mfa') || '/' || public.t_rate('p'), 'p/15|promissory_note');
SELECT public.t3_aal('p', 'aal1') IS NULL AS x \gset
SELECT public.t_check('Q7 mode all, the person themselves (aal1, not staff): own rate, own Returns, quote me unaffected',
  public.partner_rate_visible_to_caller(public.pid('p'))::text || '/' || public.partner_returns_visible_to_caller(public.pid('p'))::text || '/'
  || public.partner_quote_rate('me', NULL)::text, 'true/true/15');
SELECT public.t3_aal('ops', 'aal2') IS NULL AS x \gset
SELECT public.t_check('Q7 operations with aal2 is still not partner staff', public.partner_returns_visible_to_caller(public.pid('p'))::text, 'false');
UPDATE public.staff_mfa_config SET mode = 'off';
SELECT public.t3_aal('pops', 'aal1') IS NULL AS x \gset
SELECT public.t_check('Q7 mode off: partner_ops aal1 is partner staff again (no-op until admin/all)',
  public.partner_rate_visible_to_caller(public.pid('y'))::text, 'true');
UPDATE public.staff_mfa_config SET mode = 'shadow';
SELECT public.t3_aal('pops', 'aal1') IS NULL AS x \gset
SELECT public.t_check('Q7 mode shadow (production today): partner_ops aal1 is partner staff', public.partner_rate_visible_to_caller(public.pid('y'))::text, 'true');
SELECT public.t_as(NULL) IS NULL AS x \gset

-- ===========================================================================
-- R1. Q1: locked_from_portfolio_id is immutable outside the owner-run split / lock tools
-- ===========================================================================
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE id = :'rp_a';
SELECT public.t_check('R1 rp redeemed everything: now a new partner (10|new)', public.t_rate('rp'), '10|new');
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin, status)
VALUES (public.pid('rp'), public.pid('a1'), 'T3-RP-C', 1000000, 12, '1111', 'active');
SELECT id AS rp_c FROM public.investor_portfolios WHERE portfolio_code = 'T3-RP-C' \gset
SELECT public.t_check('R1 rp''s new portfolio opens at 10', split_part(public.t_desc(:'rp_c'), '|', 1) || '|' || split_part(public.t_desc(:'rp_c'), '|', 2), '10|new');
GRANT SELECT, UPDATE ON public.investor_portfolios TO authenticated;
CREATE POLICY t3_coo_update ON public.investor_portfolios FOR UPDATE TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'coo'))) WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'coo')));
CREATE POLICY t3_coo_read ON public.investor_portfolios FOR SELECT TO authenticated USING ((SELECT public.has_role((SELECT auth.uid()), 'coo')));
SELECT public.t_as('coo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t3_like('R1 a COO (browser, production''s COO update policy stand-in) re-parents rp''s 10% portfolio onto the redeemed 18% one: refused',
  public.t3_do(format('UPDATE public.investor_portfolios SET locked_from_portfolio_id = %L WHERE id = %L', :'rp_a', :'rp_c')), '42501:%split or lock tools%');
SELECT public.t_check('R1 +ctrl the COO edits another column of the same portfolio: allowed',
  public.t3_do(format('UPDATE public.investor_portfolios SET duration_months = 13 WHERE id = %L', :'rp_c')), 'ok');
RESET ROLE;
SELECT public.t_as(NULL) IS NULL AS x \gset
SET ROLE service_role;
SELECT public.t3_like('R1 service_role (an edge function) re-parents it: refused',
  public.t3_do(format('UPDATE public.investor_portfolios SET locked_from_portfolio_id = %L WHERE id = %L', :'rp_a', :'rp_c')), '42501:%split or lock tools%');
SELECT public.t_check('R1 +ctrl service_role edits another column: allowed', public.t3_do(format('UPDATE public.investor_portfolios SET duration_months = 12 WHERE id = %L', :'rp_c')), 'ok');
RESET ROLE;
SELECT public.t_check('R1 after the refused edits rp stays new (10|new), the portfolio has no parent, the next one opens at 10',
  public.t_rate('rp') || '/' || COALESCE((SELECT locked_from_portfolio_id::text FROM public.investor_portfolios WHERE id = :'rp_c'), 'none'), '10|new/none');
SELECT public.t_check('R1 +ctrl owner-run (the split / lock tools run as the owner) may still set the column',
  public.t3_do(format('UPDATE public.investor_portfolios SET locked_from_portfolio_id = NULL WHERE id = %L', :'rp_c')), 'ok');
SELECT public.t_check('R1 the guard covers INSERT and UPDATE OF locked_from_portfolio_id, investor_id (T2); carry_link_immutable ok',
  (SELECT (pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE OF locked_from_portfolio_id, investor_id, status ON public.investor_portfolios%')::text FROM pg_trigger WHERE tgname = 'trg_partner_return_carry_guard')
  || '/' || (SELECT ok::text FROM public.assert_partner_return_policy_intact() WHERE check_name = 'carry_link_immutable'), 'true/true');
BEGIN;
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_carry_guard;
SELECT ok::text AS r1_disabled FROM public.assert_partner_return_policy_intact() WHERE check_name = 'carry_link_immutable' \gset
ROLLBACK;
BEGIN;
CREATE OR REPLACE TRIGGER trg_partner_return_carry_guard BEFORE INSERT ON public.investor_portfolios FOR EACH ROW EXECUTE FUNCTION public.guard_partner_return_carry();
SELECT ok::text AS r1_insert_only FROM public.assert_partner_return_policy_intact() WHERE check_name = 'carry_link_immutable' \gset
ROLLBACK;
BEGIN;
UPDATE public.partner_return_policy SET enabled = false;
CREATE OR REPLACE TRIGGER trg_partner_return_carry_guard BEFORE INSERT ON public.investor_portfolios FOR EACH ROW EXECUTE FUNCTION public.guard_partner_return_carry();
SELECT public.t_err($s$UPDATE public.partner_return_policy SET enabled = true$s$) AS r1_switch_on \gset
ROLLBACK;
SELECT public.t_check('R1 carry_link_immutable fails with the guard disabled / INSERT-only; switching on again is refused naming it',
  :'r1_disabled' || '/' || :'r1_insert_only' || '/' || :'r1_switch_on',
  'false/false/55000: Partner Returns cannot be turned on: these checks fail: carry_link_immutable (see assert_partner_return_policy_intact())');

-- ===========================================================================
-- Release checks: each round-3 hook is required
-- ===========================================================================
BEGIN;
CREATE OR REPLACE TRIGGER trg_zz_guard_note_window_link BEFORE UPDATE OF partner_user_id ON public.promissory_notes FOR EACH ROW EXECUTE FUNCTION public.guard_note_window_link();
SELECT ok::text AS rc_no_agent FROM public._partner_return_phase4_checks(true) WHERE check_name = 'activation_contact_match' \gset
ROLLBACK;
SELECT public.t_check('RC the hold trigger without agent_id: activation_contact_match fails', :'rc_no_agent', 'false');
SELECT public.t_check('RC all Phase 4 release checks pass at the end; the assert is clean (26)',
  (SELECT COALESCE(string_agg(check_name, ','), 'none') FROM public._partner_return_phase4_checks(true) WHERE NOT ok) || '/'
  || (SELECT count(*) || '/' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()),
  'none/26/all ok');

SELECT 'SUMMARY ' || count(*) FILTER (WHERE ok) || '/' || count(*) || ' passed'
       || COALESCE(' -- FAILED: ' || string_agg(name, '; ' ORDER BY n) FILTER (WHERE NOT ok), '')
  FROM public._t_results;
