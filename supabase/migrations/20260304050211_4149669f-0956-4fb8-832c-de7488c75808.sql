
-- Add location hierarchy columns to landlords table
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'Uganda',
  ADD COLUMN IF NOT EXISTS region TEXT,
  ADD COLUMN IF NOT EXISTS district TEXT,
  ADD COLUMN IF NOT EXISTS county TEXT,
  ADD COLUMN IF NOT EXISTS sub_county TEXT,
  ADD COLUMN IF NOT EXISTS town_council TEXT,
  ADD COLUMN IF NOT EXISTS village TEXT,
  ADD COLUMN IF NOT EXISTS cell TEXT,
  ADD COLUMN IF NOT EXISTS house_number TEXT;

-- Allow all agents to view all landlords (read-only directory)
CREATE POLICY "Agents can browse all landlords for rental finder"
  ON public.landlords
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'agent'::public.app_role));

-- Drop the old narrow agent SELECT policy since the new one is broader
DROP POLICY IF EXISTS "Agents can view relevant landlords" ON public.landlords;
