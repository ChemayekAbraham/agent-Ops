-- Enable pg_trgm extension for fast ILIKE search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes on profiles for partner search performance
CREATE INDEX IF NOT EXISTS idx_profiles_full_name_trgm
  ON public.profiles USING gin (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_profiles_phone_trgm
  ON public.profiles USING gin (phone gin_trgm_ops);