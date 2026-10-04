-- Add forced default role columns to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS forced_default_role TEXT
    CHECK (forced_default_role IS NULL OR forced_default_role IN ('tenant','agent','landlord','supporter')),
  ADD COLUMN IF NOT EXISTS forced_default_role_set_by UUID,
  ADD COLUMN IF NOT EXISTS forced_default_role_set_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_forced_default_role
  ON public.profiles(forced_default_role)
  WHERE forced_default_role IS NOT NULL;

-- Allow managers / super_admin / cto to update the forced_default_role on any profile.
-- We add a dedicated UPDATE policy. The existing "users update own profile" policy stays in place.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname = 'Admins can set forced_default_role'
  ) THEN
    CREATE POLICY "Admins can set forced_default_role"
      ON public.profiles
      FOR UPDATE
      TO authenticated
      USING (
        public.has_role(auth.uid(), 'manager'::app_role)
        OR public.has_role(auth.uid(), 'super_admin'::app_role)
        OR public.has_role(auth.uid(), 'cto'::app_role)
      )
      WITH CHECK (
        public.has_role(auth.uid(), 'manager'::app_role)
        OR public.has_role(auth.uid(), 'super_admin'::app_role)
        OR public.has_role(auth.uid(), 'cto'::app_role)
      );
  END IF;
END$$;