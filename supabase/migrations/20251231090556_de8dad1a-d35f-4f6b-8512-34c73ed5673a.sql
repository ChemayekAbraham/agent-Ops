-- Allow agents to update the status of their orders
CREATE POLICY "Agents can update order status"
ON public.product_orders
FOR UPDATE
USING (auth.uid() = agent_id)
WITH CHECK (auth.uid() = agent_id);

-- Add status_updated_at column to track when status was last changed
ALTER TABLE public.product_orders 
ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- Add delivery_notes column for agents to add notes
ALTER TABLE public.product_orders 
ADD COLUMN IF NOT EXISTS delivery_notes TEXT;