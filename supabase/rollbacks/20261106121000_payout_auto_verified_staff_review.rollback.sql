DROP FUNCTION IF EXISTS public.finops_mark_auto_verified_reviewed(uuid, text);
DROP FUNCTION IF EXISTS public.finops_auto_verified_review_queue(text, integer, integer);
DROP FUNCTION IF EXISTS public.finops_auto_verified_review_count();
DROP TABLE IF EXISTS public.payout_destination_staff_reviews;
