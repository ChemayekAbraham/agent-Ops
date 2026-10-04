ALTER TABLE public.listing_bonus_approvals
  DROP CONSTRAINT IF EXISTS listing_bonus_status_check;

ALTER TABLE public.listing_bonus_approvals
  ADD CONSTRAINT listing_bonus_status_check
  CHECK (status = ANY (ARRAY[
    'pending_landlord_ops'::text,
    'pending_cfo'::text,
    'pending_credit'::text,
    'approved'::text,
    'paid'::text,
    'rejected'::text,
    'failed'::text
  ]));