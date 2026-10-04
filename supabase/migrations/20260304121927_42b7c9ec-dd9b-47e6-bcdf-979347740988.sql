
-- Fix search_path for generate_portfolio_code
CREATE OR REPLACE FUNCTION public.generate_portfolio_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  code TEXT;
  exists_already BOOLEAN;
BEGIN
  LOOP
    code := 'WPF-' || LPAD(floor(random() * 10000)::int::text, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.investor_portfolios WHERE portfolio_code = code) INTO exists_already;
    EXIT WHEN NOT exists_already;
  END LOOP;
  RETURN code;
END;
$$;

-- Restrict anon policy to only allow select by activation_token
DROP POLICY IF EXISTS "Anon can select by activation_token" ON public.investor_portfolios;
CREATE POLICY "Anon can select by activation_token"
  ON public.investor_portfolios FOR SELECT TO anon
  USING (activation_token IS NOT NULL);
