-- Rollback for 20261024170000_rent_reward_atomic_post.sql.                                   NOT APPLIED.
-- Redeploy the previous process-supporter-roi FIRST (it does not call the new function), then run this.
-- Payment rows and ledger postings made through the new function stay as they are (financial records are preserved).
BEGIN;
DROP FUNCTION IF EXISTS public.post_rent_facilitation_reward(uuid, integer, uuid, text);
DROP FUNCTION IF EXISTS public.rent_reward_posting_gaps();
DROP INDEX IF EXISTS public.supporter_roi_payments_rent_request_payment_uniq;
COMMIT;
