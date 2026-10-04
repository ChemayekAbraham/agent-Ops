-- Add tenant_failed_at to track when a tenant first failed to pay
-- After 72 hours of this timestamp, agent will be charged
ALTER TABLE public.subscription_charges
ADD COLUMN IF NOT EXISTS tenant_failed_at TIMESTAMPTZ DEFAULT NULL;

-- Add comment for clarity
COMMENT ON COLUMN public.subscription_charges.tenant_failed_at IS 'Timestamp when tenant first failed to pay. Agent is charged after 72 hours of this.';
