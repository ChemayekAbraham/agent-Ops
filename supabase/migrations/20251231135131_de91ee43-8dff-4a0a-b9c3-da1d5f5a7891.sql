-- Create table for review images
CREATE TABLE public.review_images (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES public.product_reviews(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.review_images ENABLE ROW LEVEL SECURITY;

-- Anyone can view review images
CREATE POLICY "Anyone can view review images"
ON public.review_images
FOR SELECT
USING (true);

-- Users can insert images for their own reviews
CREATE POLICY "Users can insert own review images"
ON public.review_images
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.product_reviews
    WHERE id = review_images.review_id
    AND buyer_id = auth.uid()
  )
);

-- Users can delete their own review images
CREATE POLICY "Users can delete own review images"
ON public.review_images
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.product_reviews
    WHERE id = review_images.review_id
    AND buyer_id = auth.uid()
  )
);

-- Create storage bucket for review images
INSERT INTO storage.buckets (id, name, public) 
VALUES ('reviews', 'reviews', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for review images
CREATE POLICY "Anyone can view review images storage"
ON storage.objects
FOR SELECT
USING (bucket_id = 'reviews');

CREATE POLICY "Authenticated users can upload review images"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'reviews' AND auth.role() = 'authenticated');

CREATE POLICY "Users can delete own review images storage"
ON storage.objects
FOR DELETE
USING (bucket_id = 'reviews' AND auth.uid()::text = (storage.foldername(name))[1]);