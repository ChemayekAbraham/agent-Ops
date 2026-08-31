-- ============ ENUMS ============
CREATE TYPE public.cc_subject_type AS ENUM ('tenant','landlord','agent');
CREATE TYPE public.cc_attempt_outcome AS ENUM ('engaged','no_answer','phone_off','wrong_number','refused','callback_booked');
CREATE TYPE public.cc_row_state AS ENUM ('to_call','engaged','unreachable','callback','parked','closed');

-- ============ cc_feedback_categories ============
CREATE TABLE public.cc_feedback_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  applies_to public.cc_subject_type[] NOT NULL,
  default_owner_role public.app_role NULL,
  locked boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.cc_feedback_categories TO authenticated;
GRANT ALL ON public.cc_feedback_categories TO service_role;
ALTER TABLE public.cc_feedback_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cc_categories_read_authenticated" ON public.cc_feedback_categories
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "cc_categories_write_super_admin" ON public.cc_feedback_categories
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'super_admin'))
  WITH CHECK (public.has_role(auth.uid(),'super_admin'));

INSERT INTO public.cc_feedback_categories (code,label,applies_to,default_owner_role,locked) VALUES
  ('agent_misconduct','Agent misconduct or bribery','{tenant,landlord}'::public.cc_subject_type[],'hr'::public.app_role,true),
  ('unit_condition','Unit condition or repair','{tenant}'::public.cc_subject_type[],'tenant_ops'::public.app_role,false),
  ('payment_dispute','Payment or statement dispute','{tenant,landlord}'::public.cc_subject_type[],'financial_ops'::public.app_role,false),
  ('app_fault','App or technical fault','{tenant,landlord,agent}'::public.cc_subject_type[],'cto'::public.app_role,false),
  ('service_complaint','Service complaint about Welile','{tenant,landlord,agent}'::public.cc_subject_type[],'operations'::public.app_role,false),
  ('product_interest','Product interest or lead','{tenant,landlord}'::public.cc_subject_type[],'crm'::public.app_role,false),
  ('data_correction','Wrong or dead contact details','{tenant,landlord,agent}'::public.cc_subject_type[],'operations'::public.app_role,false),
  ('no_issue','No issue raised','{tenant,landlord,agent}'::public.cc_subject_type[],NULL,false);

-- ============ cc_call_cycles ============
CREATE TABLE public.cc_call_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type public.cc_subject_type NOT NULL,
  cycle_no integer NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by uuid NOT NULL REFERENCES auth.users(id),
  closed_at timestamptz NULL,
  retry_after_days integer NOT NULL DEFAULT 3,
  attempt_cap integer NOT NULL DEFAULT 2,
  UNIQUE (subject_type, cycle_no),
  CONSTRAINT cc_call_cycles_positive_ck CHECK (retry_after_days > 0 AND attempt_cap > 0)
);
CREATE UNIQUE INDEX cc_call_cycles_one_open_per_subject
  ON public.cc_call_cycles (subject_type) WHERE closed_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON public.cc_call_cycles TO authenticated;
GRANT ALL ON public.cc_call_cycles TO service_role;
ALTER TABLE public.cc_call_cycles ENABLE ROW LEVEL SECURITY;

-- ============ cc_cycle_rows ============
CREATE TABLE public.cc_cycle_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES public.cc_call_cycles(id) ON DELETE CASCADE,
  subject_type public.cc_subject_type NOT NULL,
  subject_id uuid NOT NULL,
  state public.cc_row_state NOT NULL DEFAULT 'to_call',
  attempts_made integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NULL,
  next_retry_at timestamptz NULL,
  callback_due_at timestamptz NULL,
  parked_at timestamptz NULL,
  park_reason text NULL,
  closed_at timestamptz NULL,
  priority_value numeric NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, subject_type, subject_id)
);
CREATE INDEX cc_cycle_rows_cycle_state_idx ON public.cc_cycle_rows (cycle_id, state);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cc_cycle_rows TO authenticated;
GRANT ALL ON public.cc_cycle_rows TO service_role;
ALTER TABLE public.cc_cycle_rows ENABLE ROW LEVEL SECURITY;

-- ============ cc_call_attempts ============
CREATE TABLE public.cc_call_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_row_id uuid NOT NULL REFERENCES public.cc_cycle_rows(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  caller_id uuid NOT NULL REFERENCES auth.users(id),
  revealed_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NULL,
  outcome public.cc_attempt_outcome NULL,
  channel public.hr_reporter_channel NULL,
  source text NOT NULL DEFAULT 'self_reported',
  telephony_ref text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_row_id, attempt_no),
  CONSTRAINT cc_call_attempts_outcome_ck CHECK (recorded_at IS NULL OR outcome IS NOT NULL),
  CONSTRAINT cc_call_attempts_channel_ck CHECK ((recorded_at IS NULL) = (channel IS NULL))
);
CREATE INDEX cc_call_attempts_caller_recorded_idx ON public.cc_call_attempts (caller_id, recorded_at);
GRANT SELECT, INSERT, UPDATE ON public.cc_call_attempts TO authenticated;
GRANT ALL ON public.cc_call_attempts TO service_role;
ALTER TABLE public.cc_call_attempts ENABLE ROW LEVEL SECURITY;

