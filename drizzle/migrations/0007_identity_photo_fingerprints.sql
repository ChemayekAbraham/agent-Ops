-- Identity photo fingerprints: SHA-256 + quality verdict of each submitted
-- passport photo, linked to the user (and later their Welile AI ID).
-- Reference data only: touches no wallet, ledger or financial record.

CREATE TABLE IF NOT EXISTS public.identity_photo_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  source text NOT NULL DEFAULT 'tenant_onboarding',
  verdict text,
  score numeric,
  is_face boolean,
  is_passport_photo boolean,
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  photo_url text,
  rent_request_id uuid,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS identity_photo_fingerprints_user_sha_key
  ON public.identity_photo_fingerprints (user_id, sha256);
CREATE INDEX IF NOT EXISTS identity_photo_fingerprints_sha_idx
  ON public.identity_photo_fingerprints (sha256);
CREATE INDEX IF NOT EXISTS identity_photo_fingerprints_user_idx
  ON public.identity_photo_fingerprints (user_id, checked_at DESC);

GRANT SELECT ON public.identity_photo_fingerprints TO authenticated;
GRANT ALL ON public.identity_photo_fingerprints TO service_role;

ALTER TABLE public.identity_photo_fingerprints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own photo fingerprints" ON public.identity_photo_fingerprints;
CREATE POLICY "Users read own photo fingerprints"
  ON public.identity_photo_fingerprints
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Ops read photo fingerprints" ON public.identity_photo_fingerprints;
CREATE POLICY "Ops read photo fingerprints"
  ON public.identity_photo_fingerprints
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'tenant_ops')
    OR public.has_role(auth.uid(), 'agent_ops')
  );

CREATE OR REPLACE FUNCTION public.touch_identity_photo_fingerprints()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_identity_photo_fingerprints ON public.identity_photo_fingerprints;
CREATE TRIGGER trg_touch_identity_photo_fingerprints
  BEFORE UPDATE ON public.identity_photo_fingerprints
  FOR EACH ROW EXECUTE FUNCTION public.touch_identity_photo_fingerprints();