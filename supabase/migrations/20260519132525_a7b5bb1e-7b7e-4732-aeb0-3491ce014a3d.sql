ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS agent_guarantor_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_guarantor_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_guarantor_consent_version text;