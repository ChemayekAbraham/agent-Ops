
-- House reviews table with mandatory GPS coordinates
CREATE TABLE public.house_reviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  house_id UUID NOT NULL REFERENCES public.house_listings(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house_id, reviewer_id)
);

-- Enable RLS
ALTER TABLE public.house_reviews ENABLE ROW LEVEL SECURITY;

-- Anyone can read reviews
CREATE POLICY "Anyone can view house reviews"
  ON public.house_reviews FOR SELECT
  USING (true);

-- Authenticated users can create their own reviews
CREATE POLICY "Authenticated users can create reviews"
  ON public.house_reviews FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = reviewer_id);

-- Users can update their own reviews
CREATE POLICY "Users can update own reviews"
  ON public.house_reviews FOR UPDATE
  TO authenticated
  USING (auth.uid() = reviewer_id);

-- Users can delete their own reviews
CREATE POLICY "Users can delete own reviews"
  ON public.house_reviews FOR DELETE
  TO authenticated
  USING (auth.uid() = reviewer_id);

-- Index for fast lookups
CREATE INDEX idx_house_reviews_house_id ON public.house_reviews(house_id);
CREATE INDEX idx_house_reviews_reviewer_id ON public.house_reviews(reviewer_id);

-- Trigger for updated_at
CREATE TRIGGER update_house_reviews_updated_at
  BEFORE UPDATE ON public.house_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
