-- Switch LC1 chairpersons to manual ops verification: remove auto-verify on registration
DROP TRIGGER IF EXISTS trg_auto_verify_lc1_chairperson ON public.lc1_chairpersons;
DROP FUNCTION IF EXISTS public.auto_verify_lc1_chairperson();