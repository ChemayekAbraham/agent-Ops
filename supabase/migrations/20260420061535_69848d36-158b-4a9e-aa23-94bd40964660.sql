
-- Allow 'cancelled' status on pending_wallet_operations
ALTER TABLE public.pending_wallet_operations
  DROP CONSTRAINT IF EXISTS pending_wallet_operations_status_check;

ALTER TABLE public.pending_wallet_operations
  ADD CONSTRAINT pending_wallet_operations_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'approved'::text,
    'rejected'::text,
    'awaiting_verification'::text,
    'completed'::text,
    'pending_coo_approval'::text,
    'coo_approved'::text,
    'cancelled'::text
  ]));
