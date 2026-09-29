-- STATUS: STAGED, NOT APPLIED. Do not apply without explicit deployment approval.
-- Validation-only fix for the installed four-part Rent Plan repayment split.
-- The approved split calculation and all posting behaviour remain unchanged.
-- Platform Fee is the complete fee pool: Access Fee + Registration Fee.

ALTER TABLE public.instalment_allocations
  DROP CONSTRAINT access_split_reconciles;

ALTER TABLE public.instalment_allocations
  ADD CONSTRAINT access_split_reconciles CHECK (
    (partner_reward_component IS NULL
      AND agent_commission_component IS NULL
      AND platform_net_component IS NULL)
    OR (partner_reward_component IS NOT NULL
      AND agent_commission_component IS NOT NULL
      AND platform_net_component IS NOT NULL
      AND partner_reward_component + agent_commission_component + platform_net_component
        = access_fee_component + registration_fee_component)
  );