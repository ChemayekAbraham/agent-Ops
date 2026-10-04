ALTER TABLE public.tenant_transfers
  ADD COLUMN IF NOT EXISTS actor_latitude double precision,
  ADD COLUMN IF NOT EXISTS actor_longitude double precision,
  ADD COLUMN IF NOT EXISTS actor_accuracy double precision,
  ADD COLUMN IF NOT EXISTS actor_location_status text;

ALTER TABLE public.tenant_transfers
  DROP CONSTRAINT IF EXISTS tenant_transfers_actor_location_status_check;

ALTER TABLE public.tenant_transfers
  ADD CONSTRAINT tenant_transfers_actor_location_status_check
  CHECK (actor_location_status IS NULL OR actor_location_status IN ('captured','denied','unavailable','timeout','unsupported'));