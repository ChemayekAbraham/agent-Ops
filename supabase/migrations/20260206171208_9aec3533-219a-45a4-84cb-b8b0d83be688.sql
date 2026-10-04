
-- Table for manager-posted opportunity summaries shown on supporter dashboards
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

-- Managers can insert/update
CREATE POLICY "Managers can insert opportunity summaries"
ON public.opportunity_summaries
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager'
  )
);

CREATE POLICY "Managers can update opportunity summaries"
ON public.opportunity_summaries
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager'
  )
);

-- All authenticated users can read (supporters need to see this)
CREATE POLICY "Authenticated users can read opportunity summaries"
ON public.opportunity_summaries
FOR SELECT
USING (auth.uid() IS NOT NULL);

-- Enable realtime so supporters get live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.opportunity_summaries;
