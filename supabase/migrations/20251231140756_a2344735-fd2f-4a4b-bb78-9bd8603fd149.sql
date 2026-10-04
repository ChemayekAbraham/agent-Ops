-- Create table for seller responses to reviews
CREATE TABLE public.review_responses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES public.product_reviews(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  response_text TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add unique constraint so each review can only have one response
ALTER TABLE public.review_responses ADD CONSTRAINT unique_review_response UNIQUE (review_id);

-- Enable RLS
ALTER TABLE public.review_responses ENABLE ROW LEVEL SECURITY;

-- Anyone can view responses
CREATE POLICY "Anyone can view review responses"
ON public.review_responses
FOR SELECT
USING (true);

-- Agents can insert responses for reviews on their products
CREATE POLICY "Agents can respond to reviews on their products"
ON public.review_responses
FOR INSERT
WITH CHECK (
  auth.uid() = agent_id AND
  EXISTS (
    SELECT 1 FROM public.product_reviews pr
    JOIN public.products p ON p.id = pr.product_id
    WHERE pr.id = review_responses.review_id
    AND p.agent_id = auth.uid()
  )
);

-- Agents can update their own responses
CREATE POLICY "Agents can update own responses"
ON public.review_responses
FOR UPDATE
USING (auth.uid() = agent_id);

-- Agents can delete their own responses
CREATE POLICY "Agents can delete own responses"
ON public.review_responses
FOR DELETE
USING (auth.uid() = agent_id);

-- Create trigger for updating updated_at
CREATE TRIGGER update_review_responses_updated_at
BEFORE UPDATE ON public.review_responses
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();