-- Phase 4 fix round (S1-S8) functional tests against production's own link functions, profile triggers and trust impl
-- (loaded verbatim by run_phase4_tests.sh: prod_link_functions.sql, prod_trust_impl.sql). LOCAL THROWAWAY CLUSTER ONLY.
-- Prerequisite: a FRESH Phase 4 load (switch off, no cut-off): this file switches Partner Returns on itself (S3) and
-- tests the profile-link hold (S1), the carve-out chain (S2), the invite claim (S4), open invites (S5), the mixed-rate
-- notice (S6) and the trust-profile masks (S7, also from an authenticator session as anon). Runs as postgres; auth.uid()
-- through request.jwt.claim.sub (t_as). Prints one PASS/FAIL line per assertion and a SUMMARY line.
\pset tuples_only on
\pset format unaligned
\pset pager off
SET client_min_messages = warning;
\ir phase2_helpers.sql
SELECT public.t_as(NULL) IS NULL AS x \gset

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fx_user(p_name text, p_email text DEFAULT NULL, p_roles text[] DEFAULT '{}',
                               p_email_ok boolean DEFAULT false, p_phone text DEFAULT NULL, p_phone_ok boolean DEFAULT false)
 RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at, phone, phone_confirmed_at)
  VALUES (public.pid(p_name), COALESCE(p_email, p_name || '@fx.test'), CASE WHEN p_email_ok THEN now() END, p_phone,
          CASE WHEN p_phone_ok THEN now() END) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role, enabled) SELECT public.pid(p_name), r, true FROM unnest(p_roles) r
  ON CONFLICT DO NOTHING;
  RETURN public.pid(p_name);
END $$;
-- The profile row (signup: handle_new_user inserts it; the profile triggers link notes).
CREATE FUNCTION public.fx_profile(p_name text, p_phone text DEFAULT NULL, p_email text DEFAULT NULL) RETURNS uuid
 LANGUAGE sql AS $$
  INSERT INTO public.profiles (id, full_name, email, phone) VALUES (public.pid(p_name), 'FX ' || p_name, COALESCE(p_email, p_name || '@fx.test'), p_phone)
  RETURNING id $$;
CREATE FUNCTION public.fx_note(p_key text, p_phone text, p_email text DEFAULT NULL, p_agent text DEFAULT 'agent1',
                               p_status text DEFAULT 'activated') RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.promissory_notes (agent_id, partner_name, whatsapp_number, email, amount, status, fulfilment_due_on, activation_token)
  VALUES (public.pid(p_agent), 'FX ' || p_key, p_phone, p_email, 500000, p_status, current_date + 10, 'tok-' || md5('fx:' || p_key))
  RETURNING id $$;
CREATE TABLE public._t_people_fx (k text PRIMARY KEY, id uuid);
CREATE FUNCTION public.fx_owner(p_key text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT k FROM public._t_people_fx WHERE id = n.partner_user_id), CASE WHEN n.partner_user_id IS NULL THEN 'nobody' ELSE 'other' END)
    FROM public.promissory_notes n WHERE n.activation_token = 'tok-' || md5('fx:' || p_key) $$;
CREATE FUNCTION public.fx_held(p_key text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM public.system_events e JOIN public.promissory_notes n ON n.id = e.related_entity_id
   WHERE e.event_type = 'promissory_note_link_held' AND n.activation_token = 'tok-' || md5('fx:' || p_key) $$;
CREATE FUNCTION public.fx_port(p_person text, p_rate numeric DEFAULT NULL, p_parent uuid DEFAULT NULL, p_amount numeric DEFAULT 1000000,
                               p_status text DEFAULT 'active')
 RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin,
                                         status, roi_percentage, locked_from_portfolio_id)
  VALUES (CASE WHEN p_person IS NULL THEN NULL ELSE public.pid(p_person) END, public.pid('agent1'),
          'FX-' || COALESCE(p_person, 'invite') || '-' || substr(md5(random()::text), 1, 6), p_amount, 12, '1111', p_status, p_rate, p_parent)
  RETURNING id $$;
CREATE FUNCTION public.fx_leaves(j jsonb) RETURNS TABLE (path text, val jsonb) LANGUAGE sql IMMUTABLE AS $$
  WITH RECURSIVE t(path, val) AS (
    SELECT e.k, e.v FROM jsonb_each(j) e(k, v)
    UNION ALL
    SELECT t.path || '.' || e.k, e.v FROM t, jsonb_each(t.val) e(k, v) WHERE jsonb_typeof(t.val) = 'object')
  SELECT path, val FROM t WHERE jsonb_typeof(val) <> 'object' $$;

INSERT INTO public._t_people_fx
SELECT x, public.fx_user(x) FROM unnest(ARRAY['fx_pre', 'fx_unp1', 'fx_mail2', 'fx_otp3', 'fx_chg4', 'fx_multi', 'fx_goo7',
                                            'fx_unp8', 'fx_unp9', 'fx_flag10', 'fx_otp11', 'fx_late12', 'fx_late13', 'sp', 'sq', 'fx_rpc_flag', 'fx_exp15']) x;
INSERT INTO public._t_people_fx VALUES ('fx_ag14', public.fx_user('fx_ag14', NULL, ARRAY['agent']));
INSERT INTO public._t_people_fx VALUES ('fxpops', public.fx_user('fxpops', NULL, ARRAY['partner_ops'])),
                                       ('fxops', public.fx_user('fxops', NULL, ARRAY['operations']));
