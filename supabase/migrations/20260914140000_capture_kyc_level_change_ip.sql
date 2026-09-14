-- Item 48 of tying every action to an IP address: KYC status changes /
-- overriding KYC or withdrawal restrictions -- explicitly flagged in the
-- original proposal's "access and permissions" category.
--
-- kyc_level_change_audit is written to by exactly 4 RPCs
-- (admin_freeze_kyc_account, admin_set_kyc_level, admin_unfreeze_kyc_
-- account, cto_set_kyc_level), none of them called from any edge function
-- (checked directly -- only a documentation file references the names) --
-- meaning these are called straight from the client via supabase.rpc(),
-- so a table-level trigger gets the real browser IP with no service-role
-- indirection to worry about. The edge-runtime guard is still included
-- defensively, consistent with every other capture trigger in this series.
--
-- Same pattern as audit_logs (item 8), login_phase_events (item 6), and
-- system_events (item 47): one BEFORE INSERT trigger covers all 4 writers
-- without touching any of their function bodies.

ALTER TABLE public.kyc_level_change_audit
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE OR REPLACE FUNCTION public.capture_kyc_level_change_ip()
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

  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  IF v_ip IS NULL THEN
    v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);
  NEW.user_agent := coalesce(NEW.user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_capture_kyc_level_change_ip ON public.kyc_level_change_audit;
CREATE TRIGGER trg_capture_kyc_level_change_ip
  BEFORE INSERT ON public.kyc_level_change_audit
  FOR EACH ROW EXECUTE FUNCTION public.capture_kyc_level_change_ip();
