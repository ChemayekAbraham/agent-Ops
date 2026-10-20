-- A per-agent, per-day exemption from the posting gate.
--
-- The daily eligibility gate (enforce_agent_daily_eligibility) had exactly one
-- escape: the session GUC app.bypass_daily_eligibility. That is per-session, so
-- it cannot be set for an agent's own browser, which left no sanctioned way to
-- let one agent post on one day. The alternatives in use elsewhere would each
-- have been worse: writing a fake 'Good' row into agent_daily_eligibility_history
-- to trigger the weekly unlock would corrupt the performance record the unlock
-- reads, and lowering the threshold would move it for all 109 agents.
--
-- So: a narrow, auditable grant. One agent, one day, with a reason and a named
-- granter, visible to anyone who later asks why a blocked agent posted. It is
-- not a bypass of the rule, it is a record that somebody overrode it.
CREATE TABLE IF NOT EXISTS public.agent_posting_gate_exemptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day         date NOT NULL,
  reason      text NOT NULL CHECK (btrim(reason) <> ''),
  granted_by  uuid REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, day)
);

COMMENT ON TABLE public.agent_posting_gate_exemptions IS
  'One-day overrides of the daily posting gate. A row here lets that agent post new Rent Plans on that day regardless of coverage. Granting is a staff action and is recorded, never silent.';

CREATE INDEX IF NOT EXISTS idx_agent_posting_gate_exemptions_agent_day
  ON public.agent_posting_gate_exemptions (agent_id, day);

-- No client writes. Staff read it; the trigger reads it as definer.
ALTER TABLE public.agent_posting_gate_exemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_posting_gate_exemptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.agent_posting_gate_exemptions TO authenticated;
GRANT ALL    ON public.agent_posting_gate_exemptions TO service_role;

DROP POLICY IF EXISTS agent_posting_gate_exemptions_staff_read ON public.agent_posting_gate_exemptions;
CREATE POLICY agent_posting_gate_exemptions_staff_read
  ON public.agent_posting_gate_exemptions
  FOR SELECT TO authenticated
  USING (public.can_view_staff_reports(auth.uid()) OR agent_id = auth.uid());

-- Teach the gate about it. Inserted directly after the existing "nothing was
-- billed" guard so an exemption is checked before any coverage maths.
DO $mig$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_agent_daily_eligibility';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'enforce_agent_daily_eligibility not found';
  END IF;

  v_old := '  -- Guard 2: the weekly good-standing unlock the app already promises.';

  v_new := '  -- Guard 1b: an explicit, recorded one-day grant by staff.
  IF EXISTS (
    SELECT 1 FROM public.agent_posting_gate_exemptions x
    WHERE x.agent_id = NEW.agent_id
      AND x.day = v_today
  ) THEN
    RETURN NEW;
  END IF;

  -- Guard 2: the weekly good-standing unlock the app already promises.';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'enforce_agent_daily_eligibility: guard 2 anchor not found in the shape this migration expects';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;
