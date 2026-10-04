ALTER TABLE public.rent_requests DROP CONSTRAINT IF EXISTS rent_requests_status_check;
ALTER TABLE public.rent_requests ADD CONSTRAINT rent_requests_status_check
CHECK (status = ANY (ARRAY[
  'pending'::text,
  'approved'::text,
  'rejected'::text,
  'cancelled'::text,
  'agent_ops_approved'::text,
  'tenant_ops_approved'::text,
  'agent_verified'::text,
  'landlord_ops_approved'::text,
  'coo_approved'::text,
  'funded'::text,
  'disbursed'::text,
  'repaying'::text,
  'fully_repaid'::text,
  'defaulted'::text,
  'completed'::text
]));