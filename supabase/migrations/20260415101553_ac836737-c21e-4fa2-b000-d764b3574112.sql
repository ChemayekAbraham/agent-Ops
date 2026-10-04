
-- Add strict_mode column to treasury_controls so validate_ledger_category trigger works
ALTER TABLE public.treasury_controls ADD COLUMN IF NOT EXISTS strict_mode boolean DEFAULT false;
