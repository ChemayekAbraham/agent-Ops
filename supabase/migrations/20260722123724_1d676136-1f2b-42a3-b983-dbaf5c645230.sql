-- Add missing 'senior_agent' value to app_role enum so the withdrawal
-- performance-gate trigger (which references 'senior_agent'::app_role) no
-- longer errors out during withdrawal confirmation.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'senior_agent';