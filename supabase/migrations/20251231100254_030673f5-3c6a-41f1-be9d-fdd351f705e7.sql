-- Add verified column to profiles for agent verification
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;

-- Allow managers to update verification status
CREATE POLICY "Managers can update any profile verification"
ON public.profiles
FOR UPDATE
USING (has_role(auth.uid(), 'manager'::app_role))
WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

-- Allow anyone to view profiles for seller info
CREATE POLICY "Anyone can view profiles"
ON public.profiles
FOR SELECT
USING (true);