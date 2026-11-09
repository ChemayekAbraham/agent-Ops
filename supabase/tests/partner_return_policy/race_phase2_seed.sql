-- Seed and helper functions for race_run_phase2.sh. LOCAL THROWAWAY CLUSTER ONLY (port 55432).
-- Prerequisite: race_stub.sql + race_stub_phase2.sql + both migrations (switch never turned on).
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;
\ir phase2_helpers.sql

-- ---------------------------------------------------------------------------
-- People and pre-cut-off notes (all written while the switch is off)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- R1: one person per round; a pre-cut-off note for their phone, not linked yet.
  FOR i IN 1..12 LOOP
    PERFORM public.t2_person('r1_' || i);
    INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
    VALUES (public.pid('agent1'), NULL, 'R1 ' || i, '0781' || lpad(i::text, 6, '0'), 1000000, 'pending', current_date + 5, current_date - 3);
  END LOOP;
  -- R2: one person per round with TWO pre-cut-off notes (different phones), linked by two statements.
  FOR i IN 1..12 LOOP
    PERFORM public.t2_person('r2_' || i);
    INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
    VALUES (public.pid('agent1'), NULL, 'R2a ' || i, '0782' || lpad(i::text, 6, '0'), 500000, 'pending', current_date + 5, current_date - 3),
           (public.pid('agent1'), NULL, 'R2b ' || i, '0783' || lpad(i::text, 6, '0'), 500000, 'pending', current_date + 5, current_date - 3);
  END LOOP;
  -- R3: existing partners (live 15 / 20 before the cut-off), plus fresh people; all with agreements.
  FOR i IN 1..40 LOOP
    PERFORM public.t2_person('r3_ex' || i);
    PERFORM public.t2_port('r3_ex' || i, CASE WHEN i % 2 = 0 THEN 20 ELSE 15 END);
    PERFORM public.t2_person('r3_new' || i);
  END LOOP;
  -- R5: one person per round with a pre-cut-off note (not linked yet); a portfolio is opened after the cut-off.
  FOR i IN 1..12 LOOP
    PERFORM public.t2_person('r5_' || i);
    INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
    VALUES (public.pid('agent1'), NULL, 'R5 ' || i, '0785' || lpad(i::text, 6, '0'), 1000000, 'pending', current_date + 5, current_date - 3);
  END LOOP;
  -- Round 3: R5 sequential controls (r5c_), R6 a plain rate edit vs the late link (r6_, controls r6c_),
  -- R7 the split/lock tool pattern vs the late link (r7_, controls r7c_). One pre-cut-off note each.
  FOR i IN 1..12 LOOP
    PERFORM public.t2_person(x.who) FROM (VALUES ('r5c_' || i), ('r6_' || i), ('r6c_' || i), ('r7_' || i), ('r7c_' || i)) x(who);
    INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
    SELECT public.pid('agent1'), NULL, upper(x.who), x.pre || lpad(i::text, 6, '0'), 1000000, 'pending', current_date + 5, current_date - 3
      FROM (VALUES ('r5c_' || i, '0786'), ('r6_' || i, '0787'), ('r6c_' || i, '0788'), ('r7_' || i, '0789'), ('r7c_' || i, '0776')) x(who, pre);
  END LOOP;
  FOR i IN 1..10 LOOP
    PERFORM public.t2_person('r3_emp' || i);
    INSERT INTO public.hr_staff (user_id, active) VALUES (public.pid('r3_emp' || i), true);
  END LOOP;
END $$;

-- Round 4 people (one pre-cut-off note each where the case links one):
--   R6b link first, then a plain edit (r8_, controls r8c_); R6c two plain edits (r13_); R8 the CFO batch vs a plain edit
--   (r9_, controls r9c_); R9 the late link's round 2 vs the split/lock tool (r10_); R10 the late link vs the CFO batch (r11_,
--   controls r11c_); R11 a request committing inside the late link's step 2 (r12_, controls r12c_).
DO $$
BEGIN
  FOR i IN 1..12 LOOP
    PERFORM public.t2_person(x.who) FROM (VALUES ('r8_' || i), ('r8c_' || i), ('r9_' || i), ('r9c_' || i), ('r10_' || i), ('r11_' || i),
                                                 ('r11c_' || i), ('r12_' || i), ('r12c_' || i), ('r13_' || i)) x(who);
    INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
    SELECT public.pid('agent1'), NULL, upper(x.who), x.pre || lpad(i::text, 6, '0'), 1000000, 'pending', current_date + 5, current_date - 3
      FROM (VALUES ('r8_' || i, '0761'), ('r8c_' || i, '0762'), ('r10_' || i, '0763'), ('r11_' || i, '0764'), ('r11c_' || i, '0765'),
                   ('r12_' || i, '0766'), ('r12c_' || i, '0767')) x(who, pre);
  END LOOP;
