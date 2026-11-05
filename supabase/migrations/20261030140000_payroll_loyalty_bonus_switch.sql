-- CTO > Platform Controls: an on/off switch for the daily 0.5% payroll loyalty bonus, that ONLY the owner can flip.
--
-- The bonus is posted once a day (00:00 UTC) by the apply-payroll-growth edge function, which credits each un-withdrawn payroll balance 0.5%.
-- This adds the switch the function reads. OFF means the function posts nothing. A missing or unreadable switch also means nothing is posted.
--
-- Who can change it: Joshua Wanda only (id cb798acb-68bc-4b4e-a414-a3d374e030b6, joshwanda17@gmail.com, phone 0704825473), signed in.
-- No other role (CTO, CFO, super admin, manager, HR) and no plain SQL session can change the row: a trigger refuses every
-- insert, update and delete on it unless the change comes through set_payroll_loyalty_bonus() while the owner is signed in.
-- The row is created ON, which is today's behaviour. The owner turns it OFF from CTO > Platform Controls.
--
-- Changes no balance and no ledger row. Roll back with 20261030140000_payroll_loyalty_bonus_switch.rollback.sql.

-- 1) The switch row (ON = what runs today). The trigger below is created after this, so the first insert needs no bypass.
INSERT INTO public.treasury_controls (control_key, enabled)
SELECT 'payroll_loyalty_bonus_enabled', true
 WHERE NOT EXISTS (SELECT 1 FROM public.treasury_controls WHERE control_key = 'payroll_loyalty_bonus_enabled');

-- 2) Who is the owner: id, email AND phone all have to match.
CREATE OR REPLACE FUNCTION public.is_payroll_loyalty_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM auth.users u
      JOIN public.profiles p ON p.id = u.id
     WHERE u.id = auth.uid()
       AND u.id = 'cb798acb-68bc-4b4e-a414-a3d374e030b6'::uuid
       AND lower(u.email) = 'joshwanda17@gmail.com'
       AND right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9) = '704825473'
  );
$function$;

-- 3) The lock: nobody changes the row except through set_payroll_loyalty_bonus() by the signed-in owner.
CREATE OR REPLACE FUNCTION public.guard_payroll_loyalty_bonus_switch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_touches boolean;
BEGIN
  v_touches := (TG_OP IN ('UPDATE', 'DELETE') AND OLD.control_key = 'payroll_loyalty_bonus_enabled')
            OR (TG_OP IN ('INSERT', 'UPDATE') AND NEW.control_key = 'payroll_loyalty_bonus_enabled');
  IF NOT v_touches THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF coalesce(current_setting('welile.loyalty_switch_ok', true), '') = 'on' AND public.is_payroll_loyalty_owner() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION 'Only the owner can change the payroll loyalty bonus switch.' USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS trg_00_guard_payroll_loyalty_bonus_switch ON public.treasury_controls;
CREATE TRIGGER trg_00_guard_payroll_loyalty_bonus_switch
  BEFORE INSERT OR UPDATE OR DELETE ON public.treasury_controls
  FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_loyalty_bonus_switch();

-- 4) The only way to flip it.
CREATE OR REPLACE FUNCTION public.set_payroll_loyalty_bonus(p_enabled boolean, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old boolean;
BEGIN
  IF NOT public.is_payroll_loyalty_owner() THEN
    RAISE EXCEPTION 'Only the owner can change the payroll loyalty bonus switch.' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'Say whether the bonus is on or off.';
  END IF;

  SELECT enabled INTO v_old FROM public.treasury_controls WHERE control_key = 'payroll_loyalty_bonus_enabled';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The payroll loyalty bonus switch row is missing.';
  END IF;

  PERFORM set_config('welile.loyalty_switch_ok', 'on', true);
  UPDATE public.treasury_controls
     SET enabled = p_enabled, updated_by = auth.uid(), updated_at = now()
   WHERE control_key = 'payroll_loyalty_bonus_enabled';
  PERFORM set_config('welile.loyalty_switch_ok', 'off', true);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values, performed_by)
  VALUES (auth.uid(), 'payroll_loyalty_bonus_switch', 'treasury_controls', 'payroll_loyalty_bonus_enabled', p_reason,
          jsonb_build_object('enabled', v_old), jsonb_build_object('enabled', p_enabled), auth.uid());

  RETURN jsonb_build_object('enabled', p_enabled, 'was', v_old);
END;
$function$;

-- 5) What the Platform Controls card shows. Readable by the executives; can_change is true only for the owner.
CREATE OR REPLACE FUNCTION public.get_payroll_loyalty_bonus_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.treasury_controls;
  v_by text;
BEGIN
  IF NOT (public.is_payroll_loyalty_owner()
          OR public.has_role(v_uid, 'cto') OR public.has_role(v_uid, 'cfo')
          OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.treasury_controls WHERE control_key = 'payroll_loyalty_bonus_enabled';
  SELECT p.full_name INTO v_by FROM public.profiles p WHERE p.id = v_row.updated_by;

  RETURN jsonb_build_object(
    'enabled', coalesce(v_row.enabled, false),
    'can_change', public.is_payroll_loyalty_owner(),
    'updated_at', v_row.updated_at,
    'updated_by', v_by,
    'people_paid', (SELECT count(DISTINCT user_id) FROM public.payroll_growth_balances WHERE accrued_growth > 0),
    'total_paid', (SELECT coalesce(sum(accrued_growth), 0) FROM public.payroll_growth_balances),
    'active_people', (SELECT count(DISTINCT user_id) FROM public.payroll_growth_balances WHERE status = 'active' AND current_balance > 0),
    'active_balance', (SELECT coalesce(sum(current_balance), 0) FROM public.payroll_growth_balances WHERE status = 'active')
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.is_payroll_loyalty_owner(), public.guard_payroll_loyalty_bonus_switch(),
  public.set_payroll_loyalty_bonus(boolean, text), public.get_payroll_loyalty_bonus_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_payroll_loyalty_owner(), public.set_payroll_loyalty_bonus(boolean, text),
  public.get_payroll_loyalty_bonus_status() TO authenticated;

-- 6) Put the lock and the switch under the protected-function guard, so a rewrite is undone and emailed to the owner.
--    Skipped silently when the guard is not installed or is locked.
DO $protect$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.is_payroll_loyalty_owner()',
    'public.guard_payroll_loyalty_bonus_switch()',
    'public.set_payroll_loyalty_bonus(boolean,text)',
    'public.get_payroll_loyalty_bonus_status()'
  ] LOOP
    BEGIN
      PERFORM public.protect_function(f);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'not protected: % (%)', f, SQLERRM;
    END;
  END LOOP;
END
$protect$;
