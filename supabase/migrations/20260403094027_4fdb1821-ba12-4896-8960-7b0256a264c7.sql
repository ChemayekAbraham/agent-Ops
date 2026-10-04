
ALTER TABLE public.proxy_agent_assignments
  ADD COLUMN IF NOT EXISTS is_managed_account boolean NOT NULL DEFAULT false;

ALTER TABLE public.pending_wallet_operations
  ADD COLUMN IF NOT EXISTS target_wallet_user_id uuid REFERENCES public.profiles(id);
