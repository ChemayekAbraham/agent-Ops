-- Food M1 local test scaffold: the minimum of a Supabase project that the Food
-- migrations depend on, built in a DISPOSABLE PostgreSQL cluster.
--
-- NEVER run this against a Supabase project; it creates roles and schemas that
-- Supabase already owns.
--
-- Fidelity points that matter for Food M1, mirroring Supabase:
--   * anon / authenticated / service_role are NOLOGIN roles; service_role has
--     BYPASSRLS. Tests act as a user with SET LOCAL ROLE authenticated plus
--     request.jwt.claims, exactly as PostgREST does.
--   * DEFAULT PRIVILEGES grant ALL on new tables and functions in `public` to
--     anon, authenticated and service_role. This is the behaviour the Food
--     migrations' REVOKEs exist to undo, so it must be present for a grant test
--     to mean anything.
--   * auth.uid() reads request.jwt.claim.sub, then request.jwt.claims->>'sub'.
--   * profiles.deleted_at and user_roles.enabled exist, as in production.

-- Roles are cluster-wide; a second scaffolded database in the same cluster
-- reuses them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon          NOLOGIN NOINHERIT;
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
    CREATE ROLE service_role  NOLOGIN NOINHERIT BYPASSRLS;
    CREATE ROLE authenticator LOGIN NOINHERIT;
    GRANT anon, authenticated, service_role TO authenticator;
  END IF;
END $$;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE auth.users (
  id                 uuid PRIMARY KEY,
  instance_id        uuid,
  aud                text,
  role               text,
  email              text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM
  ('employee', 'tenant', 'landlord', 'agent', 'manager', 'cfo', 'ceo', 'supporter');

CREATE TABLE public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id),
  full_name  text,
  phone      text,
  email      text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_roles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  role    public.app_role NOT NULL,
  enabled boolean DEFAULT true,
  UNIQUE (user_id, role)
);
ALTER TABLE public.profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- M1 seeds the initial coordinator by a production profile id. In production
-- that profile exists (verified 2026-10-09). Here a synthetic stand-in carries
-- the same id so the SHIPPING migration can be applied unmodified. It is not a
-- person and carries no personal data.
INSERT INTO auth.users (id, email) VALUES
  ('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', 'seed-coordinator-standin@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', 'SEED COORDINATOR STAND-IN', 'seed-coordinator-standin@example.invalid');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', 'employee');
