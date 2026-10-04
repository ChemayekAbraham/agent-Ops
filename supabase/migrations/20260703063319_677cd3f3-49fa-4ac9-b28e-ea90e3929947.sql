-- Allow executive/admin roles to delete promissory notes (with app-level audit trail)
CREATE POLICY "Admin roles can delete promissory notes"
ON public.promissory_notes
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.role = ANY (ARRAY[
        'operations'::app_role,
        'cfo'::app_role,
        'coo'::app_role,
        'super_admin'::app_role,
        'manager'::app_role,
        'ceo'::app_role
      ])
  )
);