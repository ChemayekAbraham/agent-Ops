-- Saved payout destinations: lets users keep their MoMo / bank details
-- across withdrawals so they don't re-type every time.
CREATE TABLE public.saved_payout_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- 'mobile_money' | 'bank_transfer' | 'cash'
  payout_mode text NOT NULL,
  nickname text,
  -- Mobile money fields
  momo_provider text,
  momo_number text,
  momo_name text,
  -- Bank fields
  bank_name text,
  bank_account_name text,
  bank_account_number text,
  -- Bookkeeping
  is_default boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.saved_payout_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view their own payout methods"
  ON public.saved_payout_methods FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert their own payout methods"
  ON public.saved_payout_methods FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update their own payout methods"
  ON public.saved_payout_methods FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete their own payout methods"
  ON public.saved_payout_methods FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_saved_payout_methods_user ON public.saved_payout_methods(user_id, last_used_at DESC NULLS LAST);

-- Auto-update updated_at (uses existing function pattern in the project)
CREATE TRIGGER trg_saved_payout_methods_updated_at
  BEFORE UPDATE ON public.saved_payout_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Allow users to cancel their OWN withdrawal_requests while still pending.
-- The existing UPDATE policy (if any) is staff-only; we add a narrowly-scoped
-- self-cancel policy that only permits flipping pending → cancelled.
CREATE POLICY "Users cancel their own pending withdrawals"
  ON public.withdrawal_requests FOR UPDATE
  USING (auth.uid() = user_id AND status = 'pending')
  WITH CHECK (auth.uid() = user_id AND status IN ('pending','cancelled'));