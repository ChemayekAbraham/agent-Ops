-- PHASE 1 (2/5): prospective instalment traceability spine.
-- Records only. No ledger posting, no economics, no historical backfill.
-- Partner/agent/platform-net columns stay NULL until BD-2/BD-3 are resolved.

CREATE TABLE IF NOT EXISTS public.instalment_allocations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id             uuid NOT NULL REFERENCES public.rent_requests(id),
  transaction_group_id        uuid,
  instalment_id               uuid NOT NULL DEFAULT gen_random_uuid(),
  instalment_date             timestamptz NOT NULL DEFAULT now(),
  instalment_amount           numeric(20,2) NOT NULL,
  principal_component         numeric(20,2) NOT NULL,
  registration_fee_component  numeric(20,2) NOT NULL,
  access_fee_component        numeric(20,2) NOT NULL,
  -- Allocation of the access fee. NULL until the business decisions land.
  partner_reward_component    numeric(20,2),
  agent_commission_component  numeric(20,2),
  platform_net_component      numeric(20,2),
  source_table                text,
  source_id                   uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  -- Exact shilling reconciliation. NUMERIC only; no floating point anywhere.
  CONSTRAINT instalment_components_reconcile
    CHECK (principal_component + registration_fee_component + access_fee_component = instalment_amount),
  CONSTRAINT instalment_components_non_negative
    CHECK (principal_component >= 0 AND registration_fee_component >= 0
           AND access_fee_component >= 0 AND instalment_amount >= 0),
  -- If (and only if) the access split is fully populated it must foot to the access fee.
  CONSTRAINT access_split_reconciles CHECK (
    (partner_reward_component IS NULL AND agent_commission_component IS NULL AND platform_net_component IS NULL)
    OR (partner_reward_component IS NOT NULL AND agent_commission_component IS NOT NULL
        AND platform_net_component IS NOT NULL
        AND partner_reward_component + agent_commission_component + platform_net_component = access_fee_component)
  )
);

CREATE INDEX IF NOT EXISTS idx_instalment_alloc_rr    ON public.instalment_allocations(rent_request_id);
CREATE INDEX IF NOT EXISTS idx_instalment_alloc_group ON public.instalment_allocations(transaction_group_id);
CREATE INDEX IF NOT EXISTS idx_instalment_alloc_date  ON public.instalment_allocations(instalment_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_instalment_alloc_source
  ON public.instalment_allocations(rent_request_id, source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

ALTER TABLE public.instalment_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instalment_alloc_staff_read ON public.instalment_allocations;
CREATE POLICY instalment_alloc_staff_read ON public.instalment_allocations
  FOR SELECT USING (
    public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'financial_ops') OR public.has_role(auth.uid(),'super_admin')
    OR public.has_role(auth.uid(),'cto'));

COMMENT ON TABLE public.instalment_allocations IS
  'Prospective per-instalment decomposition for the Landlord Float -> Platform Treasury model. '
  'Populated only by new postings. Historical instalments are deliberately absent and are '
  'legacy/unreconstructable — do not backfill by inference.';
