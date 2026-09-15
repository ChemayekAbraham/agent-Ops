-- Payout destination borrowing declarations.
--
-- Extends the same "borrowed identity" consent policy used for National ID
-- borrowing at signup (see national_id_declarations, 20260915140000) to
-- payout destinations: a mobile money number or bank account that is
-- registered under a name different from the withdrawing user's own name.
--
-- Today the only way to clear payout_destination_verifications.status =
-- 'waiting' is a Financial Ops staffer manually phoning the destination
-- owner (finops_decide_payout_destination). This table lets the destination
-- owner confirm themselves instead, by SMS code sent to the destination's
-- own phone (mobile money) or a phone they supply (bank transfer) — a
-- correct code proves control of that phone and consent, which is treated
-- as equivalent to FinOps's phone-call confirmation.
CREATE TABLE IF NOT EXISTS public.payout_destination_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_verification_id uuid NOT NULL REFERENCES public.payout_destination_verifications(id) ON DELETE CASCADE,
  borrower_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  destination_type text NOT NULL CHECK (destination_type IN ('mobile_money', 'bank_transfer')),
  destination_owner_name text NOT NULL,
  name_match_score numeric,
  owner_phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending_owner_consent'
    CHECK (status IN ('pending_owner_consent', 'consented', 'rejected', 'expired')),
  consent_code_hash text,
  consent_code_expires_at timestamptz,
  consent_attempts int NOT NULL DEFAULT 0,
  consented_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_destination_declarations_destination
  ON public.payout_destination_declarations (destination_verification_id, status);
CREATE INDEX IF NOT EXISTS idx_payout_destination_declarations_borrower
  ON public.payout_destination_declarations (borrower_user_id);

ALTER TABLE public.payout_destination_declarations ENABLE ROW LEVEL SECURITY;
-- No policies granted: written and read only by edge functions using the
-- service role. No anon/authenticated client may read or write it directly —
-- the withdrawing user acts on it only through the edge function, which
-- checks caller identity against destination_verification_id.user_id itself.
GRANT ALL ON public.payout_destination_declarations TO service_role;

DROP TRIGGER IF EXISTS trg_touch_payout_destination_declarations ON public.payout_destination_declarations;
CREATE TRIGGER trg_touch_payout_destination_declarations
BEFORE UPDATE ON public.payout_destination_declarations
FOR EACH ROW EXECUTE FUNCTION public.touch_national_id_declarations();
