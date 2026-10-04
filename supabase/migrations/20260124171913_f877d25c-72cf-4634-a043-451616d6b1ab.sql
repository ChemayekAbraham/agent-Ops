-- Add last_active_at column to profiles table
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- Update existing users to have their created_at as last_active_at
UPDATE public.profiles 
SET last_active_at = COALESCE(updated_at, created_at) 
WHERE last_active_at IS NULL;

-- Create index for efficient querying of inactive users
CREATE INDEX IF NOT EXISTS idx_profiles_last_active_at ON public.profiles(last_active_at DESC);

-- Create a function to update last_active_at on login
CREATE OR REPLACE FUNCTION public.update_last_active_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.profiles 
  SET last_active_at = now(), updated_at = now()
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;