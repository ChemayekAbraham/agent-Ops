ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'admin';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'tenant_ops';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'landlord_ops';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'agent_ops';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'financial_ops';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'partner_ops';