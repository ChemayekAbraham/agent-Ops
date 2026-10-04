-- Add frozen columns to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_frozen boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS frozen_reason text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS frozen_at timestamptz;