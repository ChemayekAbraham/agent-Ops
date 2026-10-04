-- Drop the buggy 4-argument overload of agent_allocate_tenant_payment.
-- Its body called create_ledger_transaction('agent_tenant_float_allocation', legs),
-- which resolved to the (uuid, jsonb, ...) overload and raised
-- "invalid input syntax for type uuid: agent_tenant_float_allocation".
-- Nothing calls this overload anymore (the app and the offline-collection edge
-- function both use the 5-arg version, which is already fixed). Removing it
-- eliminates the overload-resolution landmine.
DROP FUNCTION IF EXISTS public.agent_allocate_tenant_payment(
  p_agent_id uuid,
  p_rent_request_id uuid,
  p_amount numeric,
  p_description text
);