UPDATE auth.users SET email_confirmed_at = now(), phone = '256771000010', phone_confirmed_at = now(), email = 'n10@note.test'
 WHERE id IN (public.pid('fx_flag10'), public.pid('fx_rpc_flag'));

-- ---------------------------------------------------------------------------
-- A. Before the cut-off: production's profile linking is unchanged (no windows, nothing held)
-- ---------------------------------------------------------------------------
SELECT public.fx_note('pre', '0771000099') IS NOT NULL AS x \gset
SELECT public.fx_profile('fx_pre', '0771000099') IS NOT NULL AS x \gset
SELECT public.t_check('S1 before the cut-off: an unproven profile phone links a note exactly as today (owner-run trigger), nothing held',
  public.fx_owner('pre') || '/' || (SELECT count(*) FROM public.system_events WHERE event_type = 'promissory_note_link_held'), 'fx_pre/0');

-- Notes that exist at the cut-off (they get frozen windows), people and portfolios for S2 / S4.
SELECT count(*) FROM (SELECT public.fx_note(k, ph, em) FROM (VALUES
  ('n1', '0771000001', NULL), ('n2', '0700000002', 'n2@note.test'), ('n3', '0771000003', NULL), ('n4', '0771000004', NULL),
  ('n5', '0700000005', 'n5@note.test'), ('n6', '0771000006', NULL), ('n7', '0700000007', 'n7@note.test'),
  ('n8', '0771000008', NULL), ('n9', '0771000009', NULL), ('n10', '0771000010', 'n10@note.test'), ('n11', '0771000011', NULL),
  ('n12', '0771000012', NULL), ('n13', '0771000013', NULL), ('rpc', '0771000020', 'n10@note.test'), ('n15', '0771000015', NULL)) v(k, ph, em)) s \gset
SELECT public.fx_note('n14', '0771000014', NULL, 'fx_ag14') IS NOT NULL AS x \gset
SELECT public.fx_port('sp', 18) AS sp_a \gset
SELECT public.fx_port('sq', 16) AS sq_a \gset
SELECT public.t_check('S2 setup: sp holds a live 18% portfolio from before the cut-off', public.t_desc(:'sp_a'::uuid), '18|typed_switch_off|18|-');

-- ---------------------------------------------------------------------------
-- S6: a 'funded' booking notice whose houses carry two rates (P9 seed) does not fail open_notices_carry_rate
-- ---------------------------------------------------------------------------
SELECT public.t_check('S6 the mixed-rate funded booking notice keeps NULL and open_notices_carry_rate passes (release checks too)',
  (SELECT count(*) FROM public.promissory_house_booking_notices b JOIN public.promissory_notes n ON n.id = b.note_id
    WHERE n.partner_name = 'P9 funded mixed' AND b.return_rate IS NULL) || '/'
  || (SELECT ok FROM public._partner_return_phase4_checks(true) WHERE check_name = 'open_notices_carry_rate'), '1/true');
BEGIN;
INSERT INTO public.promissory_house_booking_notices (note_id, partner_user_id, kind, partner_name, house_count, total_rent)
SELECT n.id, n.partner_user_id, 'reserved', n.partner_name, 1, 1 FROM public.promissory_notes n WHERE n.partner_name = 'P9 funded mixed';
SELECT ok AS s6_reserved FROM public._partner_return_phase4_checks(false) WHERE check_name = 'open_notices_carry_rate' \gset
ROLLBACK;
SELECT public.t_check('S6 an unsent rate-less notice that is not a mixed-rate funded one still fails the check', :'s6_reserved', 'f');

-- ---------------------------------------------------------------------------
-- S3: one UPDATE setting release_ready and enabled together runs the release-only checks
-- ---------------------------------------------------------------------------
-- The REAL security migration (20261106200000, 5e2ad5e930, verbatim): the guard trigger, the browser INSERT policy dropped.
\ir sec_link_security_load.sql
SELECT COALESCE(string_agg(check_name, ','), 'none') AS rel_fail FROM public._partner_return_phase4_checks(true) WHERE NOT ok \gset
SELECT public.t_check('S3 setup: every release check passes with 4b and the real security migration', :'rel_fail', 'none');
BEGIN;
ALTER TABLE public.promissory_notes DISABLE TRIGGER trg_guard_note_direct_edit;
SELECT public.t_err($s$UPDATE public.partner_return_policy SET release_ready = true, enabled = true$s$) AS s3_combined \gset
ROLLBACK;
SELECT public.t_check('S3 release_ready + enabled in ONE owner UPDATE while a release check fails: refused, naming it',
  :'s3_combined', '55000: Partner Returns cannot be turned on: these release checks fail: note_browser_writes_closed (see _partner_return_phase4_checks(true))');
BEGIN;
ALTER TABLE public.promissory_notes DISABLE TRIGGER trg_zz_guard_note_window_link;
SELECT public.t_err($s$UPDATE public.partner_return_policy SET release_ready = true, enabled = true$s$) AS s3_hold_off \gset
ROLLBACK;
SELECT public.t_check('S1d/S3 the link hold trigger disabled: switch-on refused (activation_contact_match)',
  :'s3_hold_off', '55000: Partner Returns cannot be turned on: these checks fail: activation_contact_match (see assert_partner_return_policy_intact())');
