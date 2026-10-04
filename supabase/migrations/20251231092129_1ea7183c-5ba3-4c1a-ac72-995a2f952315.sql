-- Add discount fields to products table
ALTER TABLE public.products
ADD COLUMN discount_percentage INTEGER DEFAULT 0 CHECK (discount_percentage >= 0 AND discount_percentage <= 100),
ADD COLUMN discount_ends_at TIMESTAMP WITH TIME ZONE;