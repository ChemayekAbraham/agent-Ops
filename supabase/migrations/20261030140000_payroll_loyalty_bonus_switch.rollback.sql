-- Rolls back 20261030140000_payroll_loyalty_bonus_switch.sql: removes the lock and the switch functions, then the switch row.
-- The functions are under the protected-function guard: set the unlock token for this session first
--   select set_config('welile.fn_unlock', '<your token>', true);   -- inside the same transaction
-- and un-protect them (unprotect_function) before dropping.
-- The edge function must be put back (or stop reading the switch) first, or the daily bonus stops, because a missing switch means "do not post".

BEGIN;
SELECT public.unprotect_function('public.is_payroll_loyalty_owner()');
SELECT public.unprotect_function('public.guard_payroll_loyalty_bonus_switch()');
SELECT public.unprotect_function('public.set_payroll_loyalty_bonus(boolean,text)');
SELECT public.unprotect_function('public.get_payroll_loyalty_bonus_status()');

DROP TRIGGER IF EXISTS trg_00_guard_payroll_loyalty_bonus_switch ON public.treasury_controls;
DELETE FROM public.treasury_controls WHERE control_key = 'payroll_loyalty_bonus_enabled';
DROP FUNCTION IF EXISTS public.get_payroll_loyalty_bonus_status();
DROP FUNCTION IF EXISTS public.set_payroll_loyalty_bonus(boolean, text);
DROP FUNCTION IF EXISTS public.guard_payroll_loyalty_bonus_switch();
DROP FUNCTION IF EXISTS public.is_payroll_loyalty_owner();
COMMIT;
