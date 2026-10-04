
-- 1. Create agent_receipts table
CREATE TABLE public.agent_receipts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  payer_name TEXT NOT NULL,
  payer_phone TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  transaction_id TEXT,
  receipt_image_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Enable RLS
ALTER TABLE public.agent_receipts ENABLE ROW LEVEL SECURITY;

-- 3. Agents can insert their own receipts
CREATE POLICY "Agents can insert own receipts"
ON public.agent_receipts FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = agent_id);

-- 4. Agents can view their own receipts
CREATE POLICY "Agents can view own receipts"
ON public.agent_receipts FOR SELECT
TO authenticated
USING (auth.uid() = agent_id);

-- 5. Managers can view all receipts
CREATE POLICY "Managers can view all receipts"
ON public.agent_receipts FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'manager'::app_role));

-- 6. Create storage bucket for agent receipt images (private)
INSERT INTO storage.buckets (id, name, public) VALUES ('agent-receipts', 'agent-receipts', false);

-- 7. Agents can upload to their own folder
CREATE POLICY "Agents upload own receipt images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'agent-receipts' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 8. Agents can view their own receipt images
CREATE POLICY "Agents view own receipt images"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'agent-receipts' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 9. Managers can view all receipt images
CREATE POLICY "Managers view all receipt images"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'agent-receipts' AND public.has_role(auth.uid(), 'manager'::app_role));
