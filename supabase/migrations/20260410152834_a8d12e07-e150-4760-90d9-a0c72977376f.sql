
-- ============================================
-- 1. FIX: rent_requests - restrict verification to agents/managers
-- ============================================
DROP POLICY IF EXISTS "Authenticated view unverified requests for verification" ON public.rent_requests;
DROP POLICY IF EXISTS "Authenticated can verify unverified requests" ON public.rent_requests;

CREATE POLICY "Agents and managers view unverified requests"
ON public.rent_requests FOR SELECT TO authenticated
USING (
  (agent_verified = false) AND (status = ANY (ARRAY['pending'::text, 'approved'::text]))
  AND (public.has_role(auth.uid(), 'agent'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role))
);

CREATE POLICY "Agents and managers can verify unverified requests"
ON public.rent_requests FOR UPDATE TO authenticated
USING (
  (agent_verified = false) AND (status = ANY (ARRAY['pending'::text, 'approved'::text]))
  AND (public.has_role(auth.uid(), 'agent'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role))
)
WITH CHECK (
  public.has_role(auth.uid(), 'agent'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role)
);

-- ============================================
-- 2. FIX: agent_subagents - restrict staff update to actual staff roles
-- ============================================
DROP POLICY IF EXISTS "Staff can update agent_subagents status" ON public.agent_subagents;

CREATE POLICY "Staff can update agent_subagents status"
ON public.agent_subagents FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
);

-- ============================================
-- 3. FIX: payout_codes - restrict updates to agents, inserts to managers
-- ============================================
DROP POLICY IF EXISTS "Agents can update payout_codes" ON public.payout_codes;
DROP POLICY IF EXISTS "Service can insert payout_codes" ON public.payout_codes;

CREATE POLICY "Agents can update payout_codes"
ON public.payout_codes FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'agent'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can insert payout_codes"
ON public.payout_codes FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'manager'::app_role));

-- ============================================
-- 4. FIX: lc1_chairpersons - restrict inserts to agents/managers
-- ============================================
DROP POLICY IF EXISTS "Authenticated users can insert lc1" ON public.lc1_chairpersons;

CREATE POLICY "Agents and managers can insert lc1"
ON public.lc1_chairpersons FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'agent'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role)
);

-- ============================================
-- 5. FIX: shadow tables - add deny-all policies (system-only)
-- ============================================
CREATE POLICY "Deny all access to shadow_audit_logs"
ON public.shadow_audit_logs FOR ALL
USING (false);

CREATE POLICY "Deny all access to shadow_config"
ON public.shadow_config FOR ALL
USING (false);

-- ============================================
-- 6. FIX: Functions without search_path
-- ============================================
CREATE OR REPLACE FUNCTION public.auto_assign_short_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  new_code TEXT;
  attempts INT := 0;
BEGIN
  IF NEW.short_code IS NULL THEN
    LOOP
      new_code := public.generate_short_code();
      IF NOT EXISTS (SELECT 1 FROM public.house_listings WHERE short_code = new_code) THEN
        NEW.short_code := new_code;
        EXIT;
      END IF;
      attempts := attempts + 1;
      IF attempts > 10 THEN
        RAISE EXCEPTION 'Could not generate unique short code after 10 attempts';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_short_code()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  result TEXT := '';
  i INT;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  END LOOP;
  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_access_fee_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF NEW.access_fee_status NOT IN ('unpaid', 'partial', 'settled') THEN
    RAISE EXCEPTION 'Invalid access_fee_status: %. Must be unpaid, partial, or settled.', NEW.access_fee_status;
  END IF;
  RETURN NEW;
END;
$function$;
