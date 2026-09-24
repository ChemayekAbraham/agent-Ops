CREATE TABLE public.payout_name_check_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id uuid NOT NULL,
  subject_user_id uuid,
  payout_target text,
  network text,
  checked_name text NOT NULL,
  id_name text,
  outcome text NOT NULL CHECK (outcome IN ('match','partial','different')),
  checked_by uuid NOT NULL DEFAULT auth.uid(),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_name_check_log_dest_idx ON public.payout_name_check_log (destination_id, checked_at DESC);
GRANT SELECT, INSERT ON public.payout_name_check_log TO authenticated;
GRANT ALL ON public.payout_name_check_log TO service_role;
ALTER TABLE public.payout_name_check_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Fin ops read name checks" ON public.payout_name_check_log FOR SELECT TO authenticated
USING (public.has_role(auth.uid(),'financial_ops') OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Fin ops record own name checks" ON public.payout_name_check_log FOR INSERT TO authenticated
WITH CHECK (checked_by = auth.uid() AND (public.has_role(auth.uid(),'financial_ops') OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'admin')));
COMMENT ON TABLE public.payout_name_check_log IS 'Append-only history of payout number name checks. No update/delete policies by design.';