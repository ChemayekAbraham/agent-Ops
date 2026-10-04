-- National ID borrowing declarations.
--
-- Policy: one account, one national ID, one phone number. When someone
-- registers using a national ID that appears to belong to a different named
-- person (e.g. a tenant registering with a relative's ID because they don't
-- have their own), the claimed ID owner must confirm by SMS code before the
-- registration is allowed to proceed. Once confirmed, the borrower is linked
-- to the ID owner for audit/identity purposes only.
--
-- IMPORTANT: this table is a pure identity/compliance record. It must NEVER
-- be read by commission or referral logic — the ID owner earns nothing from
-- the borrower's activity. Commission attribution runs entirely off
-- rent_requests.agent_id and profiles.referrer_id, neither of which this
-- table writes to or is joined against.
CREATE TABLE IF NOT EXISTS public.national_id_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_profile_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  borrower_phone text NOT NULL,
  borrower_full_name text NOT NULL,
  national_id text NOT NULL,
  national_id_name text NOT NULL,
  name_match_score numeric,
  id_owner_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  id_owner_phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending_owner_consent'
    CHECK (status IN ('pending_owner_consent', 'consented', 'rejected', 'expired')),
  consent_code_hash text,
  consent_code_expires_at timestamptz,
  consent_attempts int NOT NULL DEFAULT 0,
  consented_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_national_id_declarations_borrower
  ON public.national_id_declarations (borrower_phone, national_id, status);
CREATE INDEX IF NOT EXISTS idx_national_id_declarations_national_id
  ON public.national_id_declarations (national_id);
CREATE INDEX IF NOT EXISTS idx_national_id_declarations_owner_phone
  ON public.national_id_declarations (id_owner_phone);
CREATE INDEX IF NOT EXISTS idx_national_id_declarations_borrower_profile
  ON public.national_id_declarations (borrower_profile_id);

ALTER TABLE public.national_id_declarations ENABLE ROW LEVEL SECURITY;
-- No policies granted: this table is written and read only by edge functions
-- using the service role (which bypasses RLS). No anon/authenticated client
-- may read or write it directly, matching how other identity/evidence tables
-- (e.g. payout_destination_verifications' decision fields) are locked down.
GRANT ALL ON public.national_id_declarations TO service_role;

CREATE OR REPLACE FUNCTION public.touch_national_id_declarations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_national_id_declarations ON public.national_id_declarations;
CREATE TRIGGER trg_touch_national_id_declarations
BEFORE UPDATE ON public.national_id_declarations
FOR EACH ROW EXECUTE FUNCTION public.touch_national_id_declarations();
