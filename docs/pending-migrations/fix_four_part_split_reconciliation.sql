-- STATUS: STAGED, NOT APPLIED. Do not apply without explicit deployment approval.
-- Version-aware validation fix for the four-part Rent Plan repayment split.
-- The approved split calculation and all posting behaviour remain unchanged.
-- Four-part rows (split_version = 'four_part_v1'): Platform Fee is the complete fee pool,
--   Returns + Agent Commission + Platform Fee = Access Fee + Registration Fee.
-- All other rows (earlier fee split, incl. the 49 records of 17-28 Sep 2026) keep the
--   existing rule unchanged: the three fee parts = Access Fee. No record is modified.

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
      AND CASE WHEN split_version IS NOT DISTINCT FROM 'four_part_v1'
            THEN partner_reward_component + agent_commission_component + platform_net_component
                   = access_fee_component + registration_fee_component
            ELSE partner_reward_component + agent_commission_component + platform_net_component
                   = access_fee_component
          END)
  );
