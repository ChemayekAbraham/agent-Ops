CREATE TABLE public.landlord_verification_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  landlord_id uuid NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
  landlord_name text,
  landlord_phone text,
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_name text,
  agent_phone text,
  note text,
  status text NOT NULL DEFAULT 'pending',
  reject_comment text,
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_landlord_verification_requests_status ON public.landlord_verification_requests(status);
CREATE INDEX idx_landlord_verification_requests_landlord ON public.landlord_verification_requests(landlord_id);
CREATE INDEX idx_landlord_verification_requests_requested_by ON public.landlord_verification_requests(requested_by);

-- Prevent duplicate open requests for the same landlord
CREATE UNIQUE INDEX uniq_open_landlord_verification_request
  ON public.landlord_verification_requests(landlord_id)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON public.landlord_verification_requests TO authenticated;
GRANT ALL ON public.landlord_verification_requests TO service_role;

ALTER TABLE public.landlord_verification_requests ENABLE ROW LEVEL SECURITY;

-- Agents can create requests
CREATE POLICY "Agents can create verification requests"
  ON public.landlord_verification_requests
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = requested_by);

-- Requesters can see their own requests; ops staff can see all
CREATE POLICY "View own or ops sees all verification requests"
  ON public.landlord_verification_requests
  FOR SELECT TO authenticated
  USING (auth.uid() = requested_by OR public.is_ops_role(auth.uid()));

-- Only ops staff can resolve (verify/reject) requests
CREATE POLICY "Ops can update verification requests"
  ON public.landlord_verification_requests
  FOR UPDATE TO authenticated
  USING (public.is_ops_role(auth.uid()))
  WITH CHECK (public.is_ops_role(auth.uid()));

CREATE TRIGGER update_landlord_verification_requests_updated_at
  BEFORE UPDATE ON public.landlord_verification_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER PUBLICATION supabase_realtime ADD TABLE public.landlord_verification_requests;