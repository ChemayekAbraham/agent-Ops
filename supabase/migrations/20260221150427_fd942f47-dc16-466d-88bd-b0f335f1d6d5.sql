
-- 1. Add amount_repaid column to rent_requests
ALTER TABLE public.rent_requests ADD COLUMN IF NOT EXISTS amount_repaid numeric NOT NULL DEFAULT 0;

-- 2. Create repayments table
CREATE TABLE IF NOT EXISTS public.repayments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL,
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests(id),
  amount numeric NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.repayments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "System can insert repayments" ON public.repayments FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can view own repayments" ON public.repayments FOR SELECT USING (auth.uid() = tenant_id);
CREATE POLICY "Managers can view all repayments" ON public.repayments FOR SELECT USING (has_role(auth.uid(), 'manager'::app_role));

-- 3. Fix the record_rent_request_repayment RPC to use correct statuses and amount_repaid
CREATE OR REPLACE FUNCTION public.record_rent_request_repayment(p_tenant_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id uuid;
  v_total_repayment numeric;
  v_amount_repaid numeric;
  v_apply numeric;
BEGIN
  -- Find the tenant's active rent request (funded/disbursed/approved)
  SELECT id, total_repayment, amount_repaid INTO v_request_id, v_total_repayment, v_amount_repaid
  FROM public.rent_requests
  WHERE
    tenant_id = p_tenant_id
    AND status IN ('funded', 'disbursed', 'approved')
    AND amount_repaid < total_repayment
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_request_id IS NOT NULL THEN
    v_apply := LEAST(p_amount, v_total_repayment - v_amount_repaid);
    
    UPDATE public.rent_requests
    SET
      amount_repaid = amount_repaid + v_apply,
      status = CASE WHEN (amount_repaid + v_apply) >= total_repayment THEN 'completed' ELSE status END,
      updated_at = now()
    WHERE id = v_request_id;

    -- Record the repayment
    INSERT INTO public.repayments (tenant_id, rent_request_id, amount)
    VALUES (p_tenant_id, v_request_id, v_apply);
  END IF;
END;
$$;
