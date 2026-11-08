-- Phase 4 test load step (LOCAL THROWAWAY CLUSTER ONLY). Run by run_phase4_tests.sh after Phase 1 and Phase 2 (each
-- applied twice), before the first 4a apply.
--   * _t_p4_state: the assert's Phase 2 text (P10 compares the 4a rollback's assert with it) and the functions that
--     exist before 4a (L: the build creates exactly the ten names the manifest lists).
--   * P9 seed: notices queued before Phase 2 carry no rate (Phase 2 added the column without a backfill). 4a fills the
--     unsent ones once: the note's rate, or for a 'funded' booking notice the rate of the houses the person funded.
SET client_min_messages = warning;
CREATE TABLE public._t_p4_state (k text PRIMARY KEY, v text);
INSERT INTO public._t_p4_state VALUES
  ('assert_md5_phase2', md5(pg_get_functiondef('public.assert_partner_return_policy_intact()'::regprocedure))),
  ('assert_rows_phase2', (SELECT count(*)::text FROM public.assert_partner_return_policy_intact())),
  ('assert_names_phase2', (SELECT string_agg(check_name, ',' ORDER BY o) FROM public.assert_partner_return_policy_intact() WITH ORDINALITY a(check_name, ok, detail, o)));
CREATE TABLE public._t_fn_before_4a AS SELECT DISTINCT p.proname::text AS proname FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';

-- People and notes (switch off: every note is stamped legacy 15).
INSERT INTO auth.users (id, email) SELECT public.pid(x), x || '@p9.test' FROM unnest(ARRAY['p9a', 'p9b', 'p9c']) x;
INSERT INTO public.profiles (id, full_name, email) SELECT public.pid(x), 'P9 ' || x, x || '@p9.test' FROM unnest(ARRAY['p9a', 'p9b', 'p9c']) x;
INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, email, amount, status, fulfilment_due_on)
SELECT public.pid('agent1'), CASE WHEN v.p IS NULL THEN NULL ELSE public.pid(v.p) END, v.nm, v.ph, v.nm || '@note.test', 400000, 'activated',
       current_date + 10
  FROM (VALUES ('P9 reserved', NULL, '0779900001'), ('P9 funded one rate', 'p9a', '0779900002'),
               ('P9 funded mixed', 'p9b', '0779900003'), ('P9 sent', NULL, '0779900004'),
               ('P9 half sent', NULL, '0779900005'), ('P9 pledge pending', NULL, '0779900006'),
               ('P9 pledge sent', NULL, '0779900007'), ('P9 pledge half', NULL, '0779900008')) v(nm, p, ph);
-- Houses the people funded through their notes: p9a both at 12; p9b at 12 and 14.
INSERT INTO public.promissory_note_house_intents (note_id, house_id, agent_id, monthly_rent, status)
SELECT n.id, public.pid(v.h), public.pid('agent1'), 200000, 'funded'
  FROM (VALUES ('P9 funded one rate', 'p9h1'), ('P9 funded one rate', 'p9h2'), ('P9 funded mixed', 'p9h3'), ('P9 funded mixed', 'p9h4')) v(nm, h)
  JOIN public.promissory_notes n ON n.partner_name = v.nm;
INSERT INTO public.partner_supported_houses (partner_id, house_id, principal, monthly_rate, status)
VALUES (public.pid('p9a'), public.pid('p9h1'), 200000, 12, 'active'), (public.pid('p9a'), public.pid('p9h2'), 200000, 12, 'active'),
       (public.pid('p9b'), public.pid('p9h3'), 200000, 12, 'active'), (public.pid('p9b'), public.pid('p9h4'), 200000, 14, 'active');
-- A cancelled house row at another rate does not count.
INSERT INTO public.partner_supported_houses (partner_id, house_id, principal, monthly_rate, status, cancelled_at)
VALUES (public.pid('p9a'), public.pid('p9h1'), 200000, 17, 'cancelled', now() - interval '3 days');
INSERT INTO public.promissory_house_booking_notices (note_id, partner_user_id, kind, partner_name, house_count, total_rent, sms_sent_at, email_sent_at)
SELECT n.id, n.partner_user_id, v.kind, n.partner_name, 2, 400000, v.sms, v.mail
  FROM (VALUES ('P9 reserved', 'reserved', NULL::timestamptz, NULL::timestamptz),
               ('P9 funded one rate', 'funded', NULL, NULL),
               ('P9 funded mixed', 'funded', NULL, NULL),
               ('P9 sent', 'reserved', now() - interval '2 days', now() - interval '2 days'),
               ('P9 half sent', 'released', now() - interval '1 day', NULL)) v(nm, kind, sms, mail)
  JOIN public.promissory_notes n ON n.partner_name = v.nm;
INSERT INTO public.promissory_note_pledge_notices (note_id, partner_name, amount, sms_status, email_status)
SELECT n.id, n.partner_name, n.amount, v.s, v.e
  FROM (VALUES ('P9 pledge pending', 'pending', 'pending'), ('P9 pledge sent', 'sent', 'sent'), ('P9 pledge half', 'sent', 'pending')) v(nm, s, e)
  JOIN public.promissory_notes n ON n.partner_name = v.nm;
-- Funder house-progress notices: from the supported house's rate, else the commitment's.
INSERT INTO public.partner_supported_houses (id, partner_id, house_id, principal, monthly_rate, status)
VALUES (public.pid('p9psh'), public.pid('p9c'), public.pid('p9h5'), 300000, 13, 'active');
INSERT INTO public.partner_self_commitments (id, partner_id, committed_amount, monthly_rate)
VALUES (public.pid('p9com'), public.pid('p9c'), 500000, 11);
INSERT INTO public.funder_house_progress_notices (dedupe_key, kind, partner_id, supported_house_id, commitment_id, partner_name, sms_sent_at, email_sent_at)
VALUES ('p9-house', 'placed', public.pid('p9c'), public.pid('p9psh'), NULL, 'P9 progress house', NULL, NULL),
       ('p9-commitment', 'placed', public.pid('p9c'), NULL, public.pid('p9com'), 'P9 progress commitment', NULL, NULL),
       ('p9-sent', 'placed', public.pid('p9c'), public.pid('p9psh'), NULL, 'P9 progress sent', now(), now()),
       ('p9-nothing', 'placed', public.pid('p9c'), NULL, NULL, 'P9 progress nothing', NULL, NULL);
SELECT 'before 4a ready';
