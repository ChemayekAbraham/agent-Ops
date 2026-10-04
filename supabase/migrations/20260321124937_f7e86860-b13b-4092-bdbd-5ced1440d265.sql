ALTER TABLE public.rent_requests DROP CONSTRAINT rent_requests_status_check;

ALTER TABLE public.rent_requests ADD CONSTRAINT rent_requests_status_check CHECK (status = ANY (ARRAY[
  'pending',
  'approved',
  'rejected',
  'tenant_ops_approved',
  'agent_verified',
  'landlord_ops_approved',
  'coo_approved',
  'funded',
  'disbursed',
  'repaying',
  'fully_repaid',
  'defaulted',
  'completed'
]));