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

-- Minimal stand-in for Supabase Storage's two tables, with RLS on as in
-- Supabase, so the meal-photo bucket's policies can be tested as the real
-- authenticated role. (Supabase's storage API runs uploads under RLS.)
CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, owner uuid, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now()
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id), name text, owner uuid,
  metadata jsonb, created_at timestamptz DEFAULT now(),
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;
-- an unrelated bucket and its policy, to prove Food leaves other buckets alone
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true);
CREATE POLICY avatars_own ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND owner = auth.uid());

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

-- Minimal stand-ins for the HR objects behind public.v_pso_officers, which
-- Food reads to recognise Platform Sales Officers (20261013125000). The view
-- text is the repo definition (20260907231224) verbatim.
CREATE TABLE public.hr_positions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL);
CREATE TABLE public.hr_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id), staff_ref text,
  active boolean NOT NULL DEFAULT true, ended_on date);
CREATE TABLE public.hr_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES public.hr_staff(id),
  position_id uuid NOT NULL REFERENCES public.hr_positions(id),
  started_on date NOT NULL DEFAULT current_date, ended_on date);
ALTER TABLE public.hr_positions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_staff       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_assignments ENABLE ROW LEVEL SECURITY;
create or replace view public.v_pso_officers as
select
  s.id              as staff_id,
  s.user_id         as user_id,
  s.staff_ref       as staff_ref,
  min(a.started_on) as officer_since
from public.hr_staff s
join public.hr_assignments a on a.staff_id = s.id and a.ended_on is null
join public.hr_positions   p on p.id = a.position_id
where s.active
  and s.ended_on is null
  and lower(btrim(p.title)) = 'platform sales officer'
group by s.id, s.user_id, s.staff_ref;
alter view public.v_pso_officers set (security_invoker = on);
revoke all on public.v_pso_officers from anon;
grant select on public.v_pso_officers to authenticated;

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