UPDATE public.partner_return_policy SET release_ready = true, enabled = true;
SELECT public.t_check('S3 the same UPDATE with every check passing turns the switch on (cut-off set, windows frozen)',
  (SELECT enabled || '/' || (cutoff_at IS NOT NULL) FROM public.partner_return_policy) || '/'
  || (SELECT count(*) FROM public.partner_return_note_windows w JOIN public.promissory_notes n ON n.id = w.note_id
       WHERE n.partner_name LIKE 'FX n%'), 'true/true/15');

-- ---------------------------------------------------------------------------
-- S1: after the cut-off
-- ---------------------------------------------------------------------------
-- 1. unproven profile phone (signup: profile insert, no JWT) -> held, one event for both profile triggers, rate stays new.
SELECT public.fx_profile('fx_unp1', '0771000001') IS NOT NULL AS x \gset
SELECT public.t_check('S1 unproven profile phone after the cut-off: link held (one event for the two profile triggers), rate 10|new',
  public.fx_owner('n1') || '/' || public.fx_held('n1') || '/' || public.t_rate('fx_unp1'), 'nobody/1/10|new');
-- 2. unproven profile email, set by the person later (JWT = the person) -> held.
SELECT public.fx_profile('fx_mail2') IS NOT NULL AS x \gset
SELECT public.t_as('fx_mail2') IS NULL AS x \gset
UPDATE public.profiles SET email = 'N2@note.test ' WHERE id = public.pid('fx_mail2');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('S1 unproven profile email set by the person: held, rate 10|new',
  public.fx_owner('n2') || '/' || public.fx_held('n2') || '/' || public.t_rate('fx_mail2'), 'nobody/1/10|new');
-- 3. OTP login to that number resolved to the account -> linked, 15 window.
INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome, stage) VALUES ('+256 771 000 003', public.pid('fx_otp3'), 'success', 'magic_link_issued'),
  ('0771000001', public.pid('fx_otp3'), 'failed', 'otp_verify');
SELECT public.fx_profile('fx_otp3', '0771000003') IS NOT NULL AS x \gset
SELECT public.t_check('S1 OTP-proven phone: linked, rate 15|promissory_note, no event',
  public.fx_owner('n3') || '/' || public.fx_held('n3') || '/' || public.t_rate('fx_otp3'), 'fx_otp3/0/15|promissory_note');
-- 4. verified phone change to that number -> linked; an expired challenge is not proof.
INSERT INTO public.phone_change_otp_challenges (user_id, new_phone_last9, status, consumed_at)
VALUES (public.pid('fx_chg4'), '771000004', 'consumed', now()), (public.pid('fx_unp9'), '771000009', 'expired', NULL);
SELECT public.fx_profile('fx_chg4') IS NOT NULL AS x \gset
SELECT public.t_as('fx_chg4') IS NULL AS x \gset
UPDATE public.profiles SET phone = '+256771000004' WHERE id = public.pid('fx_chg4');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('S1 consumed phone-change challenge: linked, 15|promissory_note',
  public.fx_owner('n4') || '/' || public.t_rate('fx_chg4'), 'fx_chg4/15|promissory_note');
-- 5/6. one profile save links two notes in ONE statement: the email-proven one goes through, the phone one is held,
--      and the profile save itself succeeds.
INSERT INTO public.email_verification_challenges (user_id, new_email, verified_at) VALUES (public.pid('fx_multi'), 'n5@note.test', now()),
  (public.pid('fx_multi'), 'n6x@note.test', NULL);
SELECT public.fx_note('n6post', '0771000006') IS NOT NULL AS x \gset   -- written after the cut-off: no window
SELECT public.t_runs('S1 a profile save that links one proven and one unproven windowed note and one post-cut-off note succeeds',
  $s$SELECT public.fx_profile('fx_multi', '0771000006', 'n5@note.test')$s$);
SELECT public.t_check('S1 multi-note profile save: only the unproven windowed note is held (event); the email-verified windowed note and the post-cut-off note (no window) link',
  public.fx_owner('n5') || '/' || public.fx_owner('n6') || '/' || public.fx_owner('n6post') || '/' || public.fx_held('n5') || '/' || public.fx_held('n6')
  || '/' || public.fx_held('n6post'), 'fx_multi/nobody/fx_multi/0/1/0');
-- 7. Google sign-in with the note's email -> linked.
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
VALUES ('g-7', public.pid('fx_goo7'), jsonb_build_object('email', 'N7@Note.test'), 'google'),
       ('e-1', public.pid('fx_unp1'), jsonb_build_object('email', 'n7@note.test'), 'email');
SELECT public.fx_profile('fx_goo7', NULL, 'n7@note.test') IS NOT NULL AS x \gset
SELECT public.t_check('S1 Google identity with the note''s email: linked (an email-provider identity is not proof)',
  public.fx_owner('n7') || '/' || public.t_rate('fx_goo7'), 'fx_goo7/15|promissory_note');
