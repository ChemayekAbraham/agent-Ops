
CREATE POLICY "hr_manage_leave_requests" ON public.leave_requests
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'hr'))
  WITH CHECK (public.has_role(auth.uid(), 'hr'));

CREATE POLICY "hr_manage_leave_balances" ON public.leave_balances
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'hr'))
  WITH CHECK (public.has_role(auth.uid(), 'hr'));

CREATE POLICY "hr_manage_disciplinary" ON public.disciplinary_records
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'hr'))
  WITH CHECK (public.has_role(auth.uid(), 'hr'));

CREATE POLICY "hr_manage_payroll_batches" ON public.payroll_batches
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'hr'))
  WITH CHECK (public.has_role(auth.uid(), 'hr'));

CREATE POLICY "hr_manage_payroll_items" ON public.payroll_items
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'hr'))
  WITH CHECK (public.has_role(auth.uid(), 'hr'));
