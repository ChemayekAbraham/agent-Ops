CREATE TABLE public.rd_ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT '',
  owner text NOT NULL DEFAULT '',
  idea_date date NOT NULL DEFAULT current_date,
  summary text NOT NULL DEFAULT '',
  canvas jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.rd_ideas TO authenticated;
GRANT ALL ON public.rd_ideas TO service_role;
ALTER TABLE public.rd_ideas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rd staff read ideas" ON public.rd_ideas FOR SELECT TO authenticated
  USING (public._has_enabled_role(auth.uid(), ARRAY['rd','super_admin','cto','ceo','employee']));
CREATE POLICY "rd staff add ideas" ON public.rd_ideas FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public._has_enabled_role(auth.uid(), ARRAY['rd','super_admin','cto','ceo','employee']));
CREATE POLICY "rd staff edit ideas" ON public.rd_ideas FOR UPDATE TO authenticated
  USING (public._has_enabled_role(auth.uid(), ARRAY['rd','super_admin','cto','ceo','employee']))
  WITH CHECK (public._has_enabled_role(auth.uid(), ARRAY['rd','super_admin','cto','ceo','employee']));
CREATE OR REPLACE FUNCTION public.rd_ideas_touch() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); NEW.updated_by := auth.uid(); NEW.created_by := OLD.created_by; NEW.created_at := OLD.created_at; RETURN NEW; END $$;
CREATE TRIGGER trg_rd_ideas_touch BEFORE UPDATE ON public.rd_ideas FOR EACH ROW EXECUTE FUNCTION public.rd_ideas_touch();