-- ============ cc_feedback ============
CREATE TABLE public.cc_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES public.cc_call_attempts(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.cc_feedback_categories(id),
  severity public.hr_ticket_severity NOT NULL DEFAULT 'normal',
  note text NOT NULL,
  routed_to_expected uuid NULL REFERENCES auth.users(id),
  routed_to_actual uuid NULL REFERENCES auth.users(id),
  ticket_id uuid NULL REFERENCES public.hr_tickets(id),
  consent_to_contact boolean NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.cc_feedback TO authenticated;
GRANT ALL ON public.cc_feedback TO service_role;
ALTER TABLE public.cc_feedback ENABLE ROW LEVEL SECURITY;

-- ============ helper: subject scope ============
CREATE OR REPLACE FUNCTION public.cc_can_read_subject(p_subject public.cc_subject_type)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(),'hr')
      OR public.has_role(auth.uid(),'ceo')
      OR public.has_role(auth.uid(),'coo')
      OR public.has_role(auth.uid(),'operations')
      OR public.has_role(auth.uid(),'super_admin')
      OR (p_subject = 'tenant'   AND public.has_role(auth.uid(),'tenant_ops'))
      OR (p_subject = 'landlord' AND public.has_role(auth.uid(),'landlord_ops'))
      OR (p_subject = 'agent'    AND public.has_role(auth.uid(),'agent_ops'));
$$;

CREATE OR REPLACE FUNCTION public.cc_can_write_subject(p_subject public.cc_subject_type)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(),'super_admin')
      OR (p_subject = 'tenant'   AND public.has_role(auth.uid(),'tenant_ops'))
      OR (p_subject = 'landlord' AND public.has_role(auth.uid(),'landlord_ops'))
      OR (p_subject = 'agent'    AND public.has_role(auth.uid(),'agent_ops'));
$$;

-- ============ RLS policies ============
CREATE POLICY "cc_cycles_read" ON public.cc_call_cycles
  FOR SELECT TO authenticated USING (public.cc_can_read_subject(subject_type));
CREATE POLICY "cc_cycles_insert" ON public.cc_call_cycles
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(),'operations') OR public.has_role(auth.uid(),'hr') OR public.has_role(auth.uid(),'super_admin'));
CREATE POLICY "cc_cycles_update" ON public.cc_call_cycles
  FOR UPDATE TO authenticated USING (
    public.has_role(auth.uid(),'operations') OR public.has_role(auth.uid(),'hr') OR public.has_role(auth.uid(),'super_admin'))
  WITH CHECK (
    public.has_role(auth.uid(),'operations') OR public.has_role(auth.uid(),'hr') OR public.has_role(auth.uid(),'super_admin'));

CREATE POLICY "cc_rows_read" ON public.cc_cycle_rows
  FOR SELECT TO authenticated USING (public.cc_can_read_subject(subject_type));
CREATE POLICY "cc_rows_write" ON public.cc_cycle_rows
  FOR ALL TO authenticated
  USING (public.cc_can_write_subject(subject_type))
  WITH CHECK (public.cc_can_write_subject(subject_type));

CREATE POLICY "cc_attempts_read" ON public.cc_call_attempts
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.cc_cycle_rows r WHERE r.id = cycle_row_id AND public.cc_can_read_subject(r.subject_type)));
CREATE POLICY "cc_attempts_write" ON public.cc_call_attempts
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cc_cycle_rows r WHERE r.id = cycle_row_id AND public.cc_can_write_subject(r.subject_type)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.cc_cycle_rows r WHERE r.id = cycle_row_id AND public.cc_can_write_subject(r.subject_type)));

CREATE POLICY "cc_feedback_read" ON public.cc_feedback
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.cc_call_attempts a JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
            WHERE a.id = attempt_id AND public.cc_can_read_subject(r.subject_type)));
CREATE POLICY "cc_feedback_write" ON public.cc_feedback
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cc_call_attempts a JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
            WHERE a.id = attempt_id AND public.cc_can_write_subject(r.subject_type)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.cc_call_attempts a JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
            WHERE a.id = attempt_id AND public.cc_can_write_subject(r.subject_type)));

-- ============ TRIGGERS ============
-- (a)(b)(c-part1) BEFORE INSERT on attempts
CREATE OR REPLACE FUNCTION public.cc_attempt_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open integer;
  v_attempts integer;
  v_cap integer;
