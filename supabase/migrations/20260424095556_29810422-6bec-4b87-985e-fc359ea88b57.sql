-- Idempotency guard: only one bonus approval row per listing.
-- Drop any pre-existing duplicates (keep earliest) before adding the constraint.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY listing_id ORDER BY created_at ASC, id ASC) AS rn
  FROM public.listing_bonus_approvals
)
DELETE FROM public.listing_bonus_approvals
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

ALTER TABLE public.listing_bonus_approvals
  ADD CONSTRAINT listing_bonus_approvals_listing_id_unique UNIQUE (listing_id);