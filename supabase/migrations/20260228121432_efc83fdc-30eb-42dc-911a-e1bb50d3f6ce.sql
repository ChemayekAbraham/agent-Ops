
-- Enable trigram extension for text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add trigram index for profile name search at scale
CREATE INDEX IF NOT EXISTS idx_profiles_full_name_trgm ON profiles USING gin(full_name gin_trgm_ops);

-- Add btree index on profiles phone for fast lookups
CREATE INDEX IF NOT EXISTS idx_profiles_phone ON profiles(phone);
