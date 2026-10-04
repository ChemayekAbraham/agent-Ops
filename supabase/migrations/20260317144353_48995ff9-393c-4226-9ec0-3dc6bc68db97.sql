
-- Saved/Wishlist houses
CREATE TABLE public.saved_houses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  house_id UUID NOT NULL REFERENCES public.house_listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, house_id)
);

ALTER TABLE public.saved_houses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own saved houses"
  ON public.saved_houses FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can save houses"
  ON public.saved_houses FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can unsave houses"
  ON public.saved_houses FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX idx_saved_houses_user ON public.saved_houses(user_id);
CREATE INDEX idx_saved_houses_house ON public.saved_houses(house_id);

-- House Q&A
CREATE TABLE public.house_questions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  house_id UUID NOT NULL REFERENCES public.house_listings(id) ON DELETE CASCADE,
  asker_id UUID NOT NULL,
  question_text TEXT NOT NULL,
  answer_text TEXT,
  answered_by UUID,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.house_questions ENABLE ROW LEVEL SECURITY;

-- Anyone can read questions
CREATE POLICY "Anyone can view house questions"
  ON public.house_questions FOR SELECT
  USING (true);

-- Authenticated users can ask
CREATE POLICY "Authenticated users can ask questions"
  ON public.house_questions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = asker_id);

-- Asker can edit their question, agent can answer
CREATE POLICY "Asker or agent can update questions"
  ON public.house_questions FOR UPDATE TO authenticated
  USING (
    auth.uid() = asker_id 
    OR auth.uid() IN (SELECT agent_id FROM public.house_listings WHERE id = house_id)
  );

CREATE POLICY "Asker can delete own question"
  ON public.house_questions FOR DELETE TO authenticated
  USING (auth.uid() = asker_id);

CREATE INDEX idx_house_questions_house ON public.house_questions(house_id);

-- Trigger for updated_at
CREATE TRIGGER update_house_questions_updated_at
  BEFORE UPDATE ON public.house_questions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
