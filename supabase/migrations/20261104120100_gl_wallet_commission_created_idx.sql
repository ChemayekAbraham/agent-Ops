-- Covering partial index for the wallet commission scan in get_agent_ops_overview.
--
-- UNMEASURED. This file was not applied, and the index was not timed.
-- On 2026-11-04 the live 365-day scan of idx_general_ledger_created_at
-- visited the whole created_at range and then discarded about 667,000 rows
-- that are not wallet commission legs (246,221 shared buffer hits for
-- 157,847 matching rows). A partial index on those six categories would
-- not contain those rows. Whether the planner picks it, and what that does
-- to the 561 ms single pass, was not measured.
--
-- Do not use CONCURRENTLY here: this migration runs inside a transaction.
-- CREATE INDEX takes ShareLock on general_ledger until the build finishes.
-- The heap is about 334 MB and about 158,000 rows match the predicate.
-- lock_timeout fails the build instead of waiting out a busy ledger.

SET lock_timeout = '5s';

CREATE INDEX idx_gl_wallet_commission_created
  ON public.general_ledger (created_at)
  INCLUDE (user_id, category, direction, amount)
  WHERE ledger_scope = 'wallet'
    AND category IN (
      'agent_commission_earned',
      'agent_commission',
      'agent_bonus',
      'agent_investment_commission',
      'proxy_investment_commission',
      'partner_commission'
    );
