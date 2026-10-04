
-- Create universal user reviews table
CREATE TABLE public.user_reviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reviewer_id UUID NOT NULL,
  reviewed_user_id UUID NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  reviewer_role TEXT, -- role at time of review: 'agent', 'landlord', 'tenant', 'supporter'
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(reviewer_id, reviewed_user_id)
);

-- Enable RLS
ALTER TABLE public.user_reviews ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read reviews (public visibility for trust)
CREATE POLICY "Anyone can view reviews"
ON public.user_reviews
FOR SELECT
USING (true);

-- Users can create reviews for others (not themselves)
CREATE POLICY "Authenticated users can create reviews"
ON public.user_reviews
FOR INSERT
WITH CHECK (auth.uid() = reviewer_id AND auth.uid() != reviewed_user_id);

-- Users can update only their own reviews
CREATE POLICY "Users can update their own reviews"
ON public.user_reviews
FOR UPDATE
USING (auth.uid() = reviewer_id);

-- Users can delete only their own reviews
CREATE POLICY "Users can delete their own reviews"
ON public.user_reviews
FOR DELETE
USING (auth.uid() = reviewer_id);

-- Create indexes for fast lookups
CREATE INDEX idx_user_reviews_reviewed_user ON public.user_reviews(reviewed_user_id);
CREATE INDEX idx_user_reviews_reviewer ON public.user_reviews(reviewer_id);

-- Enable realtime for reviews
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_reviews;

-- Trigger for updated_at
CREATE TRIGGER update_user_reviews_updated_at
BEFORE UPDATE ON public.user_reviews
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
