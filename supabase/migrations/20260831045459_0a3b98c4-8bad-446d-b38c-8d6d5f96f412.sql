CREATE TABLE public.proxy_target_mode_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('accepted','declined')),
  decided_at timestamptz NOT NULL DEFAULT now(),
  monthly_note_target integer NOT NULL DEFAULT 1200,
  monthly_reward numeric NOT NULL DEFAULT 2000000,
  min_notes integer NOT NULL DEFAULT 200,
  min_reward numeric NOT NULL DEFAULT 300000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id)
);

GRANT SELECT, INSERT, UPDATE ON public.proxy_target_mode_enrollments TO authenticated;
GRANT ALL ON public.proxy_target_mode_enrollments TO service_role;

ALTER TABLE public.proxy_target_mode_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own target enrolment"
ON public.proxy_target_mode_enrollments FOR SELECT TO authenticated
USING (
  agent_id = auth.uid()
  OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'ceo')
  OR has_role(auth.uid(),'coo') OR has_role(auth.uid(),'cfo')
  OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'operations')
  OR has_role(auth.uid(),'partner_ops') OR has_role(auth.uid(),'agent_ops')
);

CREATE POLICY "Agents set own target enrolment"
ON public.proxy_target_mode_enrollments FOR INSERT TO authenticated
WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Agents update own target enrolment"
ON public.proxy_target_mode_enrollments FOR UPDATE TO authenticated
USING (agent_id = auth.uid()) WITH CHECK (agent_id = auth.uid());

CREATE TRIGGER trg_proxy_target_mode_updated_at
BEFORE UPDATE ON public.proxy_target_mode_enrollments
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.set_proxy_target_mode(p_accept boolean, p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent uuid := public.proxy_cc_resolve_agent(p_agent_id);
  v_status text := CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END;
BEGIN
  INSERT INTO public.proxy_target_mode_enrollments (agent_id, status, decided_at)
  VALUES (v_agent, v_status, now())
  ON CONFLICT (agent_id) DO UPDATE
    SET status = EXCLUDED.status, decided_at = now(), updated_at = now();

  RETURN jsonb_build_object('agent_id', v_agent, 'status', v_status);
END; $$;

CREATE OR REPLACE FUNCTION public.get_proxy_target_mode(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent uuid := public.proxy_cc_resolve_agent(p_agent_id);
  v_e public.proxy_target_mode_enrollments;
  v_target integer := 1200;
  v_reward numeric := 2000000;
  v_min_notes integer := 200;
  v_min_reward numeric := 300000;
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date;
  v_days integer;
  v_day integer;
  v_notes integer;
  v_daily numeric;
  v_expected numeric;
  v_missed numeric;
  v_earned numeric;
  v_rate numeric;
  v_available numeric;
BEGIN
  SELECT * INTO v_e FROM public.proxy_target_mode_enrollments WHERE agent_id = v_agent;
  IF v_e.agent_id IS NOT NULL THEN
    v_target := v_e.monthly_note_target;
    v_reward := v_e.monthly_reward;
    v_min_notes := v_e.min_notes;
    v_min_reward := v_e.min_reward;
  END IF;

  v_days := EXTRACT(DAY FROM (date_trunc('month', v_month_start) + interval '1 month - 1 day'))::int;
  v_day := EXTRACT(DAY FROM (now() AT TIME ZONE 'Africa/Kampala'))::int;

  SELECT count(*) INTO v_notes
  FROM public.promissory_notes
  WHERE agent_id = v_agent
    AND (created_at AT TIME ZONE 'Africa/Kampala')::date >= v_month_start;

  v_daily := ceil(v_target::numeric / GREATEST(v_days,1));
  v_expected := LEAST(v_daily * v_day, v_target);
  v_missed := GREATEST(v_expected - v_notes, 0);

  -- Payout curve: 0 -> 0, min tier -> min reward, full target -> full reward.
  v_rate := (v_reward - v_min_reward) / GREATEST(v_target - v_min_notes, 1);
  v_earned := CASE
    WHEN v_notes >= v_target THEN v_reward
    WHEN v_notes >= v_min_notes THEN v_min_reward + (v_notes - v_min_notes) * v_rate
    ELSE v_notes * (v_min_reward / GREATEST(v_min_notes,1))
  END;

  v_available := GREATEST(v_earned, LEAST(v_reward, v_reward - v_missed * v_rate));
  v_available := GREATEST(v_available, 0);

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'status', COALESCE(v_e.status, 'undecided'),
    'decided_at', v_e.decided_at,
    'monthly_note_target', v_target,
    'monthly_reward', v_reward,
    'min_notes', v_min_notes,
    'min_reward', v_min_reward,
    'rate_per_note', round(v_rate),
    'days_in_month', v_days,
    'day_of_month', v_day,
    'daily_target', v_daily,
    'notes_month', v_notes,
    'expected_to_date', v_expected,
    'missed_notes', v_missed,
    'earned_now', round(v_earned),
    'available_income', round(v_available),
    'tier_hit', (v_notes >= v_min_notes),
    'target_hit', (v_notes >= v_target),
    'on_track', (v_notes >= v_expected),
    'month_start', v_month_start
  );
END; $$;

REVOKE ALL ON FUNCTION public.set_proxy_target_mode(boolean, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_proxy_target_mode(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_proxy_target_mode(boolean, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_proxy_target_mode(uuid) TO authenticated;