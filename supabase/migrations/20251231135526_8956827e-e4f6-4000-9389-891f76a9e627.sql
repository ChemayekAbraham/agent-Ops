-- Create review_votes table for upvote/downvote functionality
CREATE TABLE public.review_votes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES public.product_reviews(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('upvote', 'downvote')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (review_id, user_id)
);

-- Enable RLS
ALTER TABLE public.review_votes ENABLE ROW LEVEL SECURITY;

-- Anyone can view vote counts
CREATE POLICY "Anyone can view votes"
ON public.review_votes
FOR SELECT
USING (true);

-- Authenticated users can vote
CREATE POLICY "Users can vote on reviews"
ON public.review_votes
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can update their own votes
CREATE POLICY "Users can update own votes"
ON public.review_votes
FOR UPDATE
USING (auth.uid() = user_id);

-- Users can remove their own votes
CREATE POLICY "Users can remove own votes"
ON public.review_votes
FOR DELETE
USING (auth.uid() = user_id);

-- Create index for faster vote counting
CREATE INDEX idx_review_votes_review_id ON public.review_votes(review_id);
CREATE INDEX idx_review_votes_user_id ON public.review_votes(user_id);