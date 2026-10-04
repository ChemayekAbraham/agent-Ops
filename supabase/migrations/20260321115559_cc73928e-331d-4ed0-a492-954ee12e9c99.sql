-- Agent collection streaks tracking
CREATE TABLE IF NOT EXISTS public.agent_collection_streaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  current_streak integer DEFAULT 0,
  longest_streak integer DEFAULT 0,
  last_collection_date date,
  streak_multiplier numeric(4,2) DEFAULT 1.0,
  total_badges integer DEFAULT 0,
  badges jsonb DEFAULT '[]'::jsonb,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(agent_id)
);

ALTER TABLE public.agent_collection_streaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view own streak" ON public.agent_collection_streaks
  FOR SELECT TO authenticated USING (agent_id = auth.uid());

CREATE POLICY "System can manage streaks" ON public.agent_collection_streaks
  FOR ALL USING (true) WITH CHECK (true);

-- Agent incentive bonuses log
CREATE TABLE IF NOT EXISTS public.agent_incentive_bonuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bonus_type text NOT NULL,
  amount numeric DEFAULT 0,
  description text,
  metadata jsonb DEFAULT '{}'::jsonb,
  awarded_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.agent_incentive_bonuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view own bonuses" ON public.agent_incentive_bonuses
  FOR SELECT TO authenticated USING (agent_id = auth.uid());

-- Function to update streak on collection
CREATE OR REPLACE FUNCTION public.update_agent_collection_streak(p_agent_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_date date;
  v_current_streak integer;
  v_longest integer;
  v_today date := CURRENT_DATE;
  v_multiplier numeric(4,2);
  v_badges jsonb;
BEGIN
  SELECT last_collection_date, current_streak, longest_streak, badges
  INTO v_last_date, v_current_streak, v_longest, v_badges
  FROM agent_collection_streaks
  WHERE agent_id = p_agent_id;

  IF NOT FOUND THEN
    INSERT INTO agent_collection_streaks (agent_id, current_streak, longest_streak, last_collection_date, streak_multiplier, badges)
    VALUES (p_agent_id, 1, 1, v_today, 1.0, '[]'::jsonb);
    RETURN;
  END IF;

  IF v_last_date = v_today THEN RETURN; END IF;

  IF v_last_date = v_today - 1 THEN
    v_current_streak := v_current_streak + 1;
  ELSE
    v_current_streak := 1;
  END IF;

  IF v_current_streak > v_longest THEN v_longest := v_current_streak; END IF;

  v_multiplier := LEAST(1.0 + (v_current_streak - 1) * 0.01, 1.20);

  IF v_current_streak = 7 AND NOT (v_badges @> '["7_day_streak"]'::jsonb) THEN
    v_badges := v_badges || '["7_day_streak"]'::jsonb;
  END IF;
  IF v_current_streak = 30 AND NOT (v_badges @> '["30_day_streak"]'::jsonb) THEN
    v_badges := v_badges || '["30_day_streak"]'::jsonb;
  END IF;

  UPDATE agent_collection_streaks
  SET current_streak = v_current_streak,
      longest_streak = v_longest,
      last_collection_date = v_today,
      streak_multiplier = v_multiplier,
      total_badges = jsonb_array_length(v_badges),
      badges = v_badges,
      updated_at = now()
  WHERE agent_id = p_agent_id;
END;
$$;