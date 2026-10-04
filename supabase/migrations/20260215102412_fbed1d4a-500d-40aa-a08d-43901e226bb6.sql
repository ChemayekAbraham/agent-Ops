
-- Create opportunity_summaries table
CREATE TABLE public.opportunity_summaries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  total_rent_requested NUMERIC NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_landlords INTEGER NOT NULL DEFAULT 0,
  total_agents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  posted_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.opportunity_summaries ENABLE ROW LEVEL SECURITY;

-- Everyone can read (supporters need to see this)
CREATE POLICY "Anyone can view opportunity summaries"
  ON public.opportunity_summaries FOR SELECT
  USING (true);

-- Only managers can insert/update
CREATE POLICY "Managers can insert opportunity summaries"
  ON public.opportunity_summaries FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager' AND enabled = true)
  );

CREATE POLICY "Managers can update opportunity summaries"
  ON public.opportunity_summaries FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager' AND enabled = true)
  );

-- Enable realtime so supporters see updates instantly
ALTER PUBLICATION supabase_realtime ADD TABLE public.opportunity_summaries;

-- Trigger for updated_at
CREATE TRIGGER update_opportunity_summaries_updated_at
  BEFORE UPDATE ON public.opportunity_summaries
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
