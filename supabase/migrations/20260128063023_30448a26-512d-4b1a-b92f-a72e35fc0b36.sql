-- Add whatsapp_verified column to profiles table
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS whatsapp_verified boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS whatsapp_verified_at timestamp with time zone;