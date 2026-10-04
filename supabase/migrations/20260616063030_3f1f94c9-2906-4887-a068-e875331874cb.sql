CREATE TABLE public.lc1_verification_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lc1_id uuid NOT NULL REFERENCES public.lc1_chairpersons(id) ON DELETE CASCADE,
  lc1_name text,
  lc1_phone text,
  lc1_village text,
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_name text,
  agent_phone text,
  note text,
  status text NOT NULL DEFAULT 'pending',
  reject_comment text,
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lc1_verification_requests TO authenticated;
GRANT ALL ON public.lc1_verification_requests TO service_role;

ALTER TABLE public.lc1_verification_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can create lc1 verification requests"
  ON public.lc1_verification_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = requested_by);

CREATE POLICY "View own or ops sees all lc1 verification requests"
  ON public.lc1_verification_requests
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = requested_by) OR is_ops_role(auth.uid()));

CREATE POLICY "Ops can update lc1 verification requests"
  ON public.lc1_verification_requests
  FOR UPDATE
  TO authenticated
  USING (is_ops_role(auth.uid()))
  WITH CHECK (is_ops_role(auth.uid()));

CREATE INDEX idx_lc1_verification_requests_lc1 ON public.lc1_verification_requests (lc1_id);
CREATE INDEX idx_lc1_verification_requests_requested_by ON public.lc1_verification_requests (requested_by);
CREATE INDEX idx_lc1_verification_requests_status ON public.lc1_verification_requests (status);
CREATE UNIQUE INDEX uniq_open_lc1_verification_request ON public.lc1_verification_requests (lc1_id) WHERE status = 'pending';

CREATE TRIGGER update_lc1_verification_requests_updated_at
  BEFORE UPDATE ON public.lc1_verification_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER PUBLICATION supabase_realtime ADD TABLE public.lc1_verification_requests;