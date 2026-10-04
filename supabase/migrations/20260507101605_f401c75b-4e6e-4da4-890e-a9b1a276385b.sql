
-- Disable maintenance mode immediately
UPDATE public.treasury_controls
SET enabled = false, updated_at = now()
WHERE control_key = 'maintenance_mode';

-- Allow CTO to toggle treasury_controls (was previously CFO + super_admin only)
DROP POLICY IF EXISTS "CFO and super_admin can update treasury_controls" ON public.treasury_controls;
DROP POLICY IF EXISTS "Treasury controls update" ON public.treasury_controls;

CREATE POLICY "Privileged roles can update treasury_controls"
  ON public.treasury_controls FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'cto')
      OR public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'cfo')
           OR public.has_role(auth.uid(), 'cto')
           OR public.has_role(auth.uid(), 'super_admin'));
