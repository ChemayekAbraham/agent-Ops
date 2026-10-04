ALTER TABLE public.wallet_balances_projection
  ADD COLUMN IF NOT EXISTS float_balance_raw numeric NOT NULL DEFAULT 0;