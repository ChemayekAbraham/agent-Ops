-- Item 9: capture password-change events, including IP where available.
--
-- Four distinct password-change paths exist in this codebase. Two already
-- write to audit_logs and are covered by item 8 (reset_staff_access_password
-- RPC; ForceResetPasswordGate.tsx's client-side insert for CTO-issued temp
-- passwords). Two had NO trace anywhere: self-service "forgot password"
-- (resetPasswordForEmail + UpdatePassword.tsx's supabase.auth.updateUser)
-- and voluntary password change in Settings.tsx (also supabase.auth.
-- updateUser). Both end at the same call, which updates auth.users.
-- encrypted_password directly through GoTrue -- never through a public-
-- schema RPC or a PostgREST table insert like every other item in this
-- series.
--
-- Notably, Supabase's own built-in auth.audit_log_entries -- the table
-- meant to catch exactly this -- has zero rows across this project's
-- entire history, confirming native auth audit logging is not populating
-- here at all.
--
-- Fix: a new password_change_audit table + an AFTER UPDATE OF
-- encrypted_password trigger on auth.users, following the existing pattern
-- of triggers already on that table in this project (on_auth_user_created,
-- trg_revoke_agent_mgmt_on_login). This guarantees WHO changed their
-- password and WHEN, regardless of which of the four paths was used.
--
-- IMPORTANT CAVEAT, stated plainly rather than assumed away: unlike every
-- other item in this series, this UPDATE is issued by GoTrue's own auth
-- service, not by a PostgREST request against a public-schema table. It is
-- NOT confirmed whether request.headers (and therefore IP/user-agent) is
-- populated on this path -- that can only be observed from a real password
-- change. The insert is wrapped in its own exception handler so a missing
-- or malformed header context degrades to a null IP/UA on the row rather
-- than losing the row (or blocking the password change) entirely.

CREATE TABLE IF NOT EXISTS public.password_change_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_change_audit_user ON public.password_change_audit (user_id, created_at DESC);

ALTER TABLE public.password_change_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff read password change audit" ON public.password_change_audit;
CREATE POLICY "Staff read password change audit"
  ON public.password_change_audit FOR SELECT TO authenticated
  USING (public.is_withdrawal_staff(auth.uid()) OR user_id = auth.uid());
REVOKE ALL ON public.password_change_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.password_change_audit FROM authenticated;
GRANT SELECT ON public.password_change_audit TO authenticated;

CREATE OR REPLACE FUNCTION public.log_password_change_on_auth_users()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
    IF v_ip IS NULL THEN
      v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
    END IF;
    v_ua := v_headers ->> 'user-agent';
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
    v_ua := NULL;
  END;

  BEGIN
    INSERT INTO public.password_change_audit (user_id, ip_address, user_agent)
    VALUES (NEW.id, v_ip, v_ua);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_log_password_change ON auth.users;
CREATE TRIGGER trg_log_password_change
  AFTER UPDATE OF encrypted_password ON auth.users
  FOR EACH ROW
  WHEN (NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password)
  EXECUTE FUNCTION public.log_password_change_on_auth_users();
