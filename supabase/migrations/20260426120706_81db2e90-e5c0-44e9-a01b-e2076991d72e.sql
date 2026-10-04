CREATE TABLE IF NOT EXISTS public.offline_collection_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL UNIQUE,                -- device-generated, idempotency key
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests(id) ON DELETE RESTRICT,
  amount numeric NOT NULL CHECK (amount > 0),
  provisional_receipt_no text NOT NULL,
  captured_at timestamptz NOT NULL,
  proof_type text NOT NULL CHECK (proof_type IN ('photo','signature','sms_code')),
  proof_path text,                              -- storage path; null for sms_code
  gps_lat double precision,
  gps_lng double precision,
  gps_accuracy double precision,
  notes text,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','accepted','rejected','failed')),
  failure_reason text,
  server_collection_id uuid,                    -- maps to agent_collections.id once accepted
  server_receipt_no text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocs_agent ON public.offline_collection_submissions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ocs_status ON public.offline_collection_submissions(status);
CREATE INDEX IF NOT EXISTS idx_ocs_rent_request ON public.offline_collection_submissions(rent_request_id);

CREATE TRIGGER trg_ocs_updated_at
  BEFORE UPDATE ON public.offline_collection_submissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.offline_collection_submissions ENABLE ROW LEVEL SECURITY;

-- Agent can view their own submissions
CREATE POLICY "Agents view own offline submissions"
  ON public.offline_collection_submissions
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

-- Audit roles can view all
CREATE POLICY "Audit roles view all offline submissions"
  ON public.offline_collection_submissions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('cfo','coo','operations','super_admin','manager')
    )
  );

-- Writes are server-side only (edge function uses service_role, which bypasses RLS).
-- No INSERT/UPDATE/DELETE policies = clients cannot mutate this audit log directly.