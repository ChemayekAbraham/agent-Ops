-- Roster correction: this desk (Benjamin Muhanguzi, +256708257899) is not an
-- operating merchant / cash-out desk. It has not handled a payout since
-- 2026-06-26 and holds no float, so it must not appear on the merchant float
-- board or receive payout dispatches.
UPDATE public.cashout_agents
SET is_active = false,
    updated_at = now()
WHERE id = '3e181dd5-1a4a-41fc-94fe-7015e345d963'
  AND is_active = true;