END $$;

-- Round 5 people: R6d a pending request held by another transaction while a plain edit runs (r14_); R6e the gate's second
-- miss (r15_); R11c the CFO approving a staff 18 inside the late link's step-2 gap (round-4 S8c; r16_, controls r16c_).
DO $$
BEGIN
  FOR i IN 1..12 LOOP
    PERFORM public.t2_person(x.who) FROM (VALUES ('r14_' || i), ('r15_' || i), ('r16_' || i), ('r16c_' || i)) x(who);
    INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
    SELECT public.pid('agent1'), NULL, upper(x.who), x.pre || lpad(i::text, 6, '0'), 1000000, 'pending', current_date + 5, current_date - 3
      FROM (VALUES ('r16_' || i, '0768'), ('r16c_' || i, '0769')) x(who, pre);
  END LOOP;
END $$;

-- Round 6 people: R11d a lower staff request committed AND approved by the CFO between the late link's step-2 supersede and
-- its insert (round-5 S8d; r17_, controls r17c_); R12 (r17_9) the auto_explain run.
DO $$
BEGIN
  FOR i IN 1..12 LOOP
    PERFORM public.t2_person(x.who) FROM (VALUES ('r17_' || i), ('r17c_' || i)) x(who);
    INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
    SELECT public.pid('agent1'), NULL, upper(x.who), x.pre || lpad(i::text, 6, '0'), 1000000, 'pending', current_date + 5, current_date - 3
      FROM (VALUES ('r17_' || i, '0770'), ('r17c_' || i, '0771')) x(who, pre);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Check helpers
-- ---------------------------------------------------------------------------
-- Portfolios of p_person opened after the cut-off inside a linked pre-cut-off note's window, below
-- the note's rate, with no open CFO request at or above it: a catch-up that was missed. Same status rule as the
-- trigger (live, or waiting to be opened): a redeemed portfolio is never caught up (round 3: R7 has one).
CREATE OR REPLACE FUNCTION public.r_missed(p_person text) RETURNS integer LANGUAGE sql VOLATILE AS $$
  SELECT count(DISTINCT ip.id)::int
    FROM public.investor_portfolios ip
    JOIN public.promissory_notes n ON n.partner_user_id = ip.investor_id
    JOIN public.partner_return_note_windows w ON w.note_id = n.id
    CROSS JOIN public.partner_return_policy p
   WHERE ip.investor_id = public.pid(p_person) AND p.id
     AND (ip.status = ANY (public.partner_live_portfolio_statuses()) OR ip.status IN ('pending_ops_approval', 'awaiting_partner_details'))
     AND ip.rate_decided_at >= p.cutoff_at
     AND (ip.rate_decided_at AT TIME ZONE 'Africa/Kampala')::date <= w.ends_on
     AND public.partner_note_window_applies(w.partner_user_id, w.agent_id, n.agent_id, ip.investor_id)   -- who the window is for (round 6: 4 arguments)
     AND ip.roi_percentage < w.return_rate
     AND NOT EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = ip.id
                        AND (a.status = 'pending' OR (a.status = 'approved' AND a.applied_at IS NULL))
                        AND a.requested_rate >= w.return_rate) $$;
