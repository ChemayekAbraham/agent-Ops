ALTER TABLE public.pending_wallet_operations
  ADD COLUMN operation_type text NOT NULL DEFAULT 'standard';