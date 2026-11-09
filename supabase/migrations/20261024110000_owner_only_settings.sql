-- Only the platform owner (Joshua Wanda: his user id AND one of his two emails) can change the controls he has set. HR, super admins, the CFO and
-- every other privileged role are refused, whatever the app lets them do.
--
-- WHO IS THE OWNER: the row(s) in platform_owner. A request counts as the owner only when BOTH the signed-in user id is cb798acb-68bc-4b4e-a414-a3d374e030b6
-- AND the email on the login token is one listed for that id: joshua.wanda@welile.com (his work address) or joshwanda17@gmail.com (the address his
-- account signs in with today). platform_owner can only be changed from the SQL editor or a migration (no app role can touch it).
--
-- WHAT IS LOCKED TO THE OWNER:
--   * Financial Ops access restrictions: list_financial_ops_restrictions, set_financial_ops_restriction, list_financial_ops_features
--   * these treasury_controls settings (insert, update and delete): exception_approver_email (where approval codes go), landlord_gate_weekly_mode,
--     landlord_payouts_blocked (the block switch), and landlord_payout_* (daily budget, budget start, priority)
-- WHAT STAYS AS IT IS: the approval-code flow itself. The CTO, CFO and super admins can still ask to allow an exception or a payout, but nothing happens
-- without the code emailed to the approver, which is the owner's mailbox. Changes from the SQL editor or a migration (no signed-in user) are never blocked.
-- Apply AFTER 20261023170000 and 20261023180000 (the restriction functions are patched in place; a missing one is skipped and reported).
-- Roll back with 20261024110000_owner_only_settings.rollback.sql.

CREATE TABLE IF NOT EXISTS public.platform_owner (
  user_id    uuid NOT NULL,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, email)
);
ALTER TABLE public.platform_owner ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_owner FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.platform_owner TO service_role;
INSERT INTO public.platform_owner (user_id, email) VALUES
  ('cb798acb-68bc-4b4e-a414-a3d374e030b6', 'joshua.wanda@welile.com'),
  ('cb798acb-68bc-4b4e-a414-a3d374e030b6', 'joshwanda17@gmail.com')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.platform_owner o
     WHERE o.user_id = auth.uid() AND lower(o.email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
  );
$function$;
REVOKE ALL ON FUNCTION public.is_platform_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_owner() TO authenticated;

-- The protected settings.
CREATE OR REPLACE FUNCTION public.guard_owner_only_settings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE k_old text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.control_key END; k_new text := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.control_key END;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_owner() AND (
       COALESCE(k_old, '') IN ('exception_approver_email', 'landlord_gate_weekly_mode', 'landlord_payouts_blocked') OR COALESCE(k_old, '') LIKE 'landlord\_payout\_%'
    OR COALESCE(k_new, '') IN ('exception_approver_email', 'landlord_gate_weekly_mode', 'landlord_payouts_blocked') OR COALESCE(k_new, '') LIKE 'landlord\_payout\_%') THEN
    RAISE EXCEPTION 'Only the platform owner can change this setting.' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_owner_only_settings() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_00_owner_only_settings ON public.treasury_controls;
CREATE TRIGGER trg_00_owner_only_settings BEFORE INSERT OR UPDATE OR DELETE ON public.treasury_controls FOR EACH ROW EXECUTE FUNCTION public.guard_owner_only_settings();

-- The Financial Ops restriction functions: swap the "CTO or super admin" check for the owner check.
DO $patch$
DECLARE f text; v_oid oid; v_def text; v_new text;
  v_old constant text := $q$IF NOT (public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN$q$;
BEGIN
  FOREACH f IN ARRAY ARRAY['list_financial_ops_restrictions', 'set_financial_ops_restriction', 'list_financial_ops_features'] LOOP
    SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f LIMIT 1;
    IF v_oid IS NULL THEN RAISE NOTICE 'SKIPPED % (not created yet): apply the migration that creates it, then re-run this patch', f; CONTINUE; END IF;
    v_def := pg_get_functiondef(v_oid);
    IF v_def LIKE '%is_platform_owner%' THEN CONTINUE; END IF;
    v_new := replace(v_def, v_old, 'IF NOT public.is_platform_owner() THEN');
    IF v_new = v_def THEN RAISE EXCEPTION 'Could not lock %: its permission check was not found', f; END IF;
    EXECUTE v_new;
    RAISE NOTICE 'LOCKED  % to the platform owner', f;
  END LOOP;
END
$patch$;
