-- Create product_images table for gallery
CREATE TABLE public.product_images (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;

-- Anyone can view product images
CREATE POLICY "Anyone can view product images" ON public.product_images
  FOR SELECT USING (true);

-- Agents can manage images for their own products
CREATE POLICY "Agents can insert product images" ON public.product_images
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.products
      WHERE id = product_id AND agent_id = auth.uid()
    )
  );

CREATE POLICY "Agents can update product images" ON public.product_images
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.products
      WHERE id = product_id AND agent_id = auth.uid()
    )
  );

CREATE POLICY "Agents can delete product images" ON public.product_images
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.products
      WHERE id = product_id AND agent_id = auth.uid()
    )
  );

-- Create index for faster queries
CREATE INDEX idx_product_images_product_id ON public.product_images(product_id, display_order);