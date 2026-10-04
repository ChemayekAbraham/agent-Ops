-- Allow CTO to read all treasury_controls keys so the CTO Platform Controls tab
-- can display current state (CTO already has UPDATE via existing policy).
DROP POLICY IF EXISTS "CTO can read treasury_controls" ON public.treasury_controls;
CREATE POLICY "CTO can read treasury_controls"
ON public.treasury_controls
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'cto'::app_role));