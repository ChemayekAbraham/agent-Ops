-- Add estimated delivery date column to product_orders
ALTER TABLE public.product_orders 
ADD COLUMN IF NOT EXISTS estimated_delivery_date DATE;