-- Create table for storing user locations
CREATE TABLE public.user_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  address TEXT,
  city TEXT,
  country TEXT,
  captured_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  verified BOOLEAN DEFAULT false,
  verified_by UUID REFERENCES auth.users(id),
  verified_at TIMESTAMP WITH TIME ZONE,
  verification_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for faster lookups
CREATE INDEX idx_user_locations_user_id ON public.user_locations(user_id);
CREATE INDEX idx_user_locations_captured_at ON public.user_locations(captured_at DESC);

-- Enable RLS
ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;

-- Users can insert their own location
CREATE POLICY "Users can insert own location"
  ON public.user_locations FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can view their own locations
CREATE POLICY "Users can view own locations"
  ON public.user_locations FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'manager'::app_role));

-- Managers can update locations (for verification)
CREATE POLICY "Managers can update locations"
  ON public.user_locations FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'::app_role));

-- Managers can delete locations
CREATE POLICY "Managers can delete locations"
  ON public.user_locations FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'::app_role));