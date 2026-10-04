-- Enable realtime for product_orders table so buyers can see live status updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.product_orders;