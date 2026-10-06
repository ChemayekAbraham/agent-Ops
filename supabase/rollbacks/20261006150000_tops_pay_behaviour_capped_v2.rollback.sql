-- Rollback for 20261006150000_tops_pay_behaviour_capped_v2.sql
-- That migration only ADDED functions (the original tops_pay_behaviour_* and tops_payment_behaviour_* functions
-- from 20261006100000 to 20261006140000 were not touched), so rolling back is just dropping the new ones.
-- Dropping them returns the Payment Behavior tab's source to the original reports only if usePaymentBehavior.ts
-- is also pointed back at them (see git history of src/hooks/tenantOpsWorkspace/usePaymentBehavior.ts).
-- Drop the reports first, then the helpers they call.

DROP FUNCTION IF EXISTS public.tops_payment_behaviour_watchlist_v2(timestamptz, timestamptz, uuid, text, text, text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.tops_payment_behaviour_by_v2(timestamptz, timestamptz, text, uuid, text, text, text, int);
DROP FUNCTION IF EXISTS public.tops_payment_behaviour_timing_v2(timestamptz, timestamptz, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.tops_payment_behaviour_trend_v2(timestamptz, timestamptz, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.tops_payment_behaviour_overview_v2(timestamptz, timestamptz, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.tops_payment_behaviour_summary_v2(timestamptz, timestamptz, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.tops_pay_behaviour_plans_capped(timestamptz, timestamptz, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.tops_pay_behaviour_payments_capped(timestamptz, timestamptz, uuid, text, text, text);
