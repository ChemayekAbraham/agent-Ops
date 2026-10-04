ALTER TABLE public.house_listings
  ADD COLUMN IF NOT EXISTS listed_bonus_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS listed_bonus_paid_at timestamptz;