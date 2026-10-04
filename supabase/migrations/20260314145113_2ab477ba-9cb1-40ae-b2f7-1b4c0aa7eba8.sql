
-- House listings table for daily rental marketplace
CREATE TABLE public.house_listings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  landlord_id UUID REFERENCES public.landlords(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL,
  
  -- Property details
  title TEXT NOT NULL,
  description TEXT,
  house_category TEXT NOT NULL DEFAULT 'single_room',
  number_of_rooms INTEGER NOT NULL DEFAULT 1,
  monthly_rent INTEGER NOT NULL,
  
  -- Computed daily rate fields (rent + 33% access fee + platform fee) / 30
  daily_rate INTEGER NOT NULL DEFAULT 0,
  access_fee INTEGER NOT NULL DEFAULT 0,
  platform_fee INTEGER NOT NULL DEFAULT 0,
  total_monthly_cost INTEGER NOT NULL DEFAULT 0,
  
  -- Location
  region TEXT NOT NULL,
  district TEXT,
  sub_county TEXT,
  village TEXT,
  address TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  
  -- Specs
  has_water BOOLEAN DEFAULT false,
  has_electricity BOOLEAN DEFAULT false,
  has_security BOOLEAN DEFAULT false,
  has_parking BOOLEAN DEFAULT false,
  is_furnished BOOLEAN DEFAULT false,
  amenities TEXT[],
  
  -- Images
  image_urls TEXT[],
  
  -- Status
  status TEXT NOT NULL DEFAULT 'available',
  tenant_id UUID,
  landlord_accepted BOOLEAN DEFAULT false,
  verified BOOLEAN DEFAULT false,
  verified_by UUID,
  verified_at TIMESTAMPTZ,
  
  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for search performance at scale
CREATE INDEX idx_house_listings_region ON public.house_listings(region);
CREATE INDEX idx_house_listings_status ON public.house_listings(status);
CREATE INDEX idx_house_listings_daily_rate ON public.house_listings(daily_rate);
CREATE INDEX idx_house_listings_agent_id ON public.house_listings(agent_id);
CREATE INDEX idx_house_listings_landlord_id ON public.house_listings(landlord_id);
CREATE INDEX idx_house_listings_region_status ON public.house_listings(region, status);
CREATE INDEX idx_house_listings_category ON public.house_listings(house_category);

-- GIN index for text search
CREATE INDEX idx_house_listings_search ON public.house_listings USING GIN (
  (region || ' ' || COALESCE(district, '') || ' ' || COALESCE(village, '') || ' ' || address) gin_trgm_ops
);

-- Enable RLS
ALTER TABLE public.house_listings ENABLE ROW LEVEL SECURITY;

-- Anyone can view available listings (public marketplace)
CREATE POLICY "Anyone can view available listings"
ON public.house_listings FOR SELECT
USING (status = 'available' OR auth.uid() = agent_id OR auth.uid() = tenant_id);

-- Agents can insert listings
CREATE POLICY "Agents can insert listings"
ON public.house_listings FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = agent_id);

-- Agents can update their own listings
CREATE POLICY "Agents can update own listings"
ON public.house_listings FOR UPDATE
TO authenticated
USING (auth.uid() = agent_id);
