
-- Drop the OLD 4-parameter overload of credit_agent_rent_commission
-- This version used (p_rent_request_id, p_repayment_amount, p_source_table, p_source_id) with 5% rate
-- Keep only the NEW 3-parameter version (p_rent_request_id, p_repayment_amount, p_tenant_id) with 10% rate
DROP FUNCTION IF EXISTS public.credit_agent_rent_commission(uuid, numeric, text, text);
