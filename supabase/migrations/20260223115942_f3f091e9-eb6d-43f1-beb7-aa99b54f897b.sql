
-- Add charge_agent_wallet flag to subscription_charges
-- When true, the auto-charge system will skip tenant wallet and charge the agent directly
ALTER TABLE public.subscription_charges 
ADD COLUMN IF NOT EXISTS charge_agent_wallet boolean NOT NULL DEFAULT false;

-- Add no_smartphone flag to rent_requests to track tenants without smartphones
ALTER TABLE public.rent_requests
ADD COLUMN IF NOT EXISTS tenant_no_smartphone boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.subscription_charges.charge_agent_wallet IS 'When true, auto-charge skips tenant wallet and charges the linked agent directly';
COMMENT ON COLUMN public.rent_requests.tenant_no_smartphone IS 'True if tenant was registered without a smartphone - agent handles repayments';
