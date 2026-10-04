-- Create products table for agent marketplace
CREATE TABLE public.products (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC NOT NULL CHECK (price > 0),
  category TEXT NOT NULL DEFAULT 'general',
  image_url TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create product orders table
CREATE TABLE public.product_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  buyer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price NUMERIC NOT NULL,
  total_price NUMERIC NOT NULL,
  agent_commission NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_orders ENABLE ROW LEVEL SECURITY;

-- Products RLS policies
CREATE POLICY "Anyone can view active products"
ON public.products
FOR SELECT
USING (active = true);

CREATE POLICY "Agents can manage own products"
ON public.products
FOR ALL
USING (has_role(auth.uid(), 'agent') AND agent_id = auth.uid())
WITH CHECK (has_role(auth.uid(), 'agent') AND agent_id = auth.uid());

CREATE POLICY "Managers can view all products"
ON public.products
FOR SELECT
USING (has_role(auth.uid(), 'manager'));

-- Product orders RLS policies
CREATE POLICY "Buyers can view own orders"
ON public.product_orders
FOR SELECT
USING (auth.uid() = buyer_id);

CREATE POLICY "Agents can view own sales"
ON public.product_orders
FOR SELECT
USING (auth.uid() = agent_id);

CREATE POLICY "Managers can view all orders"
ON public.product_orders
FOR SELECT
USING (has_role(auth.uid(), 'manager'));

CREATE POLICY "System can insert orders"
ON public.product_orders
FOR INSERT
WITH CHECK (true);

-- Add trigger for updated_at on products
CREATE TRIGGER update_products_updated_at
BEFORE UPDATE ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();