-- 8. Partner Ops links someone else (owner-run, staff JWT, as promissory_confirm_arrival_match does) -> linked.
SELECT public.fx_profile('fx_unp8') IS NOT NULL AS x \gset
SELECT public.t_as('fxpops') IS NULL AS x \gset
UPDATE public.promissory_notes SET partner_user_id = public.pid('fx_unp8') WHERE activation_token = 'tok-' || md5('fx:n8');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('S1 a Partner Ops staff link of someone else: linked, 15|promissory_note',
  public.fx_owner('n8') || '/' || public.fx_held('n8') || '/' || public.t_rate('fx_unp8'), 'fx_unp8/0/15|promissory_note');
-- 9. the same by 'operations' (not partner staff), or a backend with no JWT -> held.
SELECT public.fx_profile('fx_unp9') IS NOT NULL AS x \gset
SELECT public.t_as('fxops') IS NULL AS x \gset
UPDATE public.promissory_notes SET partner_user_id = public.pid('fx_unp9') WHERE activation_token = 'tok-' || md5('fx:n9');
SELECT public.t_as(NULL) IS NULL AS x \gset
UPDATE public.promissory_notes SET partner_user_id = public.pid('fx_unp9') WHERE activation_token = 'tok-' || md5('fx:n9');
SELECT public.t_check('S1 an operations-staff link and a backend link (no JWT) of an unproven person: held (two transactions, two events)',
  public.fx_owner('n9') || '/' || public.fx_held('n9'), 'nobody/2');
-- 10. confirmed flags on auth.users are not proof (profile path and token path).
SELECT public.fx_profile('fx_flag10', '0771000010') IS NOT NULL AS x \gset
SELECT public.t_check('S1 auth.users email/phone confirmed flags only: profile link held',
  public.fx_owner('n10') || '/' || public.fx_held('n10'), 'nobody/1');
SELECT public.fx_profile('fx_rpc_flag') IS NOT NULL AS x \gset
SELECT public.t_check('S1 token activation by an account whose matching email and phone are only "confirmed" flags: NOTE_CONTACT_MISMATCH (Partner Ops wording)',
  public.t_err($s$SELECT public.t_as('fx_rpc_flag'); SELECT public.activate_promissory_note('tok-' || md5('fx:rpc'))$s$),
  '42501: NOTE_CONTACT_MISMATCH: this note was written for a phone number or email this account has not confirmed with a code; Partner Ops can link the note to you');
SELECT public.t_as(NULL) IS NULL AS x \gset
-- 11. token activation by an OTP-proven account -> linked by the RPC (and the trigger lets it through).
INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome) VALUES ('256771000011', public.pid('fx_otp11'), 'success');
SELECT public.fx_profile('fx_otp11') IS NOT NULL AS x \gset
SELECT public.t_as('fx_otp11') IS NULL AS x \gset
SELECT (public.activate_promissory_note('tok-' || md5('fx:n11')) ->> 'your_rate') AS r11 \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('S1 token activation by an OTP-proven account: linked, your_rate 15',
  public.fx_owner('n11') || '/' || :'r11', 'fx_otp11/15');
-- 12/13. Phase 2's statement-level late link: a held row is no link (nothing queued); a proven late link is caught up.
SELECT public.fx_profile('fx_late12') IS NOT NULL AS x \gset
SELECT public.fx_profile('fx_late13') IS NOT NULL AS x \gset
SELECT public.fx_port('fx_late12') AS p12 \gset
SELECT public.fx_port('fx_late13') AS p13 \gset
INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome) VALUES ('0771000013', public.pid('fx_late13'), 'success');
UPDATE public.profiles SET phone = '0771000012' WHERE id = public.pid('fx_late12');
UPDATE public.profiles SET phone = '0771000013' WHERE id = public.pid('fx_late13');
SELECT public.t_check('S1 late link: the held person gets no CFO catch-up (10|new kept), the proven one gets one at 15',
  public.fx_owner('n12') || '/' || public.t_desc(:'p12'::uuid) || '/'
  || (SELECT count(*) FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = :'p12'::uuid) || ' | '
  || public.fx_owner('n13') || '/'
  || (SELECT string_agg(a.source || ':' || trim_scale(a.requested_rate), ',') FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = :'p13'::uuid),
  'nobody/10|new|10|-/0 | fx_late13/note_late_link:15');
-- 14. the note's own agent: no window for them, so nothing to hold.
INSERT INTO public.profiles (id, full_name, phone) VALUES (public.pid('fx_ag14'), 'FX agent 14', '0771000014');
SELECT public.t_check('S1 the note''s own agent linked by profile phone: not held (no window for the author), rate 10|new',
  public.fx_owner('n14') || '/' || public.fx_held('n14') || '/' || public.t_rate('fx_ag14'), 'fx_ag14/0/10|new');

-- 15. an expired window: nothing to hold, an unproven profile phone links as today.
ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER USER;
UPDATE public.partner_return_note_windows SET ends_on = (now() AT TIME ZONE 'Africa/Kampala')::date - 1
 WHERE note_id = (SELECT id FROM public.promissory_notes WHERE activation_token = 'tok-' || md5('fx:n15'));
ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER USER;
SELECT public.fx_profile('fx_exp15', '0771000015') IS NOT NULL AS x \gset
SELECT public.t_check('S1 an expired note window: an unproven profile phone links (nothing held), rate 10|new (the window no longer counts)',
  public.fx_owner('n15') || '/' || public.fx_held('n15') || '/' || public.t_rate('fx_exp15'), 'fx_exp15/0/10|new');

