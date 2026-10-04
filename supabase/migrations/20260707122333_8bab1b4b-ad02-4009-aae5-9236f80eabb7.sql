
CREATE TABLE public.merchandise_purchases (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  item_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost numeric NOT NULL CHECK (unit_cost >= 0),
  total_cost numeric NOT NULL CHECK (total_cost >= 0),
  purchase_date date NOT NULL DEFAULT current_date,
  supplier text,
  notes text,
  created_by uuid REFERENCES auth.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.merchandise_sales (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  item_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric NOT NULL CHECK (unit_price >= 0),
  unit_cost numeric NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  total_revenue numeric NOT NULL CHECK (total_revenue >= 0),
  client_name text,
  client_phone text,
  payment_status text NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('paid','credit','partial')),
  amount_paid numeric NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  amount_outstanding numeric NOT NULL DEFAULT 0 CHECK (amount_outstanding >= 0),
  sale_date date NOT NULL DEFAULT current_date,
  notes text,
  created_by uuid REFERENCES auth.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_purchases TO authenticated;
GRANT ALL ON public.merchandise_purchases TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_sales TO authenticated;
GRANT ALL ON public.merchandise_sales TO service_role;

ALTER TABLE public.merchandise_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchandise_sales ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Marketing leadership manage merchandise purchases"
ON public.merchandise_purchases FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'cmo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'cmo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Marketing leadership manage merchandise sales"
ON public.merchandise_sales FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'cmo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'cmo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE TRIGGER update_merchandise_purchases_updated_at
BEFORE UPDATE ON public.merchandise_purchases
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_merchandise_sales_updated_at
BEFORE UPDATE ON public.merchandise_sales
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_merchandise_purchases_date ON public.merchandise_purchases(purchase_date);
CREATE INDEX idx_merchandise_purchases_item ON public.merchandise_purchases(item_name);
CREATE INDEX idx_merchandise_sales_date ON public.merchandise_sales(sale_date);
CREATE INDEX idx_merchandise_sales_item ON public.merchandise_sales(item_name);
CREATE INDEX idx_merchandise_sales_client ON public.merchandise_sales(client_phone);
