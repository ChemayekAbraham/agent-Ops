-- Ensure must_change_password defaults to false and is fast to filter on.
ALTER TABLE public.profiles
  ALTER COLUMN must_change_password SET DEFAULT false;

-- Backfill any nulls so the login gate has a deterministic value.
UPDATE public.profiles
  SET must_change_password = false
  WHERE must_change_password IS NULL;

-- Partial index for the login gate lookup (only the rare rows that need a reset).
CREATE INDEX IF NOT EXISTS idx_profiles_must_change_password
  ON public.profiles (id)
  WHERE must_change_password = true;