-- Every CFO request ever opened for a portfolio (source@rate:status), in a fixed order that does not depend on timing.
CREATE OR REPLACE FUNCTION public.r_hist(p_id uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(string_agg(a.source || '@' || trim_scale(a.requested_rate) || ':' || a.status, ',' ORDER BY a.source, a.requested_rate, a.status), '-')
    FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = p_id $$;
-- Same, for every portfolio of a person (in decision order).
CREATE OR REPLACE FUNCTION public.r_hist_person(p_person text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(string_agg(public.r_hist(ip.id), ' ; ' ORDER BY ip.rate_decided_at), '-')
    FROM public.investor_portfolios ip WHERE ip.investor_id = public.pid(p_person) $$;
CREATE OR REPLACE FUNCTION public.r_desc_person(p_person text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(string_agg(public.t_desc(ip.id), ',' ORDER BY ip.rate_decided_at), '-')
    FROM public.investor_portfolios ip WHERE ip.investor_id = public.pid(p_person) $$;
-- Creation-path portfolios decided since p_since whose commitment, open lines or houses carry a
-- different rate from the portfolio.
CREATE OR REPLACE FUNCTION public.r_children_mismatch(p_since timestamptz) RETURNS integer LANGUAGE sql VOLATILE AS $$
  SELECT count(*)::int FROM public.investor_portfolios ip
   WHERE ip.rate_decided_at >= p_since
     AND (EXISTS (SELECT 1 FROM public.funder_pending_portfolios f JOIN public.partner_self_commitments c ON c.id = f.commitment_id
                   WHERE f.portfolio_id = ip.id AND c.monthly_rate IS DISTINCT FROM ip.roi_percentage)
       OR EXISTS (SELECT 1 FROM public.funder_pending_portfolios f JOIN public.partner_self_funding_lines l ON l.commitment_id = f.commitment_id
                   WHERE f.portfolio_id = ip.id AND l.monthly_rate IS DISTINCT FROM ip.roi_percentage)
       OR EXISTS (SELECT 1 FROM public.partner_supported_houses h
                   WHERE h.portfolio_id = ip.id AND h.monthly_rate IS DISTINCT FROM ip.roi_percentage)) $$;
-- Back to "never switched on", release marked ready (guards disabled only for the reset itself). Data is kept.
CREATE OR REPLACE FUNCTION public.r_reset_never_on() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  ALTER TABLE public.partner_return_policy DISABLE TRIGGER trg_partner_return_policy_guard;
  UPDATE public.partner_return_policy SET enabled = false, cutoff_at = NULL, enabled_at = NULL, release_ready = true;
  ALTER TABLE public.partner_return_policy ENABLE TRIGGER trg_partner_return_policy_guard;
  ALTER TABLE public.partner_return_cohort DISABLE TRIGGER USER;
  TRUNCATE public.partner_return_cohort;
  ALTER TABLE public.partner_return_cohort ENABLE TRIGGER USER;
  ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER USER;
  TRUNCATE public.partner_return_note_windows;
  ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER USER;
  ALTER TABLE public.partner_return_legacy_portfolios DISABLE TRIGGER USER;
  TRUNCATE public.partner_return_legacy_portfolios;
  ALTER TABLE public.partner_return_legacy_portfolios ENABLE TRIGGER USER;
END $$;

-- Slows each house reservation down when the session asks (t.slow = on), to force interleaving.
CREATE OR REPLACE FUNCTION public._r_slow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('t.slow', true) = 'on' THEN PERFORM pg_sleep(0.3); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS _r_slow ON public.promissory_note_house_intents;
CREATE TRIGGER _r_slow AFTER INSERT ON public.promissory_note_house_intents FOR EACH ROW EXECUTE FUNCTION public._r_slow();
-- Widens the gap between a creation path asking the rule (partner_rate_now) and inserting the
-- portfolio (t.slow_commit = on), so a concurrent switch-on can land inside it.
CREATE OR REPLACE FUNCTION public._r_slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('t.slow_commit', true) = 'on' THEN PERFORM pg_sleep(0.15); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS _r_slow_commit ON public.partner_self_commitments;
CREATE TRIGGER _r_slow_commit AFTER INSERT ON public.partner_self_commitments FOR EACH ROW EXECUTE FUNCTION public._r_slow_commit();
-- Round 4 instrumentation (test only; every sleep is 0 unless the session sets it):
--   _r_apsleep: each UPDATE of a CFO request row sleeps t.apsleep seconds (holds what it locked; the round-3 S4 set-up).
CREATE OR REPLACE FUNCTION public._r_apsleep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('t.apsleep', true), '') <> '' THEN PERFORM pg_sleep(current_setting('t.apsleep')::float8); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS _r_apsleep ON public.portfolio_rate_approvals;
CREATE TRIGGER _r_apsleep BEFORE UPDATE ON public.portfolio_rate_approvals FOR EACH ROW EXECUTE FUNCTION public._r_apsleep();
--   r_late_link_instrument(true): an instrumented copy of the shipped partner_note_linked_late() with two sleeps:
--     t.r2gap after round 1 took the rate lock, before round 2's look-up (the round-3 S3 / exp_round2_window x1 window);
--     t.gap   in step 2 between the to-do look-up and the lock + supersede of lower requests (the round-3 S8 window);
--     t.gap3  (round 6) in step 2's FIRST pass, between the supersede and the insert (the round-5 S8d window).
--   r_late_link_instrument(false): puts the shipped text back and checks it is byte-identical (md5).
CREATE TABLE IF NOT EXISTS public._r_saved_late (def text NOT NULL, md5 text NOT NULL);
CREATE OR REPLACE FUNCTION public.r_late_link_instrument(p_on boolean) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v text;
  -- Phase 6 F2: round 1 takes the rate lock only for people with an open pre-cut-off note window (none: no lock and no
  -- round 2); the sleep sits right after that lock, before round 2's look-up (the same window as before).
  a text := E'    PERFORM public.partner_rate_lock(v_lock);\n  END LOOP;';
  b text := E'    PERFORM public.partner_rate_lock(v_lock);\n    PERFORM pg_sleep(COALESCE(NULLIF(current_setting(''t.r2gap'', true), ''''), ''0'')::float8);\n  END LOOP;';
  c text := E'      -- Lower open requests are locked in id order first';
  d text := E'      PERFORM pg_sleep(COALESCE(NULLIF(current_setting(''t.gap'', true), ''''), ''0'')::float8);\n      -- Lower open requests are locked in id order first';
  e text := E'      WITH ins AS (\n';
  f text := E'      IF v_round = 1 THEN PERFORM pg_sleep(COALESCE(NULLIF(current_setting(''t.gap3'', true), ''''), ''0'')::float8); END IF;\n      WITH ins AS (\n';
BEGIN
  IF p_on THEN
    IF NOT EXISTS (SELECT 1 FROM public._r_saved_late) THEN
      INSERT INTO public._r_saved_late SELECT d0, md5(d0) FROM pg_get_functiondef('public.partner_note_linked_late()'::regprocedure) d0;
    END IF;
    v := (SELECT s.def FROM public._r_saved_late s);
    IF position(c in v) = 0 THEN   -- the round-3 text (sensitivity runs against the pre-round-4 migration): before its supersede
      c := E'      UPDATE public.portfolio_rate_approvals a
         SET status = ''superseded''';
      d := E'      PERFORM pg_sleep(COALESCE(NULLIF(current_setting(''t.gap'', true), ''''), ''0'')::float8);
' || c;
    END IF;
    IF position(a in v) = 0 OR position(c in v) = 0 THEN RAISE EXCEPTION 'r_late_link_instrument: anchor not found'; END IF;
    -- t.gap3 only where the text has the step-2 insert as 'WITH ins AS (' (round 4 on), exactly once.
    IF (length(v) - length(replace(v, e, ''))) / length(e) = 1 THEN
      v := replace(v, e, f);
    END IF;
    EXECUTE replace(replace(v, a, b), c, d);
    RETURN 'instrumented';
  END IF;
  EXECUTE (SELECT s.def FROM public._r_saved_late s);
  IF md5(pg_get_functiondef('public.partner_note_linked_late()'::regprocedure)) IS DISTINCT FROM (SELECT s.md5 FROM public._r_saved_late s) THEN
    RAISE EXCEPTION 'r_late_link_instrument: restore failed';
  END IF;
  RETURN 'restored';
END $f$;
-- A CFO request written directly (fixed id, so the id order of a batch can be chosen).
CREATE OR REPLACE FUNCTION public.r_req(p_id uuid, p_portfolio uuid, p_rate numeric, p_status text DEFAULT 'pending') RETURNS void
 LANGUAGE sql AS $$
  INSERT INTO public.portfolio_rate_approvals (id, portfolio_id, requested_rate, rate_in_force, standard_rate, source, status, decided_at)
  VALUES (p_id, p_portfolio, p_rate, 10, 10, 'rate_change', p_status, CASE WHEN p_status <> 'pending' THEN now() END) $$;
-- The subjects of the late-link alerts sent since mail id p_since (count:distinct subjects) and the last text.
CREATE OR REPLACE FUNCTION public.r_late_mail(p_since bigint) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT count(*) || ':' || COALESCE(string_agg(DISTINCT payload ->> 'subject', ','), '-') || ' :: '
      || COALESCE((SELECT payload ->> 'text' FROM public._email_outbox WHERE id > p_since AND payload ->> 'subject' LIKE 'Promissory note linked late%'
                    ORDER BY id DESC LIMIT 1), '-')
    FROM public._email_outbox WHERE id > p_since AND payload ->> 'subject' LIKE 'Promissory note linked late%' $$;
-- Round 5 instrumentation (test only; nothing happens unless a session sets the setting):
--   _r_gate_try: counts the Phase 1 gate's inserts (its tries) for the portfolio named in t.count_try (a sequence: a failed
--   edit does not roll it back).
CREATE SEQUENCE IF NOT EXISTS public._r_gate_try;
CREATE OR REPLACE FUNCTION public._r_gate_try() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'rate_change' AND NEW.portfolio_id::text = current_setting('t.count_try', true) THEN
    PERFORM nextval('public._r_gate_try');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS _r_gate_try ON public.portfolio_rate_approvals;
CREATE TRIGGER _r_gate_try BEFORE INSERT ON public.portfolio_rate_approvals FOR EACH ROW EXECUTE FUNCTION public._r_gate_try();
CREATE OR REPLACE FUNCTION public.r_gate_tries() RETURNS bigint LANGUAGE sql VOLATILE AS
  $$ SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM public._r_gate_try $$;
--   r_gate_instrument(true): an instrumented copy of the shipped enforce_partner_return_rate_policy() with two test-only sleeps:
--     t.gate_gap  at the start of its SECOND try only (between the first try's ON CONFLICT DO NOTHING and the second try's
--                 lock), the only place where another transaction can change the request the first try ran into;
--     t.gate_gap1 in the FIRST try, between its supersede and its insert.
--   r_gate_instrument(false) puts the shipped text back and checks it is byte-identical (md5).
CREATE TABLE IF NOT EXISTS public._r_saved_gate (def text NOT NULL, md5 text NOT NULL);
CREATE OR REPLACE FUNCTION public.r_gate_instrument(p_on boolean) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v text;
  a text := E'    FOR v_try IN 1..2 LOOP\n';
  b text := E'    FOR v_try IN 1..2 LOOP\n      IF v_try = 2 THEN PERFORM pg_sleep(COALESCE(NULLIF(current_setting(''t.gate_gap'', true), ''''), ''0'')::float8); END IF;\n';
  c text := E'      INSERT INTO public.portfolio_rate_approvals\n        (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)\n      VALUES (NEW.id, NEW.roi_percentage, OLD.roi_percentage, OLD.roi_percentage, ''rate_change'', auth.uid())\n      ON CONFLICT';
  d text := E'      IF v_try = 1 THEN PERFORM pg_sleep(COALESCE(NULLIF(current_setting(''t.gate_gap1'', true), ''''), ''0'')::float8); END IF;\n';
BEGIN
  IF p_on THEN
    IF NOT EXISTS (SELECT 1 FROM public._r_saved_gate) THEN
      INSERT INTO public._r_saved_gate SELECT d0, md5(d0) FROM pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure) d0;
    END IF;
    v := (SELECT s.def FROM public._r_saved_gate s);
    IF position(a in v) = 0 OR position(c in v) = 0 THEN RAISE EXCEPTION 'r_gate_instrument: anchor not found'; END IF;
    EXECUTE replace(replace(v, a, b), c, d || c);
    RETURN 'instrumented';
  END IF;
  EXECUTE (SELECT s.def FROM public._r_saved_gate s);
  IF md5(pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure)) IS DISTINCT FROM (SELECT s.md5 FROM public._r_saved_gate s) THEN
    RAISE EXCEPTION 'r_gate_instrument: restore failed';
  END IF;
  RETURN 'restored';
END $f$;
-- A plain rate edit as one statement, reporting 'ok' or '<SQLSTATE> <constraint>: <message>' (the edit is rolled back on error).
CREATE OR REPLACE FUNCTION public.r_try_edit(p_id uuid, p_rate numeric) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_con text;
BEGIN
  UPDATE public.investor_portfolios SET roi_percentage = p_rate WHERE id = p_id;
  RETURN 'ok';
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
  RETURN SQLSTATE || COALESCE(' ' || NULLIF(v_con, ''), '') || ': ' || SQLERRM;
END $$;
SELECT 'seeded';
