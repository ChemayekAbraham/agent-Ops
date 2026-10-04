-- Extend lc1_chairpersons to support agent registration, full Uganda
-- administrative structure, Landlord Ops verification, and the two-stage
-- UGX 5,000 agent registration bonus (UGX 1,000 instant + UGX 4,000 on verify).

ALTER TABLE public.lc1_chairpersons
  ADD COLUMN IF NOT EXISTS country text DEFAULT 'Uganda',
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS district text,
  ADD COLUMN IF NOT EXISTS county text,
  ADD COLUMN IF NOT EXISTS sub_county text,
  ADD COLUMN IF NOT EXISTS parish text,
  ADD COLUMN IF NOT EXISTS town_council text,
  ADD COLUMN IF NOT EXISTS cell text,
  ADD COLUMN IF NOT EXISTS zone text,
  ADD COLUMN IF NOT EXISTS registered_by uuid,
  ADD COLUMN IF NOT EXISTS registered_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by uuid,
  ADD COLUMN IF NOT EXISTS listed_bonus_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS listed_bonus_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_bonus_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_bonus_paid_at timestamptz;

-- Helpful indexes for the agent search-first flow and ops verification queue.
CREATE INDEX IF NOT EXISTS idx_lc1_chairpersons_name ON public.lc1_chairpersons (lower(name));
CREATE INDEX IF NOT EXISTS idx_lc1_chairpersons_phone ON public.lc1_chairpersons (phone);
CREATE INDEX IF NOT EXISTS idx_lc1_chairpersons_verified ON public.lc1_chairpersons (verified);
CREATE INDEX IF NOT EXISTS idx_lc1_chairpersons_registered_by ON public.lc1_chairpersons (registered_by);

-- Ensure edge functions (service role) retain full access.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lc1_chairpersons TO authenticated;
GRANT ALL ON public.lc1_chairpersons TO service_role;