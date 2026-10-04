-- Add fulfillment status tracking to merchandise sales (smartphone & other orders)
ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS order_status text NOT NULL DEFAULT 'submitted';

ALTER TABLE public.merchandise_sales
  DROP CONSTRAINT IF EXISTS merchandise_sales_order_status_check;

ALTER TABLE public.merchandise_sales
  ADD CONSTRAINT merchandise_sales_order_status_check
  CHECK (order_status IN ('submitted', 'processing', 'completed', 'failed'));

-- Allow customers to read their own orders so they can see order status
GRANT SELECT ON public.merchandise_sales TO authenticated;
GRANT ALL ON public.merchandise_sales TO service_role;

DROP POLICY IF EXISTS "Customers can view their own merchandise orders" ON public.merchandise_sales;
CREATE POLICY "Customers can view their own merchandise orders"
  ON public.merchandise_sales
  FOR SELECT
  TO authenticated
  USING (customer_id = auth.uid());