-- S1d: the report counts the holds in its window; the checks name the trigger.
SELECT public.t_check('S1d report note_links_held = DISTINCT held notes still without a person (none, or an account with no profile) today (Q5: repeat holds count once, a held note later linked does not count), integer, activation_contact_match ok',
  (public.get_partner_return_report(current_date, current_date) -> 'note_links_held')::text || '/'
  || jsonb_typeof(public.get_partner_return_report(current_date, current_date) -> 'note_links_held') || '/'
  || (SELECT ok FROM public._partner_return_phase4_checks(true) WHERE check_name = 'activation_contact_match'),
  (SELECT count(DISTINCT e.related_entity_id) FROM public.system_events e JOIN public.promissory_notes n ON n.id = e.related_entity_id
    WHERE e.event_type = 'promissory_note_link_held'
      AND (n.partner_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = n.partner_user_id)))::text || '/number/true');
SELECT public.t_check('S1d (Q5) the held events today exceed the distinct still-unlinked notes (fx_unp9 held twice on n9; the count is not a raw event count)',
  ((SELECT count(*) FROM public.system_events WHERE event_type = 'promissory_note_link_held')
   > (public.get_partner_return_report(current_date, current_date) ->> 'note_links_held')::int)::text, 'true');
SELECT 'INFO  S1 held events: ' || (SELECT count(*) FROM public.system_events WHERE event_type = 'promissory_note_link_held')
    || '; auto_linked events written by link_promissory_notes_for_user for held notes: '
    || (SELECT count(*) FROM public.system_events e JOIN public.promissory_notes n ON n.id = e.related_entity_id
         WHERE e.event_type = 'promissory.partner.auto_linked' AND n.partner_user_id IS NULL);

-- ---------------------------------------------------------------------------
-- S2: split -> split -> redeem the original and the middle: the existing partner keeps their own rate
-- ---------------------------------------------------------------------------
SELECT public.fx_port('sp', NULL, :'sp_a'::uuid, 400000) AS sp_s1 \gset
SELECT public.fx_port('sp', NULL, :'sp_s1'::uuid, 200000) AS sp_s2 \gset
SELECT public.fx_port('sp', NULL, :'sp_s2'::uuid, 100000, 'locked') AS sp_l3 \gset
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE id IN (:'sp_a'::uuid, :'sp_s1'::uuid, :'sp_s2'::uuid);
SELECT public.t_check('S2 split -> split -> lock (locked) of that: every child carried at 18; the original and both middles redeemed -> sp stays 18|existing_partner',
  public.t_desc(:'sp_s1'::uuid) || ' ' || public.t_desc(:'sp_s2'::uuid) || ' ' || public.t_desc(:'sp_l3'::uuid) || ' '
  || (SELECT status FROM public.investor_portfolios WHERE id = :'sp_l3'::uuid) || ' ' || public.t_rate('sp'),
  '18|carried|18|- 18|carried|18|- 18|carried|18|- locked 18|existing_partner');
SELECT public.fx_port('sp', NULL) AS sp_new \gset
SELECT public.t_check('S2 sp''s next new portfolio opens at 18|existing_partner', public.t_desc(:'sp_new'::uuid), '18|existing_partner|18|-');
-- sq was existing at the cut-off (16), redeemed everything, came back: new; their new portfolio split twice stays new.
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE id = :'sq_a'::uuid;
SELECT public.fx_port('sq') AS np_a \gset
SELECT public.fx_port('sq', NULL, :'np_a'::uuid, 500000) AS np_s1 \gset
SELECT public.fx_port('sq', NULL, :'np_s1'::uuid, 200000) AS np_s2 \gset
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE id IN (:'np_a'::uuid, :'np_s1'::uuid);
SELECT public.t_check('S2 a cohort partner who redeemed everything and came back: a carried chain from their new portfolio stays new (10|new)',
  public.t_desc(:'np_s2'::uuid) || ' ' || public.t_rate('sq') || ' ' || (SELECT basis FROM public.partner_return_cohort WHERE partner_id = public.pid('sq')),
  '10|carried|10|- 10|new live_portfolio');
-- cycle safety: a (corrupt) carve-out loop does not hang the rule
BEGIN;
ALTER TABLE public.investor_portfolios DISABLE TRIGGER USER;
UPDATE public.investor_portfolios SET locked_from_portfolio_id = :'np_s2'::uuid WHERE id = :'np_a'::uuid;
SELECT public.t_rate('sq') AS np_cycle \gset
ROLLBACK;
SELECT public.t_check('S2 a carve-out cycle terminates (depth cap / visited set) and changes nothing', :'np_cycle', '10|new');

-- ---------------------------------------------------------------------------
-- S4: an existing partner claims an invite with a pending typed-rate request
-- ---------------------------------------------------------------------------
SELECT public.fx_port(NULL, 15) AS inv \gset
SELECT public.t_check('S4 setup: invite typed 15 -> stored 10|new_no_investor, CFO request 15 vs standard 10',
  public.t_desc(:'inv'::uuid) || '/' || (SELECT trim_scale(standard_rate) || ',' || trim_scale(rate_in_force) FROM public.portfolio_rate_approvals WHERE portfolio_id = :'inv'::uuid AND status = 'pending'),
  '10|new_no_investor|10|15/10,10');
