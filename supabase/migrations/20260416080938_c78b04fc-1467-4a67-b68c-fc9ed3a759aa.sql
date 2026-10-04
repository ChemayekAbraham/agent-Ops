
-- Add deposit_purpose enum type
CREATE TYPE public.deposit_purpose AS ENUM (
  'operational_float',
  'personal_deposit',
  'partnership_deposit',
  'personal_rent_repayment',
  'other'
);

-- Add deposit_purpose column to deposit_requests
ALTER TABLE public.deposit_requests
ADD COLUMN deposit_purpose public.deposit_purpose NOT NULL DEFAULT 'other';
