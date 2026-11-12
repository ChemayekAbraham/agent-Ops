-- Local production schema clone: structure only, no rows. Stubs for Supabase-managed schemas.
SET client_min_messages = warning;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
END $$;
CREATE SCHEMA extensions; CREATE SCHEMA auth; CREATE SCHEMA net; CREATE SCHEMA pgmq; CREATE SCHEMA vault;
CREATE SCHEMA cron; CREATE SCHEMA storage;
CREATE EXTENSION pgcrypto SCHEMA extensions; CREATE EXTENSION "uuid-ossp" SCHEMA extensions; CREATE EXTENSION pg_trgm SCHEMA extensions;
CREATE DOMAIN extensions.geography AS text;
SET search_path = public, extensions;
-- auth
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, phone text, encrypted_password text,
  raw_user_meta_data jsonb DEFAULT '{}', raw_app_meta_data jsonb DEFAULT '{}', created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz, phone_confirmed_at timestamptz,
  banned_until timestamptz, deleted_at timestamptz, is_anonymous boolean DEFAULT false, is_sso_user boolean DEFAULT false);
CREATE TABLE auth.identities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, provider text, provider_id text,
  identity_data jsonb, email text, created_at timestamptz DEFAULT now(), updated_at timestamptz, last_sign_in_at timestamptz);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, created_at timestamptz DEFAULT now(),
  updated_at timestamptz, aal text, not_after timestamptz, user_agent text, ip inet);
CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, factor_type text, created_at timestamptz DEFAULT now());
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.email', true), '') $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb,
  jsonb_build_object('sub', auth.uid(), 'role', auth.role(), 'aal', 'aal1')) $$;
-- net: record every call instead of making it
CREATE TABLE net.t_calls (id bigserial PRIMARY KEY, url text, body jsonb, headers jsonb, at timestamptz DEFAULT clock_timestamp());
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.t_calls (url, body, headers) VALUES (url, body, headers) RETURNING id $$;
CREATE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.t_calls (url, body, headers) VALUES (url, params, headers) RETURNING id $$;
-- pgmq: one table for all queues
CREATE TABLE pgmq.t_msgs (msg_id bigserial PRIMARY KEY, queue text, message jsonb, enqueued_at timestamptz DEFAULT now());
CREATE TABLE pgmq.q_transactional_emails (msg_id bigint, message jsonb, read_ct int DEFAULT 0, enqueued_at timestamptz DEFAULT now(), vt timestamptz DEFAULT now());
CREATE TABLE pgmq.q_auth_emails (msg_id bigint, message jsonb, read_ct int DEFAULT 0, enqueued_at timestamptz DEFAULT now(), vt timestamptz DEFAULT now());
CREATE FUNCTION pgmq.send(queue_name text, msg jsonb, delay integer DEFAULT 0) RETURNS SETOF bigint LANGUAGE sql AS
  $$ INSERT INTO pgmq.t_msgs (queue, message) VALUES (queue_name, msg) RETURNING msg_id $$;
CREATE FUNCTION pgmq.create(queue_name text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION pgmq.delete(queue_name text, msg_id bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
-- vault
CREATE TABLE vault.t_secrets (name text PRIMARY KEY, decrypted_secret text);
CREATE VIEW vault.decrypted_secrets AS SELECT gen_random_uuid() AS id, name, decrypted_secret, ''::text AS description FROM vault.t_secrets;
INSERT INTO vault.t_secrets VALUES ('service_role_key','local-test-key'),('supabase_url','http://local.test'),('project_url','http://local.test'),
  ('SUPABASE_URL','http://local.test'),('SERVICE_ROLE_KEY','local-test-key'),('email_queue_service_role_key','local-test-key');
-- cron
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true,
  database text DEFAULT current_database(), username text DEFAULT current_user, nodename text DEFAULT 'localhost', nodeport int DEFAULT 5432);
CREATE TABLE cron.job_run_details (runid bigserial PRIMARY KEY, jobid bigint, status text, return_message text, start_time timestamptz,
  end_time timestamptz, command text, database text, username text, job_pid int);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS
  $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS
  $$ WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT EXISTS (SELECT 1 FROM d) $$;
-- storage
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
-- statement runner table
CREATE TABLE public._clone_stmts (seq int PRIMARY KEY, phase int, sql text, done boolean DEFAULT false, err text);