SELECT (public.get_partner_return_report(current_date, current_date) #>> '{cfo_queue,pending_lowering}') AS low_before \gset
UPDATE public.investor_portfolios SET investor_id = public.pid('sp') WHERE id = :'inv'::uuid;
SELECT public.t_check('S4 sp (own rate 18) claims it: 18|existing_partner, the pending request now reads standard 18 / in force 18, and pending_lowering counts it',
  public.t_desc(:'inv'::uuid) || '/' || (SELECT trim_scale(standard_rate) || ',' || trim_scale(rate_in_force) FROM public.portfolio_rate_approvals WHERE portfolio_id = :'inv'::uuid AND status = 'pending')
  || '/' || ((public.get_partner_return_report(current_date, current_date) #>> '{cfo_queue,pending_lowering}')::int - :'low_before'::int),
  '18|existing_partner|18|15/18,18/1');

-- ---------------------------------------------------------------------------
-- S5: a live invite nobody has claimed counts as open on the release checklist
-- ---------------------------------------------------------------------------
SELECT (public.get_partner_return_report(current_date, current_date) #>> '{rule_check,open_pending_portfolios}') AS opp_before \gset
SELECT public.fx_port(NULL) AS inv2 \gset
SELECT public.t_check('S5 an active invite with no investor yet is counted in open_pending_portfolios',
  ((public.get_partner_return_report(current_date, current_date) #>> '{rule_check,open_pending_portfolios}')::int - :'opp_before'::int)::text, '1');

-- ---------------------------------------------------------------------------
-- S7: trust-profile masks against production's impl
-- ---------------------------------------------------------------------------
INSERT INTO public._t_people_fx
SELECT x, public.fx_user(x, NULL, r) FROM (VALUES ('tp1', ARRAY['supporter']), ('tp2', ARRAY['supporter']), ('tt', ARRAY['tenant']),
                                                  ('fxag', ARRAY['agent']), ('fxpx', ARRAY['agent'])) v(x, r);
SELECT count(*) FROM (SELECT public.fx_profile(x, NULL) FROM unnest(ARRAY['tp1', 'tp2', 'tt', 'fxag', 'fxpx']) x) s \gset
-- Two partners alike except their principal and Returns.
SELECT public.fx_port('tp1', NULL, NULL, 1000000) IS NOT NULL AS x \gset
SELECT public.fx_port('tp2', NULL, NULL, 3000000) IS NOT NULL AS x \gset
UPDATE public.investor_portfolios SET total_roi_earned = CASE investor_id WHEN public.pid('tp1') THEN 200000 ELSE 450000 END
 WHERE investor_id IN (public.pid('tp1'), public.pid('tp2'));
INSERT INTO public.supporter_roi_payments (rent_request_id, supporter_id, rent_amount, roi_amount, due_date, paid_at, status)
VALUES (gen_random_uuid(), public.pid('tp1'), 1000000, 200000, now(), now() - interval '3 days', 'paid'),
       (gen_random_uuid(), public.pid('tp2'), 3000000, 450000, now(), now() - interval '3 days', 'paid');
INSERT INTO public.wallet_transactions (sender_id, recipient_id, amount, created_at)
SELECT public.pid('fxag'), public.pid(x), 90000, now() - interval '5 days' FROM unnest(ARRAY['tp1', 'tp2', 'tt']) x;
INSERT INTO public.landlords (id, name, phone) VALUES (public.pid('fxll'), 'FX landlord', '0700999999') ON CONFLICT DO NOTHING;
INSERT INTO public.rent_requests (tenant_id, agent_id, landlord_id, rent_amount, amount_repaid)
VALUES (public.pid('tt'), public.pid('fxag'), public.pid('fxll'), 300000, 120000);
INSERT INTO public.proxy_agent_assignments (agent_id, beneficiary_id, beneficiary_role, is_active, approval_status)
VALUES (public.pid('fxpx'), public.pid('tp1'), 'supporter', true, 'approved');
CREATE FUNCTION public.fx_ai(p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'WEL-' || UPPER(SUBSTRING(REPLACE(public.pid(p_name)::text, '-', ''), 1, 6)) $$;
-- What each viewer gets, and what production's impl gives the same viewer in the same transaction.
CREATE FUNCTION public.fx_view(p_viewer text, p_subject text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as(p_viewer); RETURN public.get_user_trust_profile(public.fx_ai(p_subject)); END $$;
CREATE FUNCTION public.fx_impl(p_viewer text, p_subject text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as(p_viewer); RETURN public._get_user_trust_profile_impl(public.pid(p_subject)); END $$;
CREATE TEMP TABLE fx_v AS
SELECT v.viewer, v.subject, public.fx_view(v.viewer, v.subject) AS masked, public.fx_impl(v.viewer, v.subject) AS fullv
  FROM (VALUES ('fxag', 'tp1'), ('fxag', 'tp2'), ('fxag', 'tt'), ('tp1', 'tp1'), ('fxpops', 'tp1'), ('fxpx', 'tp1'), ('fxpx', 'tp2')) v(viewer, subject);
SELECT public.t_as(NULL) IS NULL AS x \gset
-- Every leaf that changes with the principal and the Returns (tp1 vs tp2 in production's impl) ...
CREATE TEMP TABLE fx_dep AS
SELECT a.path FROM fx_v x1 JOIN fx_v x2 ON x1.viewer = 'fxag' AND x1.subject = 'tp1' AND x2.viewer = 'fxag' AND x2.subject = 'tp2'
  CROSS JOIN LATERAL public.fx_leaves(x1.fullv) a JOIN LATERAL public.fx_leaves(x2.fullv) b ON b.path = a.path
 WHERE a.val IS DISTINCT FROM b.val AND a.path NOT IN ('ai_id', 'user_id', 'identity.full_name');
SELECT 'INFO  S7 leaves of production''s impl that move with principal / Returns: ' || string_agg(path, ', ' ORDER BY path) FROM fx_dep;
SELECT public.t_check('S7 an agent viewing a partner: every leaf that moves with principal or Returns is null (keys kept)',
  (SELECT string_agg(d.path || '=' || COALESCE(l.val::text, 'MISSING'), ' ' ORDER BY d.path)
     FROM fx_dep d JOIN fx_v x ON x.viewer = 'fxag' AND x.subject = 'tp1'
     LEFT JOIN LATERAL public.fx_leaves(x.masked) l ON l.path = d.path WHERE l.val IS DISTINCT FROM 'null'::jsonb), NULL);
SELECT public.t_check('S7 an agent viewing two partners with different principal and Returns sees the same figures (nothing left to derive them from)',
  (SELECT string_agg(a.path, ',' ORDER BY a.path)
     FROM fx_v x1 JOIN fx_v x2 ON x1.viewer = 'fxag' AND x1.subject = 'tp1' AND x2.viewer = 'fxag' AND x2.subject = 'tp2'
     CROSS JOIN LATERAL public.fx_leaves(x1.masked) a JOIN LATERAL public.fx_leaves(x2.masked) b ON b.path = a.path
    WHERE a.val IS DISTINCT FROM b.val), 'ai_id,identity.full_name,user_id');
SELECT public.t_check('S7 an agent (not a proxy) viewing a partner: each of the 17 listed figures is present and JSON null (production has a value for each)',
  (SELECT count(*) FILTER (WHERE (x.masked #> string_to_array(p, '.')) = 'null'::jsonb) || '/'
          || count(*) FILTER (WHERE (x.fullv #> string_to_array(p, '.')) IS NOT NULL AND (x.fullv #> string_to_array(p, '.')) <> 'null'::jsonb)
     FROM fx_v x, unnest(ARRAY['supporter_activity.portfolio_value', 'supporter_activity.total_roi_earned', 'supporter_activity.roi_paid_30d',
       'supporter_activity.roi_paid_180d', 'supporter_activity.roi_monthly_avg', 'cash_flow_capacity.roi_monthly', 'cash_flow_capacity.monthly_avg',
       'cash_flow_capacity.weekly_avg', 'cash_flow_capacity.daily_avg', 'network.portfolio_value', 'trust.score', 'trust.borrowing_limit_ugx',
       'trust.breakdown.supporter', 'trust.vouch_breakdown.total_ugx', 'trust.vouch_breakdown.portfolio_component_ugx',
       'trust.vouch_breakdown.boosters_ugx', 'trust.vouch_breakdown.booster_breakdown.payment_history']) p
    WHERE x.viewer = 'fxag' AND x.subject = 'tp1'), '17/17');
SELECT public.t_check('S7 the masked answer = production''s with exactly the 17 listed figures nulled, nothing else changed (same key set)',
  (SELECT count(*) FILTER (WHERE a.val IS DISTINCT FROM b.val) || '/' || count(*) FILTER (WHERE b.val = 'null'::jsonb AND a.val <> 'null'::jsonb)
          || '/' || count(*) FILTER (WHERE b.path IS NULL)
     FROM fx_v x CROSS JOIN LATERAL public.fx_leaves(x.fullv) a LEFT JOIN LATERAL public.fx_leaves(x.masked) b ON b.path = a.path
    WHERE x.viewer = 'fxag' AND x.subject = 'tp1'), '17/17/0');
SELECT public.t_check('S7 a subject without Returns (tenant) viewed by an agent: exactly production''s answer (cash-flow capacity, vouch limit visible)',
  (SELECT (masked = fullv) || '/' || (masked #>> '{trust,borrowing_limit_ugx}' IS NOT NULL) || '/' || (masked #>> '{cash_flow_capacity,monthly_avg}')
     FROM fx_v WHERE viewer = 'fxag' AND subject = 'tt'), 'true/true/30000');
SELECT public.t_check('S7 the partner, partner staff and an approved proxy see production''s answer; a proxy of someone else does not',
  (SELECT string_agg(viewer || '>' || subject || '=' || (masked = fullv), ' ' ORDER BY viewer, subject) FROM fx_v
    WHERE (viewer, subject) IN (('tp1', 'tp1'), ('fxpops', 'tp1'), ('fxpx', 'tp1'), ('fxpx', 'tp2'))),
  'fxpops>tp1=true fxpx>tp1=true fxpx>tp2=false tp1>tp1=true');
-- ---------------------------------------------------------------------------
-- S7 from the PostgREST login role (session_user authenticator, as in production): anon and a signed-in agent
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fx_masked_null(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT count(*) FILTER (WHERE (j #> string_to_array(p, '.')) = 'null'::jsonb) || '/' || count(*)
    FROM unnest(ARRAY['supporter_activity.portfolio_value', 'supporter_activity.total_roi_earned', 'supporter_activity.roi_paid_30d',
       'supporter_activity.roi_paid_180d', 'supporter_activity.roi_monthly_avg', 'cash_flow_capacity.roi_monthly', 'cash_flow_capacity.monthly_avg',
       'cash_flow_capacity.weekly_avg', 'cash_flow_capacity.daily_avg', 'network.portfolio_value', 'trust.score', 'trust.borrowing_limit_ugx',
       'trust.breakdown.supporter', 'trust.vouch_breakdown.total_ugx', 'trust.vouch_breakdown.portfolio_component_ugx',
       'trust.vouch_breakdown.boosters_ugx', 'trust.vouch_breakdown.booster_breakdown.payment_history']) p
   WHERE j #> string_to_array(p, '.') IS NOT NULL $$;
-- leaves of two answers that differ, identity leaves left out
CREATE FUNCTION public.fx_leaf_diff(a jsonb, b jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(string_agg(x.path, ',' ORDER BY x.path), 'none')
    FROM public.fx_leaves(a) x FULL JOIN public.fx_leaves(b) y ON y.path = x.path
   WHERE x.val IS DISTINCT FROM y.val AND COALESCE(x.path, y.path) NOT IN ('ai_id', 'user_id', 'identity.full_name', 'full_name', 'generated_at') $$;
SELECT public.t_as(NULL) IS NULL AS x \gset
\c - authenticator
SET client_min_messages = warning;
SET ROLE anon;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.get_public_trust_profile(public.fx_ai('tp1'))::text AS pub1, public.get_public_trust_profile(public.fx_ai('tp2'))::text AS pub2,
       public._t_prod_raw_get_public_trust_profile(public.fx_ai('tp1'))::text AS raw1 \gset
SELECT public.t_check('S7 anon (authenticator login), public profile of a partner: every listed figure it carries is null (and it carries some), earning_returns true, still flagged a supporter',
  (split_part(public.fx_masked_null(:'pub1'::jsonb), '/', 1) = split_part(public.fx_masked_null(:'pub1'::jsonb), '/', 2)
   AND split_part(public.fx_masked_null(:'pub1'::jsonb), '/', 2)::int > 0)::text || ' / '
  || (:'pub1'::jsonb #>> '{supporter_activity,earning_returns}') || ' / ' || (:'pub1'::jsonb #>> '{supporter_activity,active_portfolios}'),
  'true / true / 1');
SELECT 'INFO  S7 anon public profile of a partner: listed figures null/carried = ' || public.fx_masked_null(:'pub1'::jsonb);
SELECT public.t_check('S7 anon: two partners with different principal and Returns get the same public figures (nothing to derive monthly Returns or principal from)',
  public.fx_leaf_diff(:'pub1'::jsonb, :'pub2'::jsonb), 'none');
SELECT public.t_check('S7 anon: the public profile is production''s public text over the masked user answer, plus earning_returns (no other change)',
  ((:'pub1'::jsonb #- '{supporter_activity,earning_returns}') = (:'raw1'::jsonb #- '{supporter_activity,earning_returns}'))::text, 'true');
SELECT public.t_check('S7 anon: a tenant''s public profile (no Returns) = production''s, plus earning_returns false',
  (SELECT ((n #- '{supporter_activity,earning_returns}') = p)::text || '/' || (n #>> '{supporter_activity,earning_returns}')
     FROM (SELECT public.get_public_trust_profile(public.fx_ai('tt')) n, public._t_prod_get_public_trust_profile(public.fx_ai('tt')) p) s), 'true/false');
SELECT public.t_check('S7 anon cannot call get_user_trust_profile (42501)',
  split_part(public.t_err($s$SELECT public.get_user_trust_profile('WEL-000000')$s$), ':', 1), '42501');
RESET ROLE;
SET ROLE authenticated;
SELECT public.t_as('fxag') IS NULL AS x \gset
SELECT public.get_user_trust_profile(public.fx_ai('tp1'))::text AS ag1, public.get_user_trust_profile(public.fx_ai('tp2'))::text AS ag2,
       public.get_public_trust_profile(public.fx_ai('tp1'))::text AS agp1, public.get_public_trust_profile(public.fx_ai('tp2'))::text AS agp2 \gset
SELECT public.t_check('S7 a signed-in agent who is not the partner''s proxy (authenticator login): all 17 figures null in get_user_trust_profile; no leaf differs between two partners (user and public profile)',
  public.fx_masked_null(:'ag1'::jsonb) || ' / ' || public.fx_leaf_diff(:'ag1'::jsonb, :'ag2'::jsonb) || ' / ' || public.fx_leaf_diff(:'agp1'::jsonb, :'agp2'::jsonb),
  '17/17 / none / none');
SELECT public.t_as(NULL) IS NULL AS x \gset
RESET ROLE;
\c - postgres
SET client_min_messages = warning;

SELECT 'SUMMARY ' || count(*) FILTER (WHERE ok) || '/' || count(*) || ' passed'
       || COALESCE(' -- FAILED: ' || string_agg(name, '; ' ORDER BY n) FILTER (WHERE NOT ok), '')
  FROM public._t_results;
