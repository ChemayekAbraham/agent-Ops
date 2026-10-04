
-- Phase 0: Emergency indexes for the top DB CPU hotspots.
-- All indexes are IF NOT EXISTS-safe and touch no data.

-- Trigram support for ILIKE searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Landlord name/phone search (largest single hotspot)
CREATE INDEX IF NOT EXISTS idx_landlords_name_trgm
  ON public.landlords USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_landlords_phone_trgm
  ON public.landlords USING gin (phone gin_trgm_ops);

-- Profile fuzzy search across full_name / phone / email
CREATE INDEX IF NOT EXISTS idx_profiles_full_name_trgm
  ON public.profiles USING gin (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_profiles_phone_trgm
  ON public.profiles USING gin (phone gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_profiles_email_trgm
  ON public.profiles USING gin (email gin_trgm_ops);

-- Referrer / sub-agent lookups
CREATE INDEX IF NOT EXISTS idx_profiles_referrer_created
  ON public.profiles (referrer_id, created_at DESC)
  WHERE referrer_id IS NOT NULL;

-- user_roles filtering by role + enabled + created_at
CREATE INDEX IF NOT EXISTS idx_user_roles_role_enabled_created
  ON public.user_roles (role, enabled, created_at);

-- Per-user general_ledger history feed (matches the wallet statement filter)
CREATE INDEX IF NOT EXISTS idx_gl_user_scope_created
  ON public.general_ledger (user_id, ledger_scope, created_at DESC)
  WHERE classification <> 'admin_correction'
    AND category      <> 'system_balance_correction';

-- Available / verified public house listings
CREATE INDEX IF NOT EXISTS idx_house_listings_available
  ON public.house_listings (status, is_hidden, verified)
  WHERE tenant_id IS NULL;

-- Nudge the planner so it picks up the new indexes on the next query.
ANALYZE public.landlords;
ANALYZE public.profiles;
ANALYZE public.user_roles;
ANALYZE public.general_ledger;
ANALYZE public.house_listings;