BEGIN
  SELECT count(*) INTO v_open
  FROM public.cc_call_attempts
  WHERE caller_id = NEW.caller_id AND recorded_at IS NULL;

  IF v_open >= 3 THEN
    RAISE EXCEPTION 'Record the outcome of your open calls before revealing another number.';
  END IF;

  SELECT r.attempts_made, c.attempt_cap
    INTO v_attempts, v_cap
  FROM public.cc_cycle_rows r
  JOIN public.cc_call_cycles c ON c.id = r.cycle_id
  WHERE r.id = NEW.cycle_row_id
  FOR UPDATE OF r;

  IF v_attempts IS NULL THEN
    RAISE EXCEPTION 'Roster row % not found.', NEW.cycle_row_id;
  END IF;

  NEW.attempt_no := v_attempts + 1;

  IF NEW.attempt_no > v_cap THEN
    RAISE EXCEPTION 'Attempt cap of % reached for this roster row.', v_cap;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cc_attempt_before_insert
  BEFORE INSERT ON public.cc_call_attempts
  FOR EACH ROW EXECUTE FUNCTION public.cc_attempt_before_insert();

-- (c-part2) AFTER INSERT: bump roster counters
CREATE OR REPLACE FUNCTION public.cc_attempt_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.cc_cycle_rows
     SET attempts_made = NEW.attempt_no,
         last_attempt_at = NEW.revealed_at
   WHERE id = NEW.cycle_row_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_cc_attempt_after_insert
  AFTER INSERT ON public.cc_call_attempts
  FOR EACH ROW EXECUTE FUNCTION public.cc_attempt_after_insert();

-- (d) AFTER UPDATE: outcome recorded -> advance roster state
CREATE OR REPLACE FUNCTION public.cc_attempt_after_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_retry integer;
  v_cap integer;
  v_attempts integer;
BEGIN
  IF OLD.recorded_at IS NOT NULL OR NEW.recorded_at IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.retry_after_days, c.attempt_cap, r.attempts_made
    INTO v_retry, v_cap, v_attempts
  FROM public.cc_cycle_rows r
  JOIN public.cc_call_cycles c ON c.id = r.cycle_id
  WHERE r.id = NEW.cycle_row_id;

  IF NEW.outcome = 'engaged' THEN
    UPDATE public.cc_cycle_rows SET state = 'engaged' WHERE id = NEW.cycle_row_id;
  ELSIF NEW.outcome = 'callback_booked' THEN
    UPDATE public.cc_cycle_rows SET state = 'callback' WHERE id = NEW.cycle_row_id;
  ELSE
    UPDATE public.cc_cycle_rows
       SET state = 'unreachable',
           next_retry_at = now() + (v_retry || ' days')::interval
     WHERE id = NEW.cycle_row_id;

    IF v_attempts >= v_cap THEN
      UPDATE public.cc_cycle_rows
         SET state = 'parked',
             parked_at = now(),
             park_reason = NEW.outcome::text
       WHERE id = NEW.cycle_row_id;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_cc_attempt_after_record
  AFTER UPDATE ON public.cc_call_attempts
  FOR EACH ROW EXECUTE FUNCTION public.cc_attempt_after_record();

-- (e) engaged requires feedback (deferred constraint trigger)
CREATE OR REPLACE FUNCTION public.cc_attempt_requires_feedback()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.outcome = 'engaged'
     AND NOT EXISTS (SELECT 1 FROM public.cc_feedback f WHERE f.attempt_id = NEW.id) THEN
    RAISE EXCEPTION 'An engaged call must carry a feedback record.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_cc_attempt_requires_feedback
  AFTER INSERT OR UPDATE ON public.cc_call_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.cc_attempt_requires_feedback();

-- (f) locked category routing
CREATE OR REPLACE FUNCTION public.cc_feedback_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_locked boolean;
BEGIN
  SELECT locked INTO v_locked
  FROM public.cc_feedback_categories WHERE id = NEW.category_id;

  IF v_locked IS NULL THEN
    RAISE EXCEPTION 'Unknown feedback category %.', NEW.category_id;
  END IF;

  IF v_locked THEN
    IF NEW.routed_to_actual IS NOT NULL THEN
      RAISE EXCEPTION 'This category is locked and cannot be routed to a chosen assignee.';
    END IF;
    NEW.routed_to_actual := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cc_feedback_before_insert
  BEFORE INSERT ON public.cc_feedback
  FOR EACH ROW EXECUTE FUNCTION public.cc_feedback_before_insert();

-- (g) close cycle
CREATE OR REPLACE FUNCTION public.cc_close_cycle(p_cycle_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_outstanding integer;
BEGIN
  IF NOT (public.has_role(auth.uid(),'operations')
       OR public.has_role(auth.uid(),'hr')
       OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised to close a calling cycle.';
  END IF;

  SELECT count(*) INTO v_outstanding
  FROM public.cc_cycle_rows
  WHERE cycle_id = p_cycle_id
    AND state NOT IN ('engaged','parked','closed');

  IF v_outstanding > 0 THEN
    RAISE EXCEPTION 'Cannot close cycle: % roster row(s) still outstanding.', v_outstanding;
  END IF;

  UPDATE public.cc_call_cycles
     SET closed_at = now()
   WHERE id = p_cycle_id AND closed_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.cc_close_cycle(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_close_cycle(uuid) TO authenticated;