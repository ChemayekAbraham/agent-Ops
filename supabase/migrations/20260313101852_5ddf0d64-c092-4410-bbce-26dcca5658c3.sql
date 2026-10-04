
-- Add seller columns to profiles
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS is_seller boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seller_application_status text DEFAULT null;

-- Comment for clarity
COMMENT ON COLUMN public.profiles.is_seller IS 'Whether this user has been granted selling rights by a manager';
COMMENT ON COLUMN public.profiles.seller_application_status IS 'Application status: pending, approved, rejected, or null';
