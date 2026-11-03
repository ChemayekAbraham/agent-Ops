-- =============================================================================
-- Rollback: 20261026000000_staff_assistant_read_tools_batch1.rollback.sql
-- Reverses: 20261026000000_staff_assistant_read_tools_batch1.sql
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.assistant_staff_lops_calling_coverage(timestamptz);
DROP FUNCTION IF EXISTS public.assistant_staff_lops_calling_summary(date, date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_lops_principal_comparison(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_lops_paid_lists(text, text, integer, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_lops_home_range(date, date);

DROP FUNCTION IF EXISTS public.assistant_staff_tops_rent_request_lifetime();
DROP FUNCTION IF EXISTS public.assistant_staff_tops_no_payment_report(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_tops_weekly_performance(date);
DROP FUNCTION IF EXISTS public.assistant_staff_tops_smartphone_usage(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_tops_tenant_classification();
DROP FUNCTION IF EXISTS public.assistant_staff_tops_landlord_not_paid(date, integer, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_tops_arrears_ageing(date, text, integer, integer, text);
DROP FUNCTION IF EXISTS public.assistant_staff_tops_first_seven_summary(date, date, text);

DROP FUNCTION IF EXISTS public.assistant_staff_my_wallet();
DROP FUNCTION IF EXISTS public.assistant_staff_my_canteen(date);
DROP FUNCTION IF EXISTS public.assistant_staff_my_pending_concerns();
DROP FUNCTION IF EXISTS public.assistant_staff_my_advances();
DROP FUNCTION IF EXISTS public.assistant_staff_my_requisitions();
DROP FUNCTION IF EXISTS public.assistant_staff_my_tickets();
DROP FUNCTION IF EXISTS public.assistant_staff_my_tasks(text);
DROP FUNCTION IF EXISTS public.assistant_staff_my_payslips();
DROP FUNCTION IF EXISTS public.assistant_staff_my_profile();

DROP FUNCTION IF EXISTS public.staff_assistant_sanitize_jsonb(jsonb, boolean, integer);
DROP FUNCTION IF EXISTS public.staff_assistant_mask_nin(text, boolean);
DROP FUNCTION IF EXISTS public.staff_assistant_mask_phone(text, boolean);
DROP FUNCTION IF EXISTS public.staff_assistant_can_view_pii(text);

COMMIT;
