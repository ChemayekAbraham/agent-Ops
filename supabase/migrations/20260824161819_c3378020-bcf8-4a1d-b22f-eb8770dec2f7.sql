ALTER TABLE public.merchandise_sales DROP CONSTRAINT IF EXISTS merchandise_sales_order_status_check;
ALTER TABLE public.merchandise_sales ADD CONSTRAINT merchandise_sales_order_status_check
  CHECK (order_status = ANY (ARRAY['pending_approval'::text,'submitted'::text,'approved'::text,'processing'::text,'completed'::text,'failed'::text,'rejected'::text]));