-- CTO-grantable exceptions to the mandatory ID-upload requirement.
--
-- withdrawal_user_id_verified(p_user_id) is the single choke point that
-- gates whether a merchant agent can see/claim a withdrawal for a customer
-- (drizzle/migrations/0056_merchant_claim_requires_id_and_selfie_submitted.sql):
-- it requires national_id + national_id_photo_path + selfie_photo_path on
-- profiles, plus a verified payout_destination_verifications row. It is
-- called (via the withdrawal_merchant_id_gate wrapper) from exactly four
-- places -- confirmed via prosrc search: the RLS SELECT policy, the RLS
-- claim/release UPDATE policy, claim_withdrawal_verified(), and
-- auto_dispatch_withdrawals() -- so extending this ONE function is the
-- single change needed to cover all four.
--
-- Exceptions are per-user, CTO-only, require a written reason, and are
-- append-only (revoking writes revoked_at/revoked_by rather than deleting
-- the row) so the history of who was exempted, by whom, and why is never
-- lost. IP is captured server-side, same cf-connecting-ip-first pattern and
-- edge-runtime guard as every other capture trigger in this codebase --
-- an identity-verification override is squarely inside "changes identity"
-- from the IP-audit initiative's own scope.

CREATE TABLE IF NOT EXISTS public.id_verification_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  reason text NOT NULL,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  revoked_reason text,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only one ACTIVE (unrevoked) exception per user at a time. Granting again
-- after a revoke inserts a fresh row rather than reactivating the old one,
-- so the full history stays intact.
CREATE UNIQUE INDEX IF NOT EXISTS idx_id_verification_exceptions_active_user
  ON public.id_verification_exceptions (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_id_verification_exceptions_user
  ON public.id_verification_exceptions (user_id);

ALTER TABLE public.id_verification_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CTO manages ID verification exceptions" ON public.id_verification_exceptions;
CREATE POLICY "CTO manages ID verification exceptions"
  ON public.id_verification_exceptions FOR ALL
  USING (public.has_role(auth.uid(), 'cto'))
  WITH CHECK (public.has_role(auth.uid(), 'cto'));

CREATE OR REPLACE FUNCTION public.capture_id_verification_exception_ip()
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
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ua := v_headers ->> 'user-agent';
  IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
    RETURN NEW;
  END IF;

  v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  IF v_ip IS NULL THEN
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);
  NEW.user_agent := coalesce(NEW.user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_capture_id_verification_exception_ip ON public.id_verification_exceptions;
CREATE TRIGGER trg_capture_id_verification_exception_ip
  BEFORE INSERT ON public.id_verification_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.capture_id_verification_exception_ip();

CREATE OR REPLACE FUNCTION public.cto_grant_id_verification_exception(p_user_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'cto') THEN
    RAISE EXCEPTION 'Only CTO can grant an ID-verification exception';
  END IF;
  IF char_length(coalesce(btrim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.id_verification_exceptions
    WHERE user_id = p_user_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'This user already has an active ID-verification exception';
  END IF;

  INSERT INTO public.id_verification_exceptions (user_id, reason, granted_by)
  VALUES (p_user_id, btrim(p_reason), auth.uid())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cto_revoke_id_verification_exception(p_user_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'cto') THEN
    RAISE EXCEPTION 'Only CTO can revoke an ID-verification exception';
  END IF;
  IF char_length(coalesce(btrim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  UPDATE public.id_verification_exceptions
     SET revoked_at = now(),
         revoked_by = auth.uid(),
         revoked_reason = btrim(p_reason)
   WHERE user_id = p_user_id AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active ID-verification exception for this user';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.cto_grant_id_verification_exception(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cto_grant_id_verification_exception(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.cto_revoke_id_verification_exception(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cto_revoke_id_verification_exception(uuid, text) TO authenticated;

-- The single choke point: OR in an active exception. Both branches of the
-- existing check (documents+photos AND verified destination) are bypassed
-- together by design -- a CTO exception means "this specific person does
-- not need to go through ID verification at all", not "skip only one leg
-- of it".
CREATE OR REPLACE FUNCTION public.withdrawal_user_id_verified(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.id_verification_exceptions e
    where e.user_id = p_user_id and e.revoked_at is null
  )
  or (
    exists (
      select 1
      from public.profiles p
      where p.id = p_user_id
        and coalesce(btrim(p.national_id), '') <> ''
        and coalesce(btrim(p.national_id_photo_path), '') <> ''
        and coalesce(btrim(p.selfie_photo_path), '') <> ''
    )
    and exists (
      select 1
      from public.payout_destination_verifications v
      where v.user_id = p_user_id
        and v.status = 'verified'
    )
  )
$function$;
