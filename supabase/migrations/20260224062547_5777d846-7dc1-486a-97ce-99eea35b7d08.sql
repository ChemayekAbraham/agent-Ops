-- Add mobile money name field to landlords table
ALTER TABLE public.landlords ADD COLUMN IF NOT EXISTS mobile_money_name text;