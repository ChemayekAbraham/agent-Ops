-- Create product_categories table
CREATE TABLE public.product_categories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(agent_id, name)
);

-- Enable RLS
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;

-- Agents can view their own categories
CREATE POLICY "Agents can view own categories"
ON public.product_categories
FOR SELECT
USING (auth.uid() = agent_id);

-- Anyone can view categories (for marketplace filtering)
CREATE POLICY "Anyone can view all categories"
ON public.product_categories
FOR SELECT
USING (true);

-- Agents can create categories
CREATE POLICY "Agents can create categories"
ON public.product_categories
FOR INSERT
WITH CHECK (auth.uid() = agent_id);

-- Agents can update their own categories
CREATE POLICY "Agents can update own categories"
ON public.product_categories
FOR UPDATE
USING (auth.uid() = agent_id);

-- Agents can delete their own categories
CREATE POLICY "Agents can delete own categories"
ON public.product_categories
FOR DELETE
USING (auth.uid() = agent_id);