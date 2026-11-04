-- =============================================================================
-- Rollback: 20261023120000_landlord_calling_center_foundation.rollback.sql
-- =============================================================================

DROP FUNCTION IF EXISTS public.landlord_cc_assign_callers(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.landlord_cc_list_queues();
DROP FUNCTION IF EXISTS public.landlord_cc_save_queue(text, jsonb, text, boolean, uuid);

DROP TABLE IF EXISTS public.landlord_cc_saved_queues;
DROP TABLE IF EXISTS public.landlord_cc_row_assignments;

DELETE FROM public.cc_feedback_categories
WHERE code IN (
  'reached_ok',
  'confirmed_payout_number',
  'wants_more_tenants',
  'complaint',
  'payout_issue',
  'not_landlord',
  'wrong_number'
)
AND applies_to = ARRAY['landlord'::cc_subject_type];

DELETE FROM public.cc_sort_options
WHERE subject_type = 'landlord'::cc_subject_type
  AND key IN (
    'highest_rent_plan_value',
    'last_called_at',
    'oldest_call_first',
    'registered_at',
    'newest_registration'
  );

DELETE FROM public.cc_filter_options
WHERE subject_type = 'landlord'::cc_subject_type
  AND key IN ('region', 'district', 'registering_agent');

DELETE FROM public.cc_cycle_populations
WHERE subject_type = 'landlord'::cc_subject_type
  AND code IN (
    'landlords_registry_all',
    'landlords_never_called',
    'landlords_active_plans',
    'landlords_paid_30d',
    'landlords_unverified',
    'landlords_no_houses',
    'landlords_not_called_30d',
    'landlords_not_called_60d',
    'landlords_not_called_90d'
  );

DROP VIEW IF EXISTS public.v_landlord_registry_all;
DROP FUNCTION IF EXISTS public.normalize_landlord_phone_256(text);
DROP FUNCTION IF EXISTS public._landlord_cc_staff